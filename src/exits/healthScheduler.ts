/**
 * Background exit health probing for 万-scale catalogs.
 *
 * Strategy (not full-pool stampede):
 * - Each tick probes at most `batchSize` exits (≈ concurrency), O(batch) work.
 * - Priority tiers: hot (currently bound) → warm (useCount>0) → cold.
 * - Per-tier min interval so cold exits are sparse; full sweep of 10k cold
 *   takes hours and that is intentional.
 * - Default probe is **liveness** via sticky SS to Amazon Q host — NOT ipify.
 *   Set EXIT_HEALTH_PROBE_URL=https://<your-gateway>/egress-echo for IP verify.
 */
import type { AccountStore } from '../accounts/store.js'
import type { ExitEntry, ExitsStore } from './store.js'
import {
  DEFAULT_LIVENESS_URL,
  isDiscouragedThirdPartyEcho,
  probeMany,
  type ExitProbeMode,
  type ProbeResult,
} from './probe.js'

export type ExitHealthTier = 'hot' | 'warm' | 'cold'

export interface ExitHealthProbeConfig {
  enabled: boolean
  /** Delay between ticks (ms). Each tick probes ≤ batchSize exits. */
  tickMs: number
  /** Max exits probed per tick. */
  batchSize: number
  /** Max in-flight probes within a tick. */
  concurrency: number
  staggerMs: number
  timeoutMs: number
  mode: ExitProbeMode
  /** Self-owned echo URL (e.g. https://gw.example/egress-echo). Empty → liveness. */
  url: string
  /** Liveness HTTPS URL when not using echo. */
  connectUrl: string
  initialDelayMs: number
  /** Min time between probes for bound exits. */
  hotMinIntervalMs: number
  /** Min time between probes for useCount>0 unbound. */
  warmMinIntervalMs: number
  /** Min time between probes for idle/never-used exits. */
  coldMinIntervalMs: number
  /**
   * @deprecated Use tickMs. Kept so old EXIT_HEALTH_PROBE_INTERVAL_MS still
   * maps to tick interval (not full-sweep period).
   */
  intervalMs?: number
}

export const DEFAULT_EXIT_HEALTH_PROBE: ExitHealthProbeConfig = {
  enabled: true,
  tickMs: 45_000,
  batchSize: 10,
  concurrency: 10,
  staggerMs: 50,
  timeoutMs: 10_000,
  mode: 'auto',
  url: '',
  connectUrl: DEFAULT_LIVENESS_URL,
  initialDelayMs: 20_000,
  hotMinIntervalMs: 5 * 60_000,
  warmMinIntervalMs: 30 * 60_000,
  coldMinIntervalMs: 6 * 60 * 60_000,
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

function envMode(fallback: ExitProbeMode): ExitProbeMode {
  const v = process.env.EXIT_HEALTH_PROBE_MODE?.trim().toLowerCase()
  if (v === 'echo' || v === 'liveness' || v === 'auto') return v
  return fallback
}

export function loadExitHealthProbeConfig(
  overrides?: Partial<ExitHealthProbeConfig>,
): ExitHealthProbeConfig {
  const base = { ...DEFAULT_EXIT_HEALTH_PROBE }
  // Legacy INTERVAL_MS → tickMs (was wrongly used as full-sweep period).
  const tickFromEnv =
    overrides?.tickMs ??
    overrides?.intervalMs ??
    envInt(
      'EXIT_HEALTH_PROBE_TICK_MS',
      envInt('EXIT_HEALTH_PROBE_INTERVAL_MS', base.tickMs),
    )
  const url = (
    overrides?.url ??
    process.env.EXIT_HEALTH_PROBE_URL?.trim() ??
    base.url
  ).trim()
  const connectUrl = (
    overrides?.connectUrl ??
    process.env.EXIT_HEALTH_PROBE_CONNECT_URL?.trim() ??
    base.connectUrl
  ).trim()

  return {
    enabled: overrides?.enabled ?? envBool('EXIT_HEALTH_PROBE_ENABLED', base.enabled),
    tickMs: Math.max(5_000, tickFromEnv),
    batchSize: Math.max(
      1,
      Math.min(
        100,
        overrides?.batchSize ??
          envInt(
            'EXIT_HEALTH_PROBE_BATCH_SIZE',
            envInt('EXIT_HEALTH_PROBE_CONCURRENCY', base.batchSize),
          ),
      ),
    ),
    concurrency: Math.max(
      1,
      Math.min(
        50,
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
    mode: overrides?.mode ?? envMode(base.mode),
    url,
    connectUrl,
    initialDelayMs: Math.max(
      0,
      overrides?.initialDelayMs ??
        envInt('EXIT_HEALTH_PROBE_INITIAL_DELAY_MS', base.initialDelayMs),
    ),
    hotMinIntervalMs: Math.max(
      30_000,
      overrides?.hotMinIntervalMs ??
        envInt('EXIT_HEALTH_PROBE_HOT_MIN_INTERVAL_MS', base.hotMinIntervalMs),
    ),
    warmMinIntervalMs: Math.max(
      60_000,
      overrides?.warmMinIntervalMs ??
        envInt('EXIT_HEALTH_PROBE_WARM_MIN_INTERVAL_MS', base.warmMinIntervalMs),
    ),
    coldMinIntervalMs: Math.max(
      60_000,
      overrides?.coldMinIntervalMs ??
        envInt('EXIT_HEALTH_PROBE_COLD_MIN_INTERVAL_MS', base.coldMinIntervalMs),
    ),
  }
}

export function estimateFullSweepMs(
  exitCount: number,
  config: Pick<ExitHealthProbeConfig, 'batchSize' | 'tickMs' | 'coldMinIntervalMs'>,
): number {
  if (exitCount <= 0) return 0
  const ticks = Math.ceil(exitCount / Math.max(1, config.batchSize))
  return Math.max(ticks * config.tickMs, config.coldMinIntervalMs)
}

export function classifyExitTier(
  exits: readonly ExitEntry[],
  boundIds: ReadonlySet<string>,
): { hot: ExitEntry[]; warm: ExitEntry[]; cold: ExitEntry[] } {
  const hot: ExitEntry[] = []
  const warm: ExitEntry[] = []
  const cold: ExitEntry[] = []
  for (const e of exits) {
    if (e.disabled) continue
    if (boundIds.has(e.id)) hot.push(e)
    else if ((e.useCount ?? 0) > 0) warm.push(e)
    else cold.push(e)
  }
  return { hot, warm, cold }
}

function lastChecked(e: ExitEntry): number {
  return e.lastCheckedAt ?? e.exitIpProbedAt ?? 0
}

function sortDueOldestFirst(list: ExitEntry[]): ExitEntry[] {
  return [...list].sort((a, b) => {
    const da = lastChecked(a)
    const db = lastChecked(b)
    if (da !== db) return da - db
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function isDue(e: ExitEntry, minIntervalMs: number, now: number): boolean {
  const t = lastChecked(e)
  if (t <= 0) return true
  return now - t >= minIntervalMs
}

/**
 * Pick next batch: hot due → warm due → cold due, each sorted oldest-checked first.
 * At most `batchSize` ids. Pure / testable.
 */
export function pickProbeBatch(
  exits: readonly ExitEntry[],
  boundIds: ReadonlySet<string>,
  config: Pick<
    ExitHealthProbeConfig,
    'batchSize' | 'hotMinIntervalMs' | 'warmMinIntervalMs' | 'coldMinIntervalMs'
  >,
  now = Date.now(),
): { ids: string[]; tierCounts: { hot: number; warm: number; cold: number } } {
  const { hot, warm, cold } = classifyExitTier(exits, boundIds)
  const dueHot = sortDueOldestFirst(hot.filter((e) => isDue(e, config.hotMinIntervalMs, now)))
  const dueWarm = sortDueOldestFirst(warm.filter((e) => isDue(e, config.warmMinIntervalMs, now)))
  const dueCold = sortDueOldestFirst(cold.filter((e) => isDue(e, config.coldMinIntervalMs, now)))
  const merged = [...dueHot, ...dueWarm, ...dueCold]
  const ids = merged.slice(0, config.batchSize).map((e) => e.id)
  const set = new Set(ids)
  return {
    ids,
    tierCounts: {
      hot: dueHot.filter((e) => set.has(e.id)).length,
      warm: dueWarm.filter((e) => set.has(e.id)).length,
      cold: dueCold.filter((e) => set.has(e.id)).length,
    },
  }
}

export function collectBoundExitIds(accounts: AccountStore | undefined): Set<string> {
  const bound = new Set<string>()
  if (!accounts) return bound
  for (const a of accounts.list()) {
    const id = a.outboundExitId?.trim()
    if (id) bound.add(id)
  }
  return bound
}

export interface ExitHealthScheduler {
  stop: () => void
  /** Run one tick (≤ batchSize exits). */
  runOnce: () => Promise<{
    probed: number
    healthy: number
    unhealthy: number
    tierCounts: { hot: number; warm: number; cold: number }
  }>
  getConfig: () => ExitHealthProbeConfig
}

let active: { timer: ReturnType<typeof setTimeout> | null; stopped: boolean } | null = null

export function startExitHealthProbeLoop(
  exits: ExitsStore,
  opts?: Partial<ExitHealthProbeConfig> & { accounts?: AccountStore },
): ExitHealthScheduler {
  const { accounts, ...cfgOverrides } = opts || {}
  const config = loadExitHealthProbeConfig(cfgOverrides)
  stopExitHealthProbeLoop()

  if (config.url && isDiscouragedThirdPartyEcho(config.url)) {
    console.warn(
      `[kiro-acc] exit-health: EXIT_HEALTH_PROBE_URL=${config.url} is a free third-party echo; ` +
        `at 万-scale this will rate-limit. Prefer https://<your-gateway>/egress-echo or leave URL empty for liveness.`,
    )
  }

  const state = { timer: null as ReturnType<typeof setTimeout> | null, stopped: false }
  active = state
  let running = false

  async function runOnce() {
    const all = exits.get().exits
    if (all.length === 0) {
      return { probed: 0, healthy: 0, unhealthy: 0, tierCounts: { hot: 0, warm: 0, cold: 0 } }
    }
    const bound = collectBoundExitIds(accounts)
    const { ids, tierCounts } = pickProbeBatch(all, bound, config)
    if (ids.length === 0) {
      return { probed: 0, healthy: 0, unhealthy: 0, tierCounts }
    }
    const results: ProbeResult[] = await probeMany(exits, ids, {
      concurrency: Math.min(config.concurrency, ids.length),
      staggerMs: config.staggerMs,
      timeoutMs: config.timeoutMs,
      url: config.url || undefined,
      mode: config.mode,
      connectUrl: config.connectUrl,
    })
    let healthy = 0
    let unhealthy = 0
    for (const r of results) {
      if (r.ok) healthy++
      else unhealthy++
    }
    const sweepH = (estimateFullSweepMs(all.length, config) / 3_600_000).toFixed(1)
    console.log(
      `[kiro-acc] exit-health tick: probed=${results.length}/${all.length} ` +
        `healthy=${healthy} unhealthy=${unhealthy} ` +
        `tiers hot=${tierCounts.hot} warm=${tierCounts.warm} cold=${tierCounts.cold} ` +
        `mode=${config.mode} batch=${config.batchSize} ~fullSweep=${sweepH}h`,
    )
    return { probed: results.length, healthy, unhealthy, tierCounts }
  }

  function schedule(delayMs: number) {
    if (state.stopped) return
    state.timer = setTimeout(() => {
      void (async () => {
        if (state.stopped) return
        if (running) {
          schedule(config.tickMs)
          return
        }
        running = true
        try {
          await runOnce()
        } catch (err) {
          console.warn(
            '[kiro-acc] exit-health tick failed:',
            err instanceof Error ? err.message : err,
          )
        } finally {
          running = false
          schedule(config.tickMs)
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
      runOnce: async () => ({
        probed: 0,
        healthy: 0,
        unhealthy: 0,
        tierCounts: { hot: 0, warm: 0, cold: 0 },
      }),
      getConfig: () => ({ ...config }),
    }
  }

  const modeDesc =
    config.mode === 'echo' || (config.mode === 'auto' && config.url)
      ? `echo url=${config.url || '(missing)'}`
      : `liveness connect=${config.connectUrl}`
  console.log(
    `[kiro-acc] exit-health probe: enabled tickMs=${config.tickMs} batch=${config.batchSize} ` +
      `concurrency=${config.concurrency} ${modeDesc} ` +
      `hot/warm/cold intervals=${config.hotMinIntervalMs}/${config.warmMinIntervalMs}/${config.coldMinIntervalMs}ms`,
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
