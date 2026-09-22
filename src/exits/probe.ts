/**
 * Optional egress IP probe — NOT part of the primary assign/bind path.
 * Catalog exits should carry exitIp / SS_PASS#IP (or #index) from generation.
 * Left available for ops debugging; pools/assign do not call this.
 */
import { fetch as undiciFetch } from 'undici'
import type { ExitEntry } from './store.js'
import type { ExitsStore } from './store.js'
import { getOutboundDispatcher } from '../net/outboundDispatcher.js'

export interface ProbeResult {
  exitId: string
  ok: boolean
  exitIp?: string
  mismatch?: boolean
  error?: string
  probedAt: number
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
  if (!exit) return { exitId, ok: false, error: 'unknown exit', probedAt }
  try {
    await store.ensureProxyUrl(exitId)
    const fresh = store.getEntry(exitId)!
    const { ip } = await probeExitIp(fresh, opts)
    const expected = fresh.expectedExitIp || fresh.exitIp
    const mismatch = !!(expected && expected !== ip)
    await store.updateExitStats(exitId, {
      exitIp: ip,
      exitIpProbedAt: Date.now(),
      exitIpMismatch: mismatch || undefined,
    })
    return { exitId, ok: true, exitIp: ip, mismatch, probedAt: Date.now() }
  } catch (err) {
    return {
      exitId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      probedAt,
    }
  }
}

export async function probeMany(
  store: ExitsStore,
  exitIds: readonly string[],
  opts?: { concurrency?: number; timeoutMs?: number; url?: string },
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? 5)
  const results: ProbeResult[] = []
  let i = 0
  async function worker() {
    while (i < exitIds.length) {
      const id = exitIds[i++]!
      results.push(await probeAndUpdate(store, id, opts))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, exitIds.length) }, () => worker()))
  return results
}
