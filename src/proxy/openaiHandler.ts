import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import type { AccountStore } from '../accounts/store.js'
import type { AppConfig } from '../config.js'
import { classifyError, ErrorType } from '../pool/accountPool.js'
import {
  callKiroApi,
  callKiroApiStream,
  KiroApiError,
} from '../kiro/client.js'
import {
  isTokenExpiringSoon,
  refreshAccountToken,
  resolveProfileArn,
} from '../kiro/auth.js'
import {
  createOpenaiStreamChunk,
  kiroToOpenaiResponse,
  openaiToKiro,
  PUBLIC_MODELS,
  type OpenAIChatRequest,
  type KiroToolUse,
  type KiroUsage,
} from '../kiro/translator.js'
import { resolveRequestModel } from './resolveModel.js'
import type { ExitsStore } from '../exits/store.js'
import type { PoolsStore } from '../pools/store.js'
import { rebindAccountExitAfterBan } from '../pools/rebind.js'
import { recordProxyUsage } from './logUsage.js'
import { apiKeyFromContext } from '../middleware/auth.js'
import {
  maybeSignalAllQuotaExhausted,
  signalAccountSuspended,
  signalRefreshFailed,
} from '../webhooks/signals.js'
import {
  accountSupportsApiStyle,
  accountSupportsModel,
  isCompatUpstream,
  resolveUpstreamType,
} from '../accounts/upstream.js'
import {
  CompatUpstreamError,
  forwardOpenAiChatCompletions,
  usageFromOpenAiSseText,
} from './compatRelay.js'

export function listModelsHandler() {
  return (c: Context) =>
    c.json({
      object: 'list',
      data: PUBLIC_MODELS.map((m) => ({
        ...m,
        created: 0,
      })),
    })
}

export interface ChatHandlerDeps {
  exits?: ExitsStore
  pools?: PoolsStore
}

async function maybeRebindAfterSuspend(
  store: AccountStore,
  accountId: string,
  deps?: ChatHandlerDeps,
): Promise<void> {
  if (!deps?.exits || !deps?.pools) return
  const acc = store.get(accountId)
  if (!acc?.outboundPoolId || !acc.outboundExitId) return
  try {
    const result = await rebindAccountExitAfterBan(acc, {
      accounts: store,
      exits: deps.exits,
      pools: deps.pools,
      bumpBan: true,
    })
    if (!result.ok) {
      console.warn(`[openai] rebind after suspend failed for ${accountId}:`, result.error)
    } else {
      console.log(
        `[openai] rebound ${accountId}: ${result.previousExitId} -> ${result.exitId} (pool ${result.poolId})`,
      )
    }
  } catch (err) {
    console.warn(
      `[openai] rebind after suspend error for ${accountId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

export function chatCompletionsHandler(
  store: AccountStore,
  config: AppConfig,
  deps?: ChatHandlerDeps,
) {
  return async (c: Context) => {
    let body: OpenAIChatRequest
    try {
      body = (await c.req.json()) as OpenAIChatRequest
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
        400,
      )
    }

    if (!body?.messages?.length) {
      return c.json(
        { error: { message: 'messages is required', type: 'invalid_request_error' } },
        400,
      )
    }

    // Unified Admin Model Rewrite (custom map + builtin) — once per request.
    body = { ...body, model: resolveRequestModel(body.model) }

    const stream = Boolean(body.stream)
    const maxRetries = store.getPersistedConfig().maxRetries ?? config.maxRetries
    const preferred =
      store.getPersistedConfig().preferredEndpoint ?? config.preferredEndpoint
    const refreshBefore =
      store.getPersistedConfig().tokenRefreshBeforeExpirySec ??
      config.tokenRefreshBeforeExpirySec

    const tried = new Set<string>()
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let account = store.pool.getNextAccount(tried)
      if (!account) {
        return c.json(
          {
            error: {
              message: lastError?.message || 'No available accounts in pool',
              type: 'server_error',
              code: 'no_available_account',
            },
          },
          503,
        )
      }

      // Skip accounts that cannot serve OpenAI-style chat/completions (e.g. anthropic_compat).
      if (!accountSupportsApiStyle(account, 'openai')) {
        tried.add(account.id)
        lastError = new Error(
          `Account ${account.id} upstreamType=${resolveUpstreamType(account)} cannot serve /v1/chat/completions`,
        )
        continue
      }

      // Protocol ∩ model allowlist/cache (manual supportedModels wins; else upstreamModels).
      if (!accountSupportsModel(account, body.model)) {
        tried.add(account.id)
        lastError = new Error(
          `Account ${account.id} does not support model ${body.model || '(missing)'}`,
        )
        continue
      }

      // ---- openai_compat: relay to baseUrl (no Kiro translate / token refresh) ----
      if (isCompatUpstream(account) && resolveUpstreamType(account) === 'openai_compat') {
        const started = Date.now()
        try {
          const fwd = await forwardOpenAiChatCompletions(
            account,
            body as unknown as Record<string, unknown>,
            { signal: c.req.raw.signal },
          )
          if (stream) {
            return await handleCompatOpenAiStream(c, store, account.id, body, fwd.response, started)
          }
          const responseTime = Date.now() - started
          const usage = fwd.usage
          store.pool.recordSuccess(
            account.id,
            usage.inputTokens + usage.outputTokens,
            usage.inputTokens,
            usage.outputTokens,
            responseTime,
          )
          await recordProxyUsage(store, {
            ...apiKeyFromContext(c),
            timestamp: Date.now(),
            accountId: account.id,
            model: usage.modelId || body.model || 'unknown',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            success: true,
            responseTimeMs: responseTime,
          }, { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 })
          return c.json(fwd.json)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          const status = err instanceof CompatUpstreamError ? err.statusCode : 500
          const errorType = classifyError(status)
          store.pool.recordError(account.id, errorType, status)
          void maybeSignalAllQuotaExhausted(store)
          await recordProxyUsage(store, {
            ...apiKeyFromContext(c),
            timestamp: Date.now(),
            accountId: account.id,
            model: body.model || 'unknown',
            inputTokens: 0,
            outputTokens: 0,
            success: false,
            error: lastError.message,
            responseTimeMs: Date.now() - started,
          }, { path: '/v1/chat/completions', apiStyle: 'openai', status: status >= 400 && status < 600 ? status : 502 })
          tried.add(account.id)
          if (errorType === ErrorType.FATAL || attempt === maxRetries) {
            return c.json(
              {
                error: {
                  message: lastError.message,
                  type: 'upstream_error',
                  code: `http_${status}`,
                },
              },
              status >= 400 && status < 600 ? (status as 400) : 502,
            )
          }
          continue
        }
      }

      if (isTokenExpiringSoon(account, refreshBefore) && account.refreshToken) {
        const result = await refreshAccountToken(account)
        if (result.success && result.accessToken) {
          await store.applyTokenRefresh(account.id, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt,
          })
          account = store.pool.getAccount(account.id) || account
        } else {
          store.pool.markNeedsRefresh(account.id)
          store.pool.recordError(account.id, ErrorType.RECOVERABLE, 403)
          tried.add(account.id)
          lastError = new Error(result.error || 'Token refresh failed')
          void signalRefreshFailed(account.id, lastError.message)
          continue
        }
      }

      await store.ensureMachineId(account.id)
      account = store.get(account.id) || account
      const profileArn = resolveProfileArn(account)
      const payload = openaiToKiro(body, profileArn)
      const started = Date.now()

      try {
        if (stream) {
          return await handleStream(c, store, account.id, body, payload, preferred, started, deps)
        }

        const result = await callKiroApi(account, payload, {
          preferredEndpoint: preferred,
          signal: c.req.raw.signal,
        })

        const responseTime = Date.now() - started
        store.pool.recordSuccess(
          account.id,
          result.usage.inputTokens + result.usage.outputTokens,
          result.usage.inputTokens,
          result.usage.outputTokens,
          responseTime,
        )
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId: account.id,
          model: result.usage.modelId || body.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          success: true,
          responseTimeMs: responseTime,
        }, { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 })

        return c.json(
          kiroToOpenaiResponse(result.content, result.toolUses, result.usage, body.model),
        )
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const status = err instanceof KiroApiError ? err.statusCode : 500
        const reason = err instanceof KiroApiError ? err.reason : undefined

        if (reason === 'TEMPORARILY_SUSPENDED') {
          const newly = store.pool.markSuspended(account.id, reason, lastError.message)
          if (newly) void signalAccountSuspended(account.id, reason, lastError.message)
          await maybeRebindAfterSuspend(store, account.id, deps)
        }

        const errorType = classifyError(status, reason)
        store.pool.recordError(account.id, errorType, status)
        void maybeSignalAllQuotaExhausted(store)
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId: account.id,
          model: body.model,
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: lastError.message,
          responseTimeMs: Date.now() - started,
        }, { path: '/v1/chat/completions', apiStyle: 'openai', status: status >= 400 && status < 600 ? status : 502 })

        tried.add(account.id)

        if (errorType === ErrorType.FATAL || attempt === maxRetries) {
          return c.json(
            {
              error: {
                message: lastError.message,
                type: 'upstream_error',
                code: reason || `http_${status}`,
              },
            },
            status >= 400 && status < 600 ? (status as 400) : 502,
          )
        }
        // recoverable → retry with next account
      }
    }

    return c.json(
      {
        error: {
          message: lastError?.message || 'All retries exhausted',
          type: 'server_error',
        },
      },
      502,
    )
  }
}

async function handleStream(
  c: Context,
  store: AccountStore,
  accountId: string,
  body: OpenAIChatRequest,
  payload: ReturnType<typeof openaiToKiro>,
  preferred: 'codewhisperer' | 'amazonq',
  started: number,
  deps?: ChatHandlerDeps,
) {
  const account = store.pool.getAccount(accountId)
  if (!account) {
    return c.json({ error: { message: 'Account disappeared', type: 'server_error' } }, 503)
  }

  const id = `chatcmpl-${randomUUID()}`
  const encoder = new TextEncoder()
  let contentLen = 0
  const toolUses: KiroToolUse[] = []
  let usage: KiroUsage = { inputTokens: 0, outputTokens: 0, credits: 0 }
  let toolIndex = 0

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }

      try {
        send(createOpenaiStreamChunk(id, body.model, { role: 'assistant' }))

        await callKiroApiStream(
          account,
          payload,
          async (text, toolUse) => {
            if (toolUse) {
              toolUses.push(toolUse)
              const args = JSON.stringify(toolUse.input)
              contentLen += args.length
              send(
                createOpenaiStreamChunk(id, body.model, {
                  tool_calls: [
                    {
                      index: toolIndex++,
                      id: toolUse.toolUseId,
                      type: 'function',
                      function: {
                        name: toolUse.name,
                        arguments: args,
                      },
                    },
                  ],
                }),
              )
            } else if (text) {
              contentLen += text.length
              send(createOpenaiStreamChunk(id, body.model, { content: text }))
            }
          },
          (u) => {
            usage = u
          },
          { preferredEndpoint: preferred, signal: c.req.raw.signal },
        )

        const finish = toolUses.length > 0 ? 'tool_calls' : 'stop'
        send(
          createOpenaiStreamChunk(
            id,
            body.model,
            {},
            finish,
            {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens || Math.max(1, Math.round(contentLen / 4)),
              total_tokens:
                usage.inputTokens +
                (usage.outputTokens || Math.max(1, Math.round(contentLen / 4))),
            },
          ),
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()

        const responseTime = Date.now() - started
        // Mirror SSE finish-chunk fallback: stream often omits outputTokens
        // (especially tool-call turns); never persist 0/0 when we streamed body.
        const outTokens =
          usage.outputTokens || (contentLen > 0 ? Math.max(1, Math.round(contentLen / 4)) : 0)
        const inTokens = usage.inputTokens
        store.pool.recordSuccess(
          accountId,
          inTokens + outTokens,
          inTokens,
          outTokens,
          responseTime,
        )
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId,
          model: usage.modelId || body.model,
          inputTokens: inTokens,
          outputTokens: outTokens,
          success: true,
          responseTimeMs: responseTime,
        }, { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = err instanceof KiroApiError ? err.statusCode : 500
        const reason = err instanceof KiroApiError ? err.reason : undefined
        if (reason === 'TEMPORARILY_SUSPENDED') {
          const newly = store.pool.markSuspended(accountId, reason, message)
          if (newly) void signalAccountSuspended(accountId, reason, message)
          await maybeRebindAfterSuspend(store, accountId, deps)
        }
        store.pool.recordError(accountId, classifyError(status, reason), status)
        void maybeSignalAllQuotaExhausted(store)
        send({
          error: { message, type: 'upstream_error', code: reason || `http_${status}` },
        })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId,
          model: usage.modelId || body.model,
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: message,
          responseTimeMs: Date.now() - started,
        }, { path: '/v1/chat/completions', apiStyle: 'openai', status: status >= 400 && status < 600 ? status : 502 })
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}


/** Passthrough upstream OpenAI SSE; scrape usage from a final chunk when present. */
async function handleCompatOpenAiStream(
  c: Context,
  store: AccountStore,
  accountId: string,
  body: OpenAIChatRequest,
  upstream: Response,
  started: number,
) {
  const reader = upstream.body?.getReader()
  if (!reader) {
    return c.json({ error: { message: 'Upstream returned empty stream', type: 'upstream_error' } }, 502)
  }
  const decoder = new TextDecoder()
  let collected = ''
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            collected += decoder.decode(value, { stream: true })
            controller.enqueue(value)
          }
        }
        collected += decoder.decode()
        controller.close()
        const scraped = usageFromOpenAiSseText(collected)
        const responseTime = Date.now() - started
        const inTok = scraped?.inputTokens ?? 0
        const outTok = scraped?.outputTokens ?? 0
        store.pool.recordSuccess(accountId, inTok + outTok, inTok, outTok, responseTime)
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId,
          model: scraped?.modelId || body.model || 'unknown',
          inputTokens: inTok,
          outputTokens: outTok,
          success: true,
          responseTimeMs: responseTime,
        }, { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        store.pool.recordError(accountId, ErrorType.FATAL, 502)
        controller.error(err)
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId,
          model: body.model || 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: message,
          responseTimeMs: Date.now() - started,
        }, { path: '/v1/chat/completions', apiStyle: 'openai', status: 502 })
      }
    },
  })
  const contentType = upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8'
  return new Response(stream, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

