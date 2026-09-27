/**
 * Exit health probe through each exit's sticky outbound (same SS path as chat).
 *
 * Modes:
 * - echo: HTTP GET EXIT_HEALTH_PROBE_URL (self-owned /egress-echo) → observe egress IP
 * - liveness: HTTPS fetch through exit to a stable host we already talk to (Amazon Q).
 *   Proves SS path works; does not compare egress IP.
 *
 * Default is liveness — NOT a third-party free IP echo (ipify etc.). Those buckle
 * under 万-scale scheduled probes and are opt-in only via EXIT_HEALTH_PROBE_URL.
 */
import { fetch as undiciFetch } from 'undici'
import type { ExitEntry } from './store.js'
import type { ExitsStore } from './store.js'
import { getOutboundDispatcher } from '../net/outboundDispatcher.js'
import { maybeSignalExitConsecutiveFailures } from '../webhooks/signals.js'

/** Default liveness target — same region host as Kiro Amazon Q traffic. */
export const DEFAULT_LIVENESS_URL = 'https://q.us-east-1.amazonaws.com/'

export type ExitProbeMode = 'auto' | 'echo' | 'liveness'

export interface ProbeResult {
  exitId: string
  ok: boolean
  mode: 'echo' | 'liveness'
  exitIp?: string
  mismatch?: boolean
  error?: string
  probedAt: number
  healthStatus?: 'healthy' | 'unhealthy'
  consecutiveFailCount?: number
}

export interface ProbeOpts {
  timeoutMs?: number
  /** Echo URL (self-owned). Empty → liveness when mode=auto. */
  url?: string
  mode?: ExitProbeMode
  /** Liveness HTTPS URL when not using echo. */
  connectUrl?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Detect free third-party echo hosts (discouraged for mass scheduled probes). */
export function isDiscouragedThirdPartyEcho(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'api.ipify.org' ||
      host === 'ipify.org' ||
      host.endsWith('.ipify.org') ||
      host === 'ifconfig.me' ||
      host === 'icanhazip.com' ||
      host === 'ip.sb' ||
      host === 'checkip.amazonaws.com'
    )
  } catch {
    return false
  }
}

export function resolveProbeMode(opts?: ProbeOpts): 'echo' | 'liveness' {
  const mode = opts?.mode ?? 'auto'
  const url = opts?.url?.trim() || ''
  if (mode === 'echo') return 'echo'
  if (mode === 'liveness') return 'liveness'
  return url ? 'echo' : 'liveness'
}

/** Parse plain-text IP or JSON `{ ip: "..." }` from self-owned / third-party echo. */
export function parseEgressIpBody(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty probe body')
  if (trimmed.startsWith('{')) {
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      throw new Error(`probe JSON parse failed: ${trimmed.slice(0, 80)}`)
    }
    if (json && typeof json === 'object') {
      const rec = json as Record<string, unknown>
      const ip = rec.ip ?? rec.origin ?? rec.query
      if (typeof ip === 'string' && ip.trim()) return ip.trim()
    }
    throw new Error(`probe JSON missing ip: ${trimmed.slice(0, 80)}`)
  }
  const line = trimmed.split(/\s|\n/)[0]!.trim()
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(line) && !line.includes(':')) {
    throw new Error(`unexpected probe body: ${line.slice(0, 80)}`)
  }
  return line
}

export async function probeExitIp(
  exit: ExitEntry,
  opts?: { timeoutMs?: number; url?: string },
): Promise<{ ip: string; probedAt: number }> {
  const url = opts?.url
  if (!url?.trim()) {
    throw new Error(
      'echo probe requires url (set EXIT_HEALTH_PROBE_URL to https://<gateway>/egress-echo)',
    )
  }
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const proxyUrl = exit.outboundProxyUrl
  if (!proxyUrl) throw new Error(`Exit ${exit.id} has no outboundProxyUrl`)
  const dispatcher = getOutboundDispatcher(proxyUrl)
  if (!dispatcher) throw new Error(`Exit ${exit.id}: could not build outbound dispatcher`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, {
      dispatcher,
      signal: ac.signal,
      headers: { accept: 'application/json, text/plain, */*' },
    } as never)
    if (!res.ok) throw new Error(`probe HTTP ${res.status}`)
    const text = await res.text()
    return { ip: parseEgressIpBody(text), probedAt: Date.now() }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Liveness: HTTPS request through the sticky exit to a stable host.
 * Any HTTP response (incl. 4xx) proves the SS path + TLS work. No egress IP.
 */
export async function probeExitLiveness(
  exit: ExitEntry,
  opts?: { timeoutMs?: number; connectUrl?: string },
): Promise<{ probedAt: number }> {
  const connectUrl = (opts?.connectUrl || DEFAULT_LIVENESS_URL).trim()
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const proxyUrl = exit.outboundProxyUrl
  if (!proxyUrl) throw new Error(`Exit ${exit.id} has no outboundProxyUrl`)
  const dispatcher = getOutboundDispatcher(proxyUrl)
  if (!dispatcher) throw new Error(`Exit ${exit.id}: could not build outbound dispatcher`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await undiciFetch(connectUrl, {
      method: 'GET',
      dispatcher,
      signal: ac.signal,
      headers: { accept: '*/*' },
    } as never)
    await res.arrayBuffer().catch(() => undefined)
    return { probedAt: Date.now() }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeAndUpdate(
  store: ExitsStore,
  exitId: string,
  opts?: ProbeOpts,
): Promise<ProbeResult> {
  const probedAt = Date.now()
  const mode = resolveProbeMode(opts)
  const exit = store.getEntry(exitId)
  if (!exit) {
    return { exitId, ok: false, mode, error: 'unknown exit', probedAt, healthStatus: 'unhealthy' }
  }
  try {
    await store.ensureProxyUrl(exitId)
    const fresh = store.getEntry(exitId)!

    if (mode === 'liveness') {
      await probeExitLiveness(fresh, {
        timeoutMs: opts?.timeoutMs,
        connectUrl: opts?.connectUrl,
      })
      const updated = await store.recordHealthProbe(exitId, {
        ok: true,
        probedAt: Date.now(),
      })
      return {
        exitId,
        ok: true,
        mode,
        probedAt: Date.now(),
        healthStatus: 'healthy',
        consecutiveFailCount: updated.consecutiveFailCount,
      }
    }

    const echoUrl = opts?.url?.trim()
    if (!echoUrl) {
      throw new Error('echo mode requires EXIT_HEALTH_PROBE_URL (self-owned /egress-echo)')
    }
    const { ip } = await probeExitIp(fresh, { timeoutMs: opts?.timeoutMs, url: echoUrl })
    const expectedFixed = fresh.expectedExitIp
    const mismatch = !!(expectedFixed && expectedFixed !== ip)
    const updated = await store.recordHealthProbe(exitId, {
      ok: true,
      exitIp: ip,
      mismatch,
      probedAt: Date.now(),
      error: mismatch ? `exit ip mismatch: expected ${expectedFixed}, got ${ip}` : undefined,
    })
    if (mismatch) void maybeSignalExitConsecutiveFailures(store, exitId)
    return {
      exitId,
      ok: !mismatch,
      mode,
      exitIp: ip,
      mismatch,
      error: mismatch ? `exit ip mismatch: expected ${expectedFixed}, got ${ip}` : undefined,
      probedAt: Date.now(),
      healthStatus: updated.healthStatus === 'healthy' ? 'healthy' : 'unhealthy',
      consecutiveFailCount: updated.consecutiveFailCount,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try {
      const updated = await store.recordHealthProbe(exitId, {
        ok: false,
        error,
        probedAt,
      })
      void maybeSignalExitConsecutiveFailures(store, exitId)
      return {
        exitId,
        ok: false,
        mode,
        error,
        probedAt,
        healthStatus: 'unhealthy',
        consecutiveFailCount: updated.consecutiveFailCount,
      }
    } catch {
      return { exitId, ok: false, mode, error, probedAt, healthStatus: 'unhealthy' }
    }
  }
}

/**
 * Probe many exits with bounded concurrency and optional stagger.
 * For 万-scale, callers must pass a small batch — not the full catalog.
 */
export async function probeMany(
  store: ExitsStore,
  exitIds: readonly string[],
  opts?: ProbeOpts & { concurrency?: number; staggerMs?: number },
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 10)
  const staggerMs = Math.max(0, opts?.staggerMs ?? 0)
  const results: ProbeResult[] = new Array(exitIds.length)
  let next = 0
  const t0 = Date.now()

  async function worker() {
    while (true) {
      const i = next++
      if (i >= exitIds.length) return
      if (staggerMs > 0) {
        const wait = t0 + i * staggerMs - Date.now()
        if (wait > 0) await sleep(wait)
      }
      results[i] = await probeAndUpdate(store, exitIds[i]!, opts)
    }
  }

  const n = Math.min(concurrency, exitIds.length)
  if (n <= 0) return []
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}
