import { randomUUID } from 'node:crypto'

export type ApiStyle = 'openai' | 'anthropic'

export interface RequestLogEntry {
  id: string
  ts: number
  method: string
  path: string
  apiStyle: ApiStyle
  model?: string
  accountId?: string
  accountLabel?: string
  apiKeyId?: string
  apiKeyLabel?: string
  exitId?: string
  exitIp?: string
  status: number
  success: boolean
  latencyMs: number
  error?: string
  /** Prompt / input tokens when known (best-effort on abort). */
  inputTokens?: number
  /** Completion / output tokens when known (best-effort on abort). */
  outputTokens?: number
}

const DEFAULT_CAP = 500

export class RequestLog {
  private entries: RequestLogEntry[] = []
  constructor(private cap = DEFAULT_CAP) {}

  push(partial: Omit<RequestLogEntry, 'id' | 'ts'> & { ts?: number; id?: string }): RequestLogEntry {
    const entry: RequestLogEntry = {
      id: partial.id || randomUUID(),
      ts: partial.ts ?? Date.now(),
      method: partial.method,
      path: partial.path,
      apiStyle: partial.apiStyle,
      model: partial.model,
      accountId: partial.accountId,
      accountLabel: partial.accountLabel,
      apiKeyId: partial.apiKeyId,
      apiKeyLabel: partial.apiKeyLabel,
      exitId: partial.exitId,
      exitIp: partial.exitIp,
      status: partial.status,
      success: partial.success,
      latencyMs: partial.latencyMs,
      error: partial.error ? String(partial.error).slice(0, 400) : undefined,
      inputTokens: partial.inputTokens,
      outputTokens: partial.outputTokens,
    }
    this.entries.push(entry)
    if (this.entries.length > this.cap) {
      this.entries = this.entries.slice(-this.cap)
    }
    return entry
  }

  list(opts: {
    q?: string
    path?: string
    apiStyle?: string
    apiKey?: string
    limit?: number
    /** Only entries with ts strictly greater than this (ms). */
    since?: number
    /** Only entries newer than this id (by ring order). Newest-first list truncates before the id. */
    afterId?: string
  } = {}): RequestLogEntry[] {
    const q = (opts.q || '').trim().toLowerCase()
    const pathF = (opts.path || '').trim().toLowerCase()
    const style = (opts.apiStyle || '').trim().toLowerCase()
    const apiKeyF = (opts.apiKey || '').trim().toLowerCase()
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), this.cap)
    let list = this.entries.slice().reverse()
    if (opts.afterId) {
      const idx = list.findIndex((e) => e.id === opts.afterId)
      if (idx >= 0) list = list.slice(0, idx)
      else {
        // Unknown id (rotated out / cleared) → empty incremental; caller should full-refresh
        list = []
      }
    }
    if (opts.since != null && Number.isFinite(opts.since)) {
      const since = Number(opts.since)
      list = list.filter((e) => e.ts > since)
    }
    if (pathF) list = list.filter((e) => e.path.toLowerCase().includes(pathF))
    if (style) list = list.filter((e) => e.apiStyle === style)
    if (apiKeyF) {
      list = list.filter(
        (e) =>
          (e.apiKeyId || '').toLowerCase().includes(apiKeyF) ||
          (e.apiKeyLabel || '').toLowerCase().includes(apiKeyF),
      )
    }
    if (q) {
      list = list.filter((e) =>
        JSON.stringify({
          model: e.model,
          accountId: e.accountId,
          accountLabel: e.accountLabel,
          apiKeyId: e.apiKeyId,
          apiKeyLabel: e.apiKeyLabel,
          exitId: e.exitId,
          exitIp: e.exitIp,
          error: e.error,
          path: e.path,
          status: e.status,
        })
          .toLowerCase()
          .includes(q),
      )
    }
    return list.slice(0, limit)
  }

  clear(): void {
    this.entries = []
  }

  get size(): number {
    return this.entries.length
  }

  get capacity(): number {
    return this.cap
  }

  /** Resize ring buffer (keeps newest entries). Cap clamped to [50, 5000]. */
  setCapacity(n: number): number {
    const next = Math.max(50, Math.min(5000, Math.floor(Number(n) || DEFAULT_CAP)))
    this.cap = next
    if (this.entries.length > next) {
      this.entries = this.entries.slice(-next)
    }
    return next
  }
}

/** Process-wide ring buffer used by proxy handlers + admin UI. */
export const globalRequestLog = new RequestLog(500)


/** Detect client disconnect / AbortSignal during streaming. */
export function isClientAbort(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'Request aborted') return true
  if (/\bAbortError\b/i.test(msg)) return true
  return false
}

/** Shared SSE response headers — disable nginx/OpenResty proxy buffering. */
export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}
