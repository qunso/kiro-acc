import type { Context } from 'hono'
import type { AccountStore } from '../accounts/store.js'
import type { AppConfig } from '../config.js'
import { classifyError, ErrorType } from '../pool/accountPool.js'
import { callKiroApi, callKiroApiStream, KiroApiError } from '../kiro/client.js'
import {
  isTokenExpiringSoon,
  refreshAccountToken,
  resolveProfileArn,
} from '../kiro/auth.js'
import { mapModelId, type KiroUsage } from '../kiro/translator.js'
import {
  ClaudeSseSession,
  claudeToKiro,
  estimateClaudeInputTokens,
  kiroToClaudeResponse,
  type ClaudeMessagesRequest,
} from '../kiro/anthropic.js'
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

export interface MessagesHandlerDeps {
  exits?: ExitsStore
  pools?: PoolsStore
}

function anthropicError(
  c: Context,
  status: number,
  type: string,
  message: string,
) {
  return c.json({ type: 'error', error: { type, message } }, status as 400)
}

async function maybeRebindAfterSuspend(
  store: AccountStore,
  accountId: string,
  deps?: MessagesHandlerDeps,
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
      console.warn(`[messages] rebind after suspend failed for ${accountId}:`, result.error)
    } else {
      console.log(
        `[messages] rebound ${accountId}: ${result.previousExitId} -> ${result.exitId} (pool ${result.poolId})`,
      )
    }
  } catch (err) {
    console.warn(
      `[messages] rebind after suspend error for ${accountId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

function parseRequest(body: unknown): { ok: true; req: ClaudeMessagesRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Invalid JSON body' }
  const req = body as ClaudeMessagesRequest
  if (!req.model || typeof req.model !== 'string') {
    return { ok: false, message: 'model is required' }
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, message: 'messages is required' }
  }
  if (typeof req.max_tokens !== 'number' || !Number.isFinite(req.max_tokens) || req.max_tokens < 1) {
    return { ok: false, message: 'max_tokens is required and must be a positive number' }
  }
  return { ok: true, req }
}

export function countTokensHandler() {
  return async (c: Context) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return anthropicError(c, 400, 'invalid_request_error', 'Invalid JSON body')
    }
    const req = (body ?? {}) as Partial<ClaudeMessagesRequest>
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      return anthropicError(c, 400, 'invalid_request_error', 'messages is required')
    }
    return c.json({ input_tokens: estimateClaudeInputTokens(req as ClaudeMessagesRequest) })
  }
}

export function messagesHandler(
  store: AccountStore,
  config: AppConfig,
  deps?: MessagesHandlerDeps,
) {
  return async (c: Context) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return anthropicError(c, 400, 'invalid_request_error', 'Invalid JSON body')
    }
    const parsed = parseRequest(raw)
    if (!parsed.ok) return anthropicError(c, 400, 'invalid_request_error', parsed.message)
    const body = parsed.req

    const maxRetries = store.getPersistedConfig().maxRetries ?? config.maxRetries
    const preferred = store.getPersistedConfig().preferredEndpoint ?? config.preferredEndpoint
    const refreshBefore =
      store.getPersistedConfig().tokenRefreshBeforeExpirySec ?? config.tokenRefreshBeforeExpirySec

    const tried = new Set<string>()
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let account = store.pool.getNextAccount(tried)
      if (!account) {
        return anthropicError(
          c,
          503,
          'api_error',
          lastError?.message || 'No available accounts in pool',
        )
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
      const payload = claudeToKiro(body, profileArn)
      const started = Date.now()

      try {
        if (body.stream) {
          return await handleClaudeStream(c, store, account.id, body, payload, preferred, started, deps)
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
          model: result.usage.modelId || mapModelId(body.model),
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          success: true,
          responseTimeMs: responseTime,
        }, { path: '/v1/messages', apiStyle: 'anthropic', status: 200 })
        return c.json(kiroToClaudeResponse(result.content, result.toolUses, result.usage, body.model))
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
          model: mapModelId(body.model),
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: lastError.message,
          responseTimeMs: Date.now() - started,
        }, { path: '/v1/messages', apiStyle: 'anthropic', status: status >= 400 && status < 600 ? status : 502 })
        tried.add(account.id)
        if (errorType === ErrorType.FATAL || attempt === maxRetries) {
          const http = status >= 400 && status < 600 ? status : 502
          return anthropicError(c, http, 'api_error', lastError.message)
        }
      }
    }

    return anthropicError(c, 502, 'api_error', lastError?.message || 'All retries exhausted')
  }
}

async function handleClaudeStream(
  c: Context,
  store: AccountStore,
  accountId: string,
  body: ClaudeMessagesRequest,
  payload: ReturnType<typeof claudeToKiro>,
  preferred: 'codewhisperer' | 'amazonq',
  started: number,
  deps?: MessagesHandlerDeps,
) {
  const account = store.pool.getAccount(accountId)
  if (!account) return anthropicError(c, 503, 'api_error', 'Account disappeared')

  const sse = new ClaudeSseSession(body.model)
  const encoder = new TextEncoder()
  let usage: KiroUsage = { inputTokens: 0, outputTokens: 0, credits: 0 }
  const estimated = Math.max(1, Math.round(JSON.stringify(payload).length / 4))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (chunk) controller.enqueue(encoder.encode(chunk))
      }
      try {
        send(sse.start(estimated))
        await callKiroApiStream(
          account,
          payload,
          (text, toolUse) => {
            if (toolUse) send(sse.tool(toolUse))
            else if (text) send(sse.text(text))
          },
          (u) => {
            usage = u
          },
          { preferredEndpoint: preferred, signal: c.req.raw.signal },
        )
        const outputTokens = usage.outputTokens || 0
        send(sse.finish({ output_tokens: outputTokens }))
        controller.close()

        const responseTime = Date.now() - started
        store.pool.recordSuccess(
          accountId,
          usage.inputTokens + usage.outputTokens,
          usage.inputTokens,
          usage.outputTokens,
          responseTime,
        )
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId,
          model: usage.modelId || mapModelId(body.model),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          success: true,
          responseTimeMs: responseTime,
        }, { path: '/v1/messages', apiStyle: 'anthropic', status: 200 })
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
        send(sse.fail(message))
        controller.close()
        await recordProxyUsage(store, {
          ...apiKeyFromContext(c),
          timestamp: Date.now(),
          accountId,
          model: usage.modelId || mapModelId(body.model),
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: message,
          responseTimeMs: Date.now() - started,
        }, { path: '/v1/messages', apiStyle: 'anthropic', status: status >= 400 && status < 600 ? status : 502 })
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
