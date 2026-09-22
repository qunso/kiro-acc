import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore, normalizePassExitIp, normalizePassIndex } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import { assignAccountToPool, rebindAccountExitAfterBan } from '../src/pools/rebind.js'

describe('normalize password forms', () => {
  it('keeps both index and IP forms first-class', () => {
    expect(normalizePassIndex('SECRET', 17)).toBe('SECRET#17')
    expect(normalizePassIndex('SECRET#17', 99)).toBe('SECRET#17')
    expect(normalizePassExitIp('SECRET', '203.0.113.9')).toBe('SECRET#203.0.113.9')
    expect(normalizePassExitIp('SECRET#203.0.113.9', '1.2.3.4')).toBe('SECRET#203.0.113.9')
  })

  it('import auto-appends #index or #exitIp when password is bare', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-norm-'))
    try {
      const store = new ExitsStore(dir)
      await store.init()
      const result = await store.importExits({
        exits: [
          {
            id: 'idx',
            server: '1.1.1.1',
            port: 1,
            method: 'aes-256-gcm',
            password: 'P',
            index: 3,
          },
          {
            id: 'ip',
            server: '1.1.1.1',
            port: 1,
            method: 'aes-256-gcm',
            password: 'P',
            exitIp: '9.9.9.9',
          },
        ],
      })
      expect(result.exits.find((e) => e.id === 'idx')!.password).toBe('P#3')
      expect(result.exits.find((e) => e.id === 'ip')!.password).toBe('P#9.9.9.9')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('pools assign + ban rebind', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-pools-'))
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
          id: 'e0',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#0',
          index: 0,
        },
        {
          id: 'e1',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#203.0.113.1',
          exitIp: '203.0.113.1',
        },
      ],
    })
    await pools.upsert({ id: 'p1', name: 'main', exitIds: ['e0', 'e1'] })
    const acc = await accounts.create({
      label: 't',
      accessToken: 'tok',
      enabled: true,
    })
    return { accounts, exits, pools, acc }
  }

  it('assign updates account fields and bumps useCount', async () => {
    const { accounts, exits, pools, acc } = await setup()
    const result = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(result.ok).toBe(true)
    const updated = accounts.get(acc.id)!
    expect(updated.outboundPoolId).toBe('p1')
    expect(updated.outboundExitId).toBe(result.exitId)
    expect(updated.outboundProxyUrl).toMatch(/^ss:\/\//)
    const exit = exits.getEntry(result.exitId!)!
    expect(exit.useCount).toBe(1)
  })

  it('rebind after ban bumps banCount and picks another exit', async () => {
    const { accounts, exits, pools, acc } = await setup()
    const first = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(first.ok).toBe(true)
    const before = accounts.get(acc.id)!
    const reb = await rebindAccountExitAfterBan(before, {
      accounts,
      exits,
      pools,
      bumpBan: true,
      cooldownMs: 60_000,
    })
    expect(reb.ok).toBe(true)
    expect(reb.exitId).not.toBe(first.exitId)
    expect(exits.getEntry(first.exitId!)!.banCount).toBe(1)
    expect(exits.getEntry(first.exitId!)!.cooldownUntil).toBeGreaterThan(Date.now())
    const after = accounts.get(acc.id)!
    expect(after.outboundExitId).toBe(reb.exitId)
    expect(after.outboundPoolId).toBe('p1')
  })
})
