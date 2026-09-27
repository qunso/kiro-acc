import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import { assignAccountToPool } from '../src/pools/rebind.js'
import { isExitEligible } from '../src/pools/select.js'
import { loadExitHealthProbeConfig } from '../src/exits/healthScheduler.js'
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
    // Make "good" less preferred by useCount so sticky would otherwise pick bad if eligible
    await exits.updateExitStats('good', { useCount: 10 })
    await exits.updateExitStats('bad', { useCount: 0 })

    const result = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(result.ok).toBe(true)
    expect(result.exitId).toBe('good')
  })

  it('assign fails when all exits unhealthy', async () => {
    const { accounts, exits, pools, acc } = await setup()
    await exits.recordHealthProbe('good', { ok: false, error: 'down' })
    await exits.recordHealthProbe('bad', { ok: false, error: 'down' })
    const result = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No eligible exits/i)
  })

  it('IP mismatch via recordHealthProbe is not assignable', async () => {
    const { exits } = await setup()
    await exits.recordHealthProbe('good', {
      ok: true,
      exitIp: '198.51.100.9',
      mismatch: true,
      error: 'exit ip mismatch: expected 203.0.113.1, got 198.51.100.9',
    })
    const e = exits.getEntry('good')!
    expect(e.healthStatus).toBe('unhealthy')
    expect(e.exitIpMismatch).toBe(true)
    expect(isExitEligible(e)).toBe(false)
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
      // Missing outboundProxyUrl — historically fell through to ALL_PROXY
    })
    process.env.ALL_PROXY = 'socks5h://127.0.0.1:19999'

    const sticky = await ensureAccountStickyOutbound(acc, { accounts, exits })
    expect(sticky.source).toBe('exit')
    expect(sticky.proxyUrl).toMatch(/^ss:\/\//)
    expect(sticky.proxyUrl).not.toContain('19999')
    expect(sticky.synced).toBe(true)
    expect(accounts.get(acc.id)!.outboundProxyUrl).toBe(sticky.proxyUrl)
  })
})

describe('exit health scheduler config', () => {
  const keys = [
    'EXIT_HEALTH_PROBE_ENABLED',
    'EXIT_HEALTH_PROBE_INTERVAL_MS',
    'EXIT_HEALTH_PROBE_CONCURRENCY',
    'EXIT_HEALTH_PROBE_STAGGER_MS',
  ] as const
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('loads conservative defaults and env overrides', () => {
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    const d = loadExitHealthProbeConfig()
    expect(d.enabled).toBe(true)
    expect(d.concurrency).toBe(3)
    expect(d.intervalMs).toBe(300_000)
    expect(d.staggerMs).toBe(400)

    process.env.EXIT_HEALTH_PROBE_ENABLED = 'false'
    process.env.EXIT_HEALTH_PROBE_CONCURRENCY = '5'
    process.env.EXIT_HEALTH_PROBE_INTERVAL_MS = '120000'
    process.env.EXIT_HEALTH_PROBE_STAGGER_MS = '250'
    const c = loadExitHealthProbeConfig()
    expect(c.enabled).toBe(false)
    expect(c.concurrency).toBe(5)
    expect(c.intervalMs).toBe(120_000)
    expect(c.staggerMs).toBe(250)
  })
})
