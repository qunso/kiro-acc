import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import { assignAccountToPool } from '../src/pools/rebind.js'
import { isExitEligible, rankExits } from '../src/pools/select.js'
import {
  estimateFullSweepMs,
  loadExitHealthProbeConfig,
  pickProbeBatch,
  DEFAULT_EXIT_HEALTH_PROBE,
} from '../src/exits/healthScheduler.js'
import {
  isDiscouragedThirdPartyEcho,
  parseEgressIpBody,
  resolveProbeMode,
  DEFAULT_LIVENESS_URL,
} from '../src/exits/probe.js'
import {
  loadAssignProbeConfig,
  needsAssignProbe,
  pickExitWithOptionalProbe,
} from '../src/exits/assignProbe.js'
import { ensureAccountStickyOutbound } from '../src/exits/stickyOutbound.js'

describe('exit health persistence + assign gate', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function setup() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-exit-health-'))
    const config = loadConfig()
    const accounts = new AccountStore(dir, { ...config, dataDir: dir })
    await accounts.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    await exits.importExits({
      exits: [
        {
          id: 'good',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#1',
          expectedExitIp: '203.0.113.1',
        },
        {
          id: 'bad',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#2',
          expectedExitIp: '203.0.113.2',
        },
      ],
    })
    await pools.upsert({ id: 'p1', exitIds: ['good', 'bad'] })
    const acc = await accounts.create({ label: 't', accessToken: 'tok', enabled: true })
    return { accounts, exits, pools, acc }
  }

  it('recordHealthProbe marks unhealthy and bumps consecutiveFailCount', async () => {
    const { exits } = await setup()
    const u = await exits.recordHealthProbe('bad', {
      ok: false,
      error: 'timeout',
      probedAt: 1_700_000_000_000,
    })
    expect(u.healthStatus).toBe('unhealthy')
    expect(u.lastError).toBe('timeout')
    expect(u.lastCheckedAt).toBe(1_700_000_000_000)
    expect(u.consecutiveFailCount).toBe(1)
    expect(isExitEligible(u)).toBe(false)

    const h = await exits.recordHealthProbe('good', {
      ok: true,
      exitIp: '203.0.113.1',
      probedAt: 1_700_000_000_100,
    })
    expect(h.healthStatus).toBe('healthy')
    expect(h.lastError).toBeUndefined()
    expect(h.consecutiveFailCount).toBe(0)
    expect(isExitEligible(h)).toBe(true)
  })

  it('new assign skips unhealthy exits', async () => {
    const { accounts, exits, pools, acc } = await setup()
    await exits.recordHealthProbe('bad', { ok: false, error: 'down' })
    await exits.updateExitStats('good', { useCount: 10 })
    await exits.updateExitStats('bad', { useCount: 0 })
    // Disable on-assign probe so we only test eligibility gate
    vi.stubEnv('EXIT_ASSIGN_PROBE_ENABLED', 'false')

    const result = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(result.ok).toBe(true)
    expect(result.exitId).toBe('good')
  })

  it('assign fails when all exits unhealthy', async () => {
    const { accounts, exits, pools, acc } = await setup()
    await exits.recordHealthProbe('good', { ok: false, error: 'down' })
    await exits.recordHealthProbe('bad', { ok: false, error: 'down' })
    vi.stubEnv('EXIT_ASSIGN_PROBE_ENABLED', 'false')
    const result = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No eligible exits/i)
  })

  it('prefers healthy over unknown when ranking', async () => {
    const { exits } = await setup()
    await exits.recordHealthProbe('bad', {
      ok: true,
      exitIp: '203.0.113.2',
      probedAt: Date.now(),
    })
    // good remains unknown; bad is healthy with higher useCount — healthy should win
    await exits.updateExitStats('bad', { useCount: 50 })
    await exits.updateExitStats('good', { useCount: 0 })
    const ranked = rankExits('acc', exits.get().exits)
    expect(ranked[0]!.id).toBe('bad')
  })

  it('IP mismatch via recordHealthProbe is not assignable', async () => {
    const { exits } = await setup()
    await exits.recordHealthProbe('good', {
      ok: true,
      exitIp: '198.51.100.9',
      mismatch: true,
      error: 'exit ip mismatch',
    })
    const e = exits.getEntry('good')!
    expect(e.healthStatus).toBe('unhealthy')
    expect(isExitEligible(e)).toBe(false)
  })
})

describe('sharded probe batching', () => {
  function exit(partial: Record<string, unknown> & { id: string }) {
    return {
      useCount: 0,
      banCount: 0,
      outboundProxyUrl: 'socks5h://127.0.0.1:9',
      ...partial,
    } as never
  }

  it('pickProbeBatch caps at batchSize and prefers hot due first', () => {
    const now = 1_000_000_000_000
    const exits = [
      exit({ id: 'cold-old', lastCheckedAt: 0 }),
      exit({ id: 'hot-due', lastCheckedAt: now - 600_000 }),
      exit({ id: 'hot-fresh', lastCheckedAt: now - 1_000 }),
      exit({ id: 'warm-due', useCount: 2, lastCheckedAt: now - 3_600_000 }),
    ]
    const bound = new Set(['hot-due', 'hot-fresh'])
    const batch = pickProbeBatch(
      exits,
      bound,
      {
        batchSize: 2,
        hotMinIntervalMs: 300_000,
        warmMinIntervalMs: 1_800_000,
        coldMinIntervalMs: 21_600_000,
      },
      now,
    )
    expect(batch.ids).toHaveLength(2)
    expect(batch.ids[0]).toBe('hot-due')
    expect(batch.tierCounts.hot).toBeGreaterThanOrEqual(1)
    expect(batch.ids).not.toContain('hot-fresh')
  })

  it('estimateFullSweepMs for 10k is multi-hour', () => {
    const ms = estimateFullSweepMs(10_000, {
      batchSize: 10,
      tickMs: 45_000,
      coldMinIntervalMs: 21_600_000,
    })
    // 1000 ticks * 45s = 45000s ≈ 12.5h
    expect(ms).toBe(10_000 / 10 * 45_000)
    expect(ms / 3_600_000).toBeGreaterThan(10)
  })
})

describe('probe mode + echo parsing (no ipify default)', () => {
  it('auto mode is liveness when URL empty', () => {
    expect(resolveProbeMode({})).toBe('liveness')
    expect(resolveProbeMode({ url: '' })).toBe('liveness')
    expect(resolveProbeMode({ url: 'https://gw.example/egress-echo' })).toBe('echo')
    expect(DEFAULT_LIVENESS_URL).toContain('q.us-east-1.amazonaws.com')
  })

  it('parses JSON and plain IP bodies', () => {
    expect(parseEgressIpBody('203.0.113.9')).toBe('203.0.113.9')
    expect(parseEgressIpBody('{"ok":true,"ip":"198.51.100.1"}')).toBe('198.51.100.1')
  })

  it('flags discouraged third-party echoes', () => {
    expect(isDiscouragedThirdPartyEcho('https://api.ipify.org')).toBe(true)
    expect(isDiscouragedThirdPartyEcho('https://gw.example/egress-echo')).toBe(false)
  })

  it('scheduler defaults are 万-scale friendly (no ipify URL)', () => {
    const keys = [
      'EXIT_HEALTH_PROBE_ENABLED',
      'EXIT_HEALTH_PROBE_TICK_MS',
      'EXIT_HEALTH_PROBE_INTERVAL_MS',
      'EXIT_HEALTH_PROBE_CONCURRENCY',
      'EXIT_HEALTH_PROBE_BATCH_SIZE',
      'EXIT_HEALTH_PROBE_URL',
      'EXIT_HEALTH_PROBE_MODE',
    ] as const
    const saved: Record<string, string | undefined> = {}
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    try {
      const d = loadExitHealthProbeConfig()
      expect(d.enabled).toBe(true)
      expect(d.tickMs).toBe(45_000)
      expect(d.batchSize).toBe(10)
      expect(d.concurrency).toBe(10)
      expect(d.url).toBe('')
      expect(d.mode).toBe('auto')
      expect(d.connectUrl).toBe(DEFAULT_LIVENESS_URL)
      expect(d.coldMinIntervalMs).toBe(DEFAULT_EXIT_HEALTH_PROBE.coldMinIntervalMs)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })
})

describe('on-assign probe', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
    delete process.env.EXIT_ASSIGN_PROBE_ENABLED
  })

  it('needsAssignProbe true for unknown/stale', () => {
    expect(needsAssignProbe({ id: 'a' } as never, 3600_000)).toBe(true)
    expect(
      needsAssignProbe(
        { id: 'a', healthStatus: 'healthy', lastCheckedAt: Date.now() } as never,
        3600_000,
      ),
    ).toBe(false)
    expect(
      needsAssignProbe(
        {
          id: 'a',
          healthStatus: 'healthy',
          lastCheckedAt: Date.now() - 7200_000,
        } as never,
        3600_000,
      ),
    ).toBe(true)
  })

  it('pickExitWithOptionalProbe probes unknown and skips failures', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-assign-probe-'))
    const exits = new ExitsStore(dir)
    await exits.init()
    await exits.importExits({
      exits: [
        {
          id: 'fail',
          server: '10.0.0.1',
          port: 1,
          method: 'aes-256-gcm',
          password: 'P#1',
          useCount: 0,
        },
        {
          id: 'ok',
          server: '10.0.0.1',
          port: 1,
          method: 'aes-256-gcm',
          password: 'P#2',
          useCount: 1,
        },
      ],
    })
    // fail has lower useCount → ranked first; probe fails then ok succeeds
    const probeFn = async (_s: typeof exits, id: string) => {
      if (id === 'fail') {
        await exits.recordHealthProbe(id, { ok: false, error: 'nope' })
        return {
          exitId: id,
          ok: false,
          mode: 'liveness' as const,
          error: 'nope',
          probedAt: Date.now(),
          healthStatus: 'unhealthy' as const,
        }
      }
      await exits.recordHealthProbe(id, { ok: true, probedAt: Date.now() })
      return {
        exitId: id,
        ok: true,
        mode: 'liveness' as const,
        probedAt: Date.now(),
        healthStatus: 'healthy' as const,
      }
    }

    const picked = await pickExitWithOptionalProbe(
      'acc',
      exits.get().exits,
      exits,
      {},
      { enabled: true, staleMs: 3600_000, maxAttempts: 5, probeFn: probeFn as never },
    )
    expect(picked.exit.id).toBe('ok')
    expect(picked.probed).toBe(true)
    expect(picked.attempts).toBeGreaterThanOrEqual(1)
    expect(exits.getEntry('fail')!.healthStatus).toBe('unhealthy')
  })

  it('loadAssignProbeConfig defaults', () => {
    delete process.env.EXIT_ASSIGN_PROBE_ENABLED
    // Under vitest, default is false to avoid network; override explicitly.
    const c = loadAssignProbeConfig({ enabled: true })
    expect(c.enabled).toBe(true)
    expect(c.maxAttempts).toBe(5)
    expect(loadAssignProbeConfig().enabled).toBe(false)
  })
})

describe('ensureAccountStickyOutbound', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
    delete process.env.ALL_PROXY
  })

  it('prefers bound exit URL over env ALL_PROXY', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-sticky-'))
    const config = loadConfig()
    const accounts = new AccountStore(dir, { ...config, dataDir: dir })
    await accounts.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    await exits.importExits({
      exits: [
        {
          id: 'e1',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#9',
        },
      ],
    })
    const acc = await accounts.create({
      label: 't',
      accessToken: 'tok',
      enabled: true,
      outboundExitId: 'e1',
    })
    process.env.ALL_PROXY = 'socks5h://127.0.0.1:19999'

    const sticky = await ensureAccountStickyOutbound(acc, { accounts, exits })
    expect(sticky.source).toBe('exit')
    expect(sticky.proxyUrl).toMatch(/^ss:\/\//)
    expect(sticky.proxyUrl).not.toContain('19999')
  })
})
