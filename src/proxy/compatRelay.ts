/**
 * Forward OpenAI / Anthropic-compatible requests to an upstream baseUrl + API key.
 * Reuses the account's sticky outbound dispatcher (proxy / SS / SOCKS).
 */
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { AccountRecord } from '../accounts/types.js'
import {
  applyModelPrefix,
  joinCompatUrl,
  resolveUpstreamType,
} from '../accounts/upstream.js'
import { getDispatcherForAccount } from '../net/outboundDispatcher.js'

export class CompatUpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'CompatUpstreamError'
  }
}

async function accountFetch(
  account: AccountRecord,
  url: string,
  init: RequestInit,
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

function mergeHeaders(
  account: AccountRecord,
  base: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...base }
  const extra = account.defaultHeaders
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v == null) continue
      const key = String(k).trim()
      if (!key) continue
      out[key] = String(v)
    }
  }
  return out
}

function openaiAuthHeaders(account: AccountRecord): Record<string, string> {
  const key = (account.upstreamApiKey || '').trim()
  return mergeHeaders(account, {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  })
}

function anthropicAuthHeaders(account: AccountRecord): Record<string, string> {
  const key = (account.upstreamApiKey || '').trim()
  const base: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': key,
  }
  // Only set default version if operator did not override via defaultHeaders
  const merged = mergeHeaders(account, base)
  if (!Object.keys(merged).some((k) => k.toLowerCase() === 'anthropic-version')) {
    merged['anthropic-version'] = '2023-06-01'
  }
  return merged
}

function withPrefixedModel<T extends { model?: string }>(
  body: T,
  account: AccountRecord,
): T {
  const nextModel = applyModelPrefix(body.model, account.modelPrefix)
  if (nextModel === body.model) return body
  return { ...body, model: nextModel }
}

export interface CompatUsage {
  inputTokens: number
  outputTokens: number
  modelId?: string
}

/** Pull usage from OpenAI or Anthropic JSON bodies when present. */
export function extractCompatUsage(body: unknown, fallbackModel?: string): CompatUsage {
  const empty: CompatUsage = { inputTokens: 0, outputTokens: 0, modelId: fallbackModel }
  if (!body || typeof body !== 'object') return empty
  const obj = body as Record<string, unknown>
  const usage = (obj.usage && typeof obj.usage === 'object' ? obj.usage : null) as Record<
    string,
    unknown
  > | null
  if (!usage) {
    return {
      ...empty,
      modelId: typeof obj.model === 'string' ? obj.model : fallbackModel,
    }
  }
  const asNum = (v: unknown): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return 0
  }
  // OpenAI: prompt_tokens / completion_tokens
  // Anthropic: input_tokens / output_tokens
  const inputTokens =
    asNum(usage.prompt_tokens) ||
    asNum(usage.input_tokens) ||
    asNum(usage.inputTokens) ||
    0
  const outputTokens =
    asNum(usage.completion_tokens) ||
    asNum(usage.output_tokens) ||
    asNum(usage.outputTokens) ||
    0
  return {
    inputTokens,
    outputTokens,
    modelId: typeof obj.model === 'string' ? obj.model : fallbackModel,
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `Upstream HTTP ${res.status}`
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const err = j.error
    if (typeof err === 'string') return err
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      if (typeof e.message === 'string') return e.message
    }
    if (typeof j.message === 'string') return j.message
  } catch {
    /* plain text */
  }
  return text.slice(0, 500)
}

export interface CompatForwardResult {
  status: number
  headers: Headers
  /** Non-stream JSON body when parsed; null for stream / opaque. */
  json: unknown | null
  /** Raw Response for streaming passthrough. */
  response: Response
  usage: CompatUsage
}

/**
 * POST OpenAI-compatible chat/completions to the account baseUrl.
 * Returns the upstream Response (caller may stream or parse JSON).
 */
export async function forwardOpenAiChatCompletions(
  account: AccountRecord,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<CompatForwardResult> {
  if (resolveUpstreamType(account) !== 'openai_compat') {
    throw new Error('account is not openai_compat')
  }
  const baseUrl = (account.baseUrl || '').trim()
  if (!baseUrl) throw new Error('account.baseUrl is required')
  if (!(account.upstreamApiKey || '').trim()) throw new Error('account.upstreamApiKey is required')

  const url = joinCompatUrl(baseUrl, '/v1/chat/completions')
  const payload = withPrefixedModel(body, account)
  const res = await accountFetch(account, url, {
    method: 'POST',
    headers: openaiAuthHeaders(account),
    body: JSON.stringify(payload),
    signal: opts.signal,
  })

  if (!res.ok) {
    const msg = await readErrorMessage(res)
    throw new CompatUpstreamError(msg, res.status, msg)
  }

  const stream = Boolean(payload.stream)
  if (stream) {
    return {
      status: res.status,
      headers: res.headers,
      json: null,
      response: res,
      usage: { inputTokens: 0, outputTokens: 0, modelId: String(payload.model || '') || undefined },
    }
  }

  const json = await res.json()
  return {
    status: res.status,
    headers: res.headers,
    json,
    response: res,
    usage: extractCompatUsage(json, String(payload.model || '') || undefined),
  }
}

/**
 * POST Anthropic-compatible /v1/messages to the account baseUrl.
 */
export async function forwardAnthropicMessages(
  account: AccountRecord,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<CompatForwardResult> {
  if (resolveUpstreamType(account) !== 'anthropic_compat') {
    throw new Error('account is not anthropic_compat')
  }
  const baseUrl = (account.baseUrl || '').trim()
  if (!baseUrl) throw new Error('account.baseUrl is required')
  if (!(account.upstreamApiKey || '').trim()) throw new Error('account.upstreamApiKey is required')

  const url = joinCompatUrl(baseUrl, '/v1/messages')
  const payload = withPrefixedModel(body, account)
  const res = await accountFetch(account, url, {
    method: 'POST',
    headers: anthropicAuthHeaders(account),
    body: JSON.stringify(payload),
    signal: opts.signal,
  })

  if (!res.ok) {
    const msg = await readErrorMessage(res)
    throw new CompatUpstreamError(msg, res.status, msg)
  }

  const stream = Boolean(payload.stream)
  if (stream) {
    return {
      status: res.status,
      headers: res.headers,
      json: null,
      response: res,
      usage: { inputTokens: 0, outputTokens: 0, modelId: String(payload.model || '') || undefined },
    }
  }

  const json = await res.json()
  return {
    status: res.status,
    headers: res.headers,
    json,
    response: res,
    usage: extractCompatUsage(json, String(payload.model || '') || undefined),
  }
}

/** Best-effort: scrape OpenAI SSE stream for a final usage chunk (optional). */
export function usageFromOpenAiSseText(text: string): CompatUsage | null {
  let last: CompatUsage | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const obj = JSON.parse(data) as Record<string, unknown>
      if (obj.usage && typeof obj.usage === 'object') {
        last = extractCompatUsage(obj)
      }
    } catch {
      /* ignore */
    }
  }
  return last
}


function parseModelsPayload(body: unknown): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: unknown) => {
    const s = String(id ?? '').trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    ids.push(s)
  }
  if (!body || typeof body !== 'object') return ids
  const obj = body as Record<string, unknown>
  const data = obj.data
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object' && 'id' in item) {
        push((item as { id: unknown }).id)
      }
    }
    return ids
  }
  if (Array.isArray(obj.models)) {
    for (const item of obj.models) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object' && 'id' in item) {
        push((item as { id: unknown }).id)
      }
    }
  }
  return ids
}

/**
 * Best-effort GET upstream model catalog.
 * Tries `{baseUrl}/v1/models` (OpenAI + Anthropic shape) then `{baseUrl}/models`.
 */
export async function fetchUpstreamModels(
  account: AccountRecord,
  opts: { signal?: AbortSignal } = {},
): Promise<{ models: string[]; url: string }> {
  const t = resolveUpstreamType(account)
  if (t !== 'openai_compat' && t !== 'anthropic_compat') {
    throw new Error('fetchUpstreamModels requires a compat upstream account')
  }
  const headers =
    t === 'anthropic_compat' ? anthropicAuthHeaders(account) : openaiAuthHeaders(account)
  // Drop content-type for GET
  const getHeaders = { ...headers }
  delete getHeaders['content-type']
  delete getHeaders['Content-Type']

  const candidates = [
    joinCompatUrl(account.baseUrl || '', '/v1/models'),
    joinCompatUrl(account.baseUrl || '', '/models'),
  ]
  // Dedupe identical URLs
  const urls = [...new Set(candidates)]
  let lastErr: Error | null = null
  for (const url of urls) {
    try {
      const res = await accountFetch(account, url, {
        method: 'GET',
        headers: getHeaders,
        signal: opts.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        lastErr = new CompatUpstreamError(
          `upstream models ${res.status}: ${text.slice(0, 400)}`,
          res.status,
          text,
        )
        if (res.status === 404 || res.status === 405) continue
        throw lastErr
      }
      let json: unknown
      try {
        json = JSON.parse(text) as unknown
      } catch {
        throw new CompatUpstreamError('upstream models returned non-JSON', res.status, text)
      }
      const models = parseModelsPayload(json)
      return { models, url }
    } catch (err) {
      if (err instanceof CompatUpstreamError && (err.statusCode === 404 || err.statusCode === 405)) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr || new Error('failed to fetch upstream models')
}

