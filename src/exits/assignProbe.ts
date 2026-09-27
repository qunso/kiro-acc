/**
 * Before binding a new account to an exit that is unknown or stale, probe once.
 * On failure mark unhealthy and try the next ranked candidate (retry budget).
 */
import type { ExitEntry, ExitsStore } from './store.js'
import { probeAndUpdate, type ProbeOpts } from './probe.js'
import { isExitEligible, rankExits, type PickExitOpts } from '../pools/select.js'

export interface AssignProbeConfig {
  enabled: boolean
  /** Treat lastChecked older than this as stale (ms). */
  staleMs: number
  /** Max probe+retry attempts when picking an exit. */
  maxAttempts: number
  probe?: ProbeOpts
}

export const DEFAULT_ASSIGN_PROBE: AssignProbeConfig = {
  enabled: true,
  staleMs: 60 * 60_000,
  maxAttempts: 5,
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  if (v === undefined || v === '') return fallback
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return fallback
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function loadAssignProbeConfig(
  overrides?: Partial<AssignProbeConfig>,
): AssignProbeConfig {
  const base = { ...DEFAULT_ASSIGN_PROBE }
  // Vitest unit tests must not hit real SS/liveness network by default.
  const underVitest = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID)
  return {
    enabled:
      overrides?.enabled ??
      envBool('EXIT_ASSIGN_PROBE_ENABLED', underVitest ? false : base.enabled),
    staleMs: Math.max(
      60_000,
      overrides?.staleMs ?? envInt('EXIT_ASSIGN_PROBE_STALE_MS', base.staleMs),
    ),
    maxAttempts: Math.max(
      1,
      Math.min(20, overrides?.maxAttempts ?? envInt('EXIT_ASSIGN_PROBE_MAX_ATTEMPTS', base.maxAttempts)),
    ),
    probe: overrides?.probe,
  }
}

export function needsAssignProbe(e: ExitEntry, staleMs: number, now = Date.now()): boolean {
  if (e.healthStatus === 'unhealthy') return false
  if (e.healthStatus === 'healthy') {
    const t = e.lastCheckedAt ?? e.exitIpProbedAt ?? 0
    if (t > 0 && now - t <= staleMs) return false
    return true // healthy but stale
  }
  // unknown / unset
  return true
}

export interface PickExitWithProbeResult {
  exit: ExitEntry
  probed: boolean
  attempts: number
}

/**
 * Rank eligible exits (healthy preferred), optionally probe unknown/stale before
 * accepting. Skips unhealthy and probe failures.
 */
export async function pickExitWithOptionalProbe(
  accountId: string,
  exits: readonly ExitEntry[],
  store: ExitsStore,
  pickOpts?: PickExitOpts,
  assignCfg?: Partial<AssignProbeConfig> & {
    /** Test / DI hook */
    probeFn?: typeof probeAndUpdate
  },
): Promise<PickExitWithProbeResult> {
  const cfg = loadAssignProbeConfig(assignCfg)
  const probeFn = assignCfg?.probeFn ?? probeAndUpdate
  const ranked = rankExits(accountId, exits, pickOpts)
  if (ranked.length === 0) throw new Error('No eligible exits in pool')

  if (!cfg.enabled) {
    return { exit: ranked[0]!, probed: false, attempts: 0 }
  }

  let attempts = 0
  const tried = new Set<string>()
  for (const candidate of ranked) {
    if (attempts >= cfg.maxAttempts) break
    if (tried.has(candidate.id)) continue
    tried.add(candidate.id)

    // Refresh from store (prior probe may have marked unhealthy)
    const live = store.getEntry(candidate.id) || candidate
    if (!isExitEligible(live, pickOpts?.now)) continue

    if (!needsAssignProbe(live, cfg.staleMs, pickOpts?.now)) {
      return { exit: live, probed: false, attempts }
    }

    attempts++
    const result = await probeFn(store, live.id, cfg.probe)
    const after = store.getEntry(live.id) || live
    if (result.ok && isExitEligible(after, pickOpts?.now)) {
      return { exit: after, probed: true, attempts }
    }
    // failed → marked unhealthy; try next
  }

  // Fall back: any still-eligible without requiring fresh probe
  const fallback = rankExits(accountId, exits.map((e) => store.getEntry(e.id) || e), pickOpts)
  if (fallback.length === 0) {
    throw new Error('No eligible exits in pool after assign probes')
  }
  return { exit: fallback[0]!, probed: false, attempts }
}
