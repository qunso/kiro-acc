/**
 * Background exit egress-IP health probing.
 * Bounded concurrency + staggered starts to avoid stampeding large catalogs.
 * Unhealthy exits are skipped for NEW account assignment only (see isExitEligible).
 */
import type { ExitsStore } from './store.js'
import { probeMany } from './probe.js'

export interface ExitHealthProbeConfig {
  enabled: boolean
  /** Full sweep interval between cycles (ms). */
  intervalMs: number
  /** Max in-flight probes. */
  concurrency: number
  /** Delay between starting probe i and i+1 within a sweep (ms). */
  staggerMs: number
  timeoutMs: number
  url: string
  /** Delay before the first sweep after process start (ms). */
  initialDelayMs: number
}

export const DEFAULT_EXIT_HEALTH_PROBE: ExitHealthProbeConfig = {
  enabled: true,
  intervalMs: 5 * 60_000,
  concurrency: 3,
  staggerMs: 400,
  timeoutMs: 15_000,
  url: 'https://api.ipify.org',
  initialDelayMs: 15_000,
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

export function loadExitHealthProbeConfig(
  overrides?: Partial<ExitHealthProbeConfig>,
): ExitHealthProbeConfig {
  const base = { ...DEFAULT_EXIT_HEALTH_PROBE }
  return {
    enabled: overrides?.enabled ?? envBool('EXIT_HEALTH_PROBE_ENABLED', base.enabled),
    intervalMs: Math.max(
      30_000,
      overrides?.intervalMs ?? envInt('EXIT_HEALTH_PROBE_INTERVAL_MS', base.intervalMs),
    ),
    concurrency: Math.max(
      1,
      Math.min(
        16,
        overrides?.concurrency ?? envInt('EXIT_HEALTH_PROBE_CONCURRENCY', base.concurrency),
      ),
    ),
    staggerMs: Math.max(
      0,
      overrides?.staggerMs ?? envInt('EXIT_HEALTH_PROBE_STAGGER_MS', base.staggerMs),
    ),
    timeoutMs: Math.max(
      3_000,
      overrides?.timeoutMs ?? envInt('EXIT_HEALTH_PROBE_TIMEOUT_MS', base.timeoutMs),
    ),
    url: (overrides?.url ?? (process.env.EXIT_HEALTH_PROBE_URL?.trim() || base.url)).trim(),
    initialDelayMs: Math.max(
      0,
      overrides?.initialDelayMs ??
        envInt('EXIT_HEALTH_PROBE_INITIAL_DELAY_MS', base.initialDelayMs),
    ),
  }
}

export interface ExitHealthScheduler {
  stop: () => void
  /** Run one sweep immediately (also used by tests). */
  runOnce: () => Promise<{ probed: number; healthy: number; unhealthy: number }>
  getConfig: () => ExitHealthProbeConfig
}

let active: { timer: ReturnType<typeof setTimeout> | null; stopped: boolean } | null = null

export function startExitHealthProbeLoop(
  exits: ExitsStore,
  opts?: Partial<ExitHealthProbeConfig>,
): ExitHealthScheduler {
  const config = loadExitHealthProbeConfig(opts)
  stopExitHealthProbeLoop()

  const state = { timer: null as ReturnType<typeof setTimeout> | null, stopped: false }
  active = state
  let running = false

  async function runOnce(): Promise<{ probed: number; healthy: number; unhealthy: number }> {
    const ids = exits.listIds()
    if (ids.length === 0) return { probed: 0, healthy: 0, unhealthy: 0 }
    const results = await probeMany(exits, ids, {
      concurrency: config.concurrency,
      staggerMs: config.staggerMs,
      timeoutMs: config.timeoutMs,
      url: config.url,
    })
    let healthy = 0
    let unhealthy = 0
    for (const r of results) {
      if (r.ok) healthy++
      else unhealthy++
    }
    console.log(
      `[kiro-acc] exit-health probe: ${results.length} exits · healthy=${healthy} unhealthy=${unhealthy} concurrency=${config.concurrency} staggerMs=${config.staggerMs}`,
    )
    return { probed: results.length, healthy, unhealthy }
  }

  function schedule(delayMs: number) {
    if (state.stopped) return
    state.timer = setTimeout(() => {
      void (async () => {
        if (state.stopped) return
        if (running) {
          schedule(config.intervalMs)
          return
        }
        running = true
        try {
          await runOnce()
        } catch (err) {
          console.warn(
            '[kiro-acc] exit-health probe cycle failed:',
            err instanceof Error ? err.message : err,
          )
        } finally {
          running = false
          schedule(config.intervalMs)
        }
      })()
    }, delayMs)
    if (typeof state.timer === 'object' && state.timer && 'unref' in state.timer) {
      state.timer.unref()
    }
  }

  if (!config.enabled) {
    console.log('[kiro-acc] exit-health probe: disabled')
    return {
      stop: () => {
        state.stopped = true
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
      },
      runOnce: async () => ({ probed: 0, healthy: 0, unhealthy: 0 }),
      getConfig: () => ({ ...config }),
    }
  }

  console.log(
    `[kiro-acc] exit-health probe: enabled intervalMs=${config.intervalMs} concurrency=${config.concurrency} staggerMs=${config.staggerMs} initialDelayMs=${config.initialDelayMs}`,
  )
  schedule(config.initialDelayMs)

  return {
    stop: () => {
      state.stopped = true
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      if (active === state) active = null
    },
    runOnce,
    getConfig: () => ({ ...config }),
  }
}

export function stopExitHealthProbeLoop(): void {
  if (!active) return
  active.stopped = true
  if (active.timer) clearTimeout(active.timer)
  active.timer = null
  active = null
}
