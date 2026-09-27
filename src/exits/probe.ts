/**
 * Egress IP probe through each exit's sticky outbound (same SS path as chat).
 * Used by ops manual probe + periodic health scheduler.
 * Assignment skips exits marked unhealthy after failed probes.
 */
import { fetch as undiciFetch } from 'undici'
import type { ExitEntry } from './store.js'
import type { ExitsStore } from './store.js'
import { getOutboundDispatcher } from '../net/outboundDispatcher.js'
import { maybeSignalExitConsecutiveFailures } from '../webhooks/signals.js'

export interface ProbeResult {
  exitId: string
  ok: boolean
  exitIp?: string
  mismatch?: boolean
  error?: string
  probedAt: number
  healthStatus?: 'healthy' | 'unhealthy'
  consecutiveFailCount?: number
}

export async function probeExitIp(
  exit: ExitEntry,
  opts?: { timeoutMs?: number; url?: string },
): Promise<{ ip: string; probedAt: number }> {
  const url = opts?.url ?? 'https://api.ipify.org'
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const proxyUrl = exit.outboundProxyUrl
  if (!proxyUrl) throw new Error(`Exit ${exit.id} has no outboundProxyUrl`)
  const dispatcher = getOutboundDispatcher(proxyUrl)
  if (!dispatcher) throw new Error(`Exit ${exit.id}: could not build outbound dispatcher`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, { dispatcher, signal: ac.signal } as never)
    if (!res.ok) throw new Error(`probe HTTP ${res.status}`)
    const text = (await res.text()).trim()
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text) && !text.includes(':')) {
      throw new Error(`unexpected probe body: ${text.slice(0, 80)}`)
    }
    return { ip: text, probedAt: Date.now() }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeAndUpdate(
  store: ExitsStore,
  exitId: string,
  opts?: { timeoutMs?: number; url?: string },
): Promise<ProbeResult> {
  const probedAt = Date.now()
  const exit = store.getEntry(exitId)
  if (!exit) return { exitId, ok: false, error: 'unknown exit', probedAt, healthStatus: 'unhealthy' }
  try {
    await store.ensureProxyUrl(exitId)
    const fresh = store.getEntry(exitId)!
    const { ip } = await probeExitIp(fresh, opts)
    const expected = fresh.expectedExitIp || fresh.exitIp
    // Only treat as mismatch when catalog expected IP is set (not the last probed IP alone).
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
      exitIp: ip,
      mismatch,
      error: mismatch ? `exit ip mismatch: expected ${expected}, got ${ip}` : undefined,
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
        error,
        probedAt,
        healthStatus: 'unhealthy',
        consecutiveFailCount: updated.consecutiveFailCount,
      }
    } catch {
      return { exitId, ok: false, error, probedAt, healthStatus: 'unhealthy' }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Probe many exits with bounded concurrency and optional stagger between starts
 * (avoids stampeding when the catalog is large).
 */
export async function probeMany(
  store: ExitsStore,
  exitIds: readonly string[],
  opts?: {
    concurrency?: number
    timeoutMs?: number
    url?: string
    /** Delay between starting each probe (ms). Default 0. */
    staggerMs?: number
  },
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 3)
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
      const id = exitIds[i]!
      results[i] = await probeAndUpdate(store, id, opts)
    }
  }

  const n = Math.min(concurrency, exitIds.length)
  if (n <= 0) return []
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}
