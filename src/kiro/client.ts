/**
 * Kiro / CodeWhisperer / Amazon Q API client + AWS Event Stream parser.
 * Endpoint & framing patterns adapted from chaogei/Kiro-account-manager (AGPL-3.0).
 * Sends each account's stored Machine ID (机器码) in the KiroIDE User-Agent
 * suffix — matching original account managers. Does NOT do JA4/MITM / OS
 * MachineGuid forging or per-request rotation.
 */
import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { getDispatcherForAccount } from '../net/outboundDispatcher.js'
import type { AccountRecord } from '../accounts/types.js'
import {
  buildKiroAmzUserAgent,
  buildKiroUserAgent,
  resolveMachineIdForRequest,
} from '../accounts/machineId.js'
import { resolveProfileArn } from './auth.js'
import {
  toCodeWhispererModelId,
  type KiroPayload,
  type KiroToolUse,
  type KiroUsage,
} from './translator.js'
import { getKiroIdeVersion } from './ideVersion.js'

const AWS_SDK_VERSION = '1.0.34'

interface Endpoint {
  url: string
  origin: string
  name: 'CodeWhisperer' | 'AmazonQ'
}

const ENDPOINTS: Endpoint[] = [
  {
    url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR',
    name: 'CodeWhisperer',
  },
  {
    url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR',
    name: 'AmazonQ',
  },
]

export class KiroApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly reason?: string,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'KiroApiError'
  }
}

function authHeaders(account: AccountRecord): Record<string, string> {
  const machineId = resolveMachineIdForRequest(account)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amz-user-agent': buildKiroAmzUserAgent({
      kiroVersion: getKiroIdeVersion(),
      awsSdkVersion: AWS_SDK_VERSION,
      machineId,
    }),
    'user-agent': buildKiroUserAgent({
      kiroVersion: getKiroIdeVersion(),
      awsSdkVersion: AWS_SDK_VERSION,
      machineId,
    }),
    'amz-sdk-invocation-id': randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
    Authorization: `Bearer ${account.accessToken}`,
  }
  if (account.authMethod === 'external_idp' || account.provider === 'ExternalIdp') {
    headers['TokenType'] = 'EXTERNAL_IDP'
  }
  return headers
}

function sortedEndpoints(preferred: 'codewhisperer' | 'amazonq'): Endpoint[] {
  const preferredName = preferred === 'codewhisperer' ? 'CodeWhisperer' : 'AmazonQ'
  return [...ENDPOINTS].sort((a, b) => {
    if (a.name === preferredName) return -1
    if (b.name === preferredName) return 1
    return 0
  })
}

function clonePayload(payload: KiroPayload): KiroPayload {
  return JSON.parse(JSON.stringify(payload)) as KiroPayload
}

function applyOrigin(payload: KiroPayload, origin: string): void {
  const cur = payload.conversationState.currentMessage.userInputMessage
  cur.origin = origin
  for (const h of payload.conversationState.history || []) {
    if (h.userInputMessage) h.userInputMessage.origin = origin
  }
}

function applyModelId(payload: KiroPayload, modelId: string): void {
  const cur = payload.conversationState.currentMessage.userInputMessage
  cur.modelId = modelId
  for (const h of payload.conversationState.history || []) {
    if (h.userInputMessage) h.userInputMessage.modelId = modelId
  }
}

async function doFetch(
  url: string,
  init: RequestInit,
  account: AccountRecord,
): Promise<Response> {
  const dispatcher = getDispatcherForAccount(account.outboundProxyUrl)
  if (dispatcher) {
    return (await undiciFetch(url, {
      ...init,
      dispatcher,
    } as UndiciRequestInit)) as unknown as Response
  }
  return fetch(url, init)
}

function extractEventType(headers: Uint8Array): string {
  // AWS event-stream headers: [nameLen:1][name][valueType:1][valueLen:2][value]...
  let offset = 0
  while (offset < headers.length) {
    const nameLen = headers[offset]!
    offset += 1
    if (offset + nameLen > headers.length) break
    const name = new TextDecoder().decode(headers.slice(offset, offset + nameLen))
    offset += nameLen
    if (offset >= headers.length) break
    const valueType = headers[offset]!
    offset += 1
    if (valueType === 7) {
      // string
      if (offset + 2 > headers.length) break
      const valueLen = new DataView(headers.buffer, headers.byteOffset + offset, 2).getUint16(0, false)
      offset += 2
      const value = new TextDecoder().decode(headers.slice(offset, offset + valueLen))
      offset += valueLen
      if (name === ':event-type' || name === 'event-type') return value
    } else {
      // skip unknown
      break
    }
  }
  return ''
}

export type StreamChunkHandler = (
  text: string,
  toolUse?: KiroToolUse,
) => void | Promise<void>

async function parseEventStream(
  body: ReadableStream<Uint8Array>,
  onChunk: StreamChunkHandler,
  onComplete: (usage: KiroUsage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  let buffer = new Uint8Array(0)
  const usage: KiroUsage = {
    inputTokens: 0,
    outputTokens: 0,
    credits: 0,
  }
  let outputChars = 0
  let currentTool: { toolUseId: string; name: string; inputBuffer: string } | null = null
  const processed = new Set<string>()

  const abort = () => {
    reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request aborted')
      const { done, value } = await reader.read()
      if (done) break

      const next = new Uint8Array(buffer.length + value.length)
      next.set(buffer)
      next.set(value, buffer.length)
      buffer = next

      while (buffer.length >= 16) {
        const view = new DataView(buffer.buffer, buffer.byteOffset)
        const totalLength = view.getUint32(0, false)
        if (buffer.length < totalLength) break

        const headersLength = view.getUint32(4, false)
        const headersStart = 12
        const headersEnd = 12 + headersLength
        const eventType = extractEventType(buffer.slice(headersStart, headersEnd))
        const payloadStart = headersEnd
        const payloadEnd = totalLength - 4
        if (payloadStart < payloadEnd) {
          const payloadText = new TextDecoder().decode(buffer.slice(payloadStart, payloadEnd))
          try {
            const event = JSON.parse(payloadText) as Record<string, unknown>

            if (eventType === 'assistantResponseEvent' || event.assistantResponseEvent) {
              const resp = (event.assistantResponseEvent || event) as { content?: string }
              if (resp.content) {
                await onChunk(resp.content)
                outputChars += resp.content.length
              }
            }

            if (eventType === 'toolUseEvent' || event.toolUseEvent) {
              const tu = (event.toolUseEvent || event) as {
                toolUseId?: string
                name?: string
                input?: string | Record<string, unknown>
                stop?: boolean
              }
              if (tu.toolUseId && tu.name) {
                if (!currentTool || currentTool.toolUseId !== tu.toolUseId) {
                  if (currentTool && !processed.has(currentTool.toolUseId)) {
                    let input: Record<string, unknown> = {}
                    try {
                      input = currentTool.inputBuffer ? JSON.parse(currentTool.inputBuffer) : {}
                    } catch {
                      /* ignore */
                    }
                    await onChunk('', {
                      toolUseId: currentTool.toolUseId,
                      name: currentTool.name,
                      input,
                    })
                    processed.add(currentTool.toolUseId)
                  }
                  if (!processed.has(tu.toolUseId)) {
                    currentTool = { toolUseId: tu.toolUseId, name: tu.name, inputBuffer: '' }
                  } else {
                    currentTool = null
                  }
                }
              }
              if (currentTool) {
                if (typeof tu.input === 'string') currentTool.inputBuffer += tu.input
                else if (tu.input && typeof tu.input === 'object') {
                  currentTool.inputBuffer = JSON.stringify(tu.input)
                }
              }
              if (tu.stop && currentTool) {
                let input: Record<string, unknown> = {}
                try {
                  input = currentTool.inputBuffer ? JSON.parse(currentTool.inputBuffer) : {}
                } catch {
                  /* ignore */
                }
                await onChunk('', {
                  toolUseId: currentTool.toolUseId,
                  name: currentTool.name,
                  input,
                })
                processed.add(currentTool.toolUseId)
                currentTool = null
              }
            }

            // usage / metering events (various shapes)
            const metering = (event.meteringEvent ||
              event.usageEvent ||
              event.contextUsageEvent ||
              event) as Record<string, unknown>
            if (typeof metering.inputTokens === 'number') {
              usage.inputTokens = metering.inputTokens as number
            }
            if (typeof metering.outputTokens === 'number') {
              usage.outputTokens = metering.outputTokens as number
            }
            if (typeof metering.credits === 'number') {
              usage.credits = metering.credits as number
            }
            const tokenUsage = metering.tokenUsage as
              | { inputTokens?: number; outputTokens?: number }
              | undefined
            if (tokenUsage) {
              if (typeof tokenUsage.inputTokens === 'number') usage.inputTokens = tokenUsage.inputTokens
              if (typeof tokenUsage.outputTokens === 'number') usage.outputTokens = tokenUsage.outputTokens
            }

            if (eventType === 'error' || event.message === 'error' || event.reason) {
              const reason = String(event.reason || event.message || 'upstream error')
              throw new KiroApiError(reason, 400, reason, payloadText.slice(0, 500))
            }
          } catch (err) {
            if (err instanceof KiroApiError) throw err
            // ignore non-JSON frames
          }
        }

        buffer = buffer.slice(totalLength)
      }
    }

    if (currentTool && !processed.has(currentTool.toolUseId)) {
      let input: Record<string, unknown> = {}
      try {
        input = currentTool.inputBuffer ? JSON.parse(currentTool.inputBuffer) : {}
      } catch {
        /* ignore */
      }
      await onChunk('', {
        toolUseId: currentTool.toolUseId,
        name: currentTool.name,
        input,
      })
    }

    if (!usage.outputTokens && outputChars > 0) {
      usage.outputTokens = Math.max(1, Math.round(outputChars / 4))
    }
    onComplete(usage)
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export interface CallKiroOptions {
  preferredEndpoint?: 'codewhisperer' | 'amazonq'
  signal?: AbortSignal
}

export async function callKiroApiStream(
  account: AccountRecord,
  payload: KiroPayload,
  onChunk: StreamChunkHandler,
  onComplete: (usage: KiroUsage) => void,
  options: CallKiroOptions = {},
): Promise<void> {
  const endpoints = sortedEndpoints(options.preferredEndpoint || 'codewhisperer')
  const profileArn = resolveProfileArn(account)
  let lastError: Error | null = null

  for (const endpoint of endpoints) {
    try {
      const requestPayload = clonePayload(payload)
      if (profileArn) requestPayload.profileArn = profileArn
      applyOrigin(requestPayload, endpoint.origin)

      const requested =
        requestPayload.conversationState.currentMessage.userInputMessage.modelId || ''
      const sentModelId =
        endpoint.name === 'CodeWhisperer' ? toCodeWhispererModelId(requested) : requested
      if (endpoint.name === 'CodeWhisperer') {
        applyModelId(requestPayload, sentModelId)
      }

      const body = JSON.stringify(requestPayload)
      const headers = authHeaders(account)

      console.log(
        `[KiroAPI] POST ${endpoint.name} account=${account.label || account.id} model=${sentModelId}`,
      )

      const res = await doFetch(
        endpoint.url,
        { method: 'POST', headers, body, signal: options.signal },
        account,
      )

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const reason = guessReason(errBody, res.status)
        lastError = new KiroApiError(
          `Kiro ${endpoint.name} HTTP ${res.status}: ${errBody.slice(0, 400)}`,
          res.status,
          reason,
          errBody,
        )
        // try next endpoint on quota / 5xx; for auth errors also try next
        if (res.status === 402 || res.status === 429 || res.status >= 500 || res.status === 403) {
          console.warn(`[KiroAPI] ${endpoint.name} failed (${res.status}), trying next...`)
          continue
        }
        throw lastError
      }

      if (!res.body) {
        throw new KiroApiError('Empty response body from Kiro', 502)
      }

      await parseEventStream(
        res.body,
        onChunk,
        (u) => onComplete({ ...u, modelId: sentModelId }),
        options.signal,
      )
      return
    } catch (err) {
      if (options.signal?.aborted) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
      console.error(`[KiroAPI] ${endpoint.name} error:`, lastError.message)
    }
  }

  throw lastError || new KiroApiError('All Kiro endpoints failed', 502)
}

function guessReason(body: string, status: number): string | undefined {
  if (/TEMPORARILY_SUSPENDED|AccountSuspended/i.test(body)) return 'TEMPORARILY_SUSPENDED'
  if (/CONTENT_LENGTH_EXCEEDS_THRESHOLD/i.test(body)) return 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
  if (status === 402) return 'QUOTA_EXCEEDED'
  if (status === 429) return 'RATE_LIMITED'
  return undefined
}

/** Collect full non-stream response from streaming API. */
export async function callKiroApi(
  account: AccountRecord,
  payload: KiroPayload,
  options: CallKiroOptions = {},
): Promise<{ content: string; toolUses: KiroToolUse[]; usage: KiroUsage }> {
  let content = ''
  const toolUses: KiroToolUse[] = []
  let usage: KiroUsage = { inputTokens: 0, outputTokens: 0, credits: 0 }

  await callKiroApiStream(
    account,
    payload,
    (text, toolUse) => {
      if (toolUse) toolUses.push(toolUse)
      else if (text) content += text
    },
    (u) => {
      usage = u
    },
    options,
  )

  return { content, toolUses, usage }
}
