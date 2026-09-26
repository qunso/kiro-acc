import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import {
  assignAccountToPool,
  removeAccountHandlingExitUsage,
  shouldPreserveExitUsageOnDelete,
} from '../src/pools/rebind.js'
import { createServer } from '../src/server.js'

describe('shouldPreserveExitUsageOnDelete', () => {
  it('preserves for suspended / blocked accounts', () => {
    expect(
      shouldPreserveExitUsageOnDelete({
        id: 'a',
        label: 'a',
        accessToken: 't',
        enabled: true,
        suspended: true,
        suspendedAt: Date.now(),
      }),
    ).toBe(true)
    expect(
      shouldPreserveExitUsageOnDelete({
        id: 'a',
        label: 'a',
        accessToken: 't',
        enabled: true,
        suspendedAt: 1,
      }),
    ).toBe(true)
  })

  it('preserves for quota-exhausted accounts', () => {
    expect(
      shouldPreserveExitUsageOnDelete({
        id: 'a',
        label: 'a',
        accessToken: 't',
        enabled: true,
        quotaExhaustedAt: Date.now(),
      }),
    ).toBe(true)
    expect(
      shouldPreserveExitUsageOnDelete({
        id: 'a',
        label: 'a',
        accessToken: 't',
        enabled: true,
        quotaUsed: 100,
        quotaLimit: 100,
      }),
    ).toBe(true)
  })

  it('does not preserve after quota reset window', () => {
    expect(
      shouldPreserveExitUsageOnDelete({
        id: 'a',
        label: 'a',
        accessToken: 't',
        enabled: true,
        quotaExhaustedAt: Date.now() - 10_000,
        quotaResetAt: Date.now() - 1,
      }),
    ).toBe(false)
  })

  it('does not preserve healthy accounts', () => {
    expect(
      shouldPreserveExitUsageOnDelete({
        id: 'a',
        label: 'a',
        accessToken: 't',
        enabled: true,
      }),
    ).toBe(false)
  })
})

describe('removeAccountHandlingExitUsage', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-keep-exit-'))
    const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
    const accounts = new AccountStore(dir, config)
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
          password: 'PASS#1',
          index: 1,
        },
      ],
    })
    await pools.upsert({ id: 'p1', name: 'main', exitIds: ['e0', 'e1'] })
    return { accounts, exits, pools, config }
  }

  it('releases useCount when deleting a healthy bound account', async () => {
    const { accounts, exits, pools } = await setup()
    const acc = await accounts.create({ label: 'ok', accessToken: 'tok', enabled: true })
    const assigned = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    expect(assigned.ok).toBe(true)
    const exitId = assigned.exitId!
    expect(exits.getEntry(exitId)!.useCount).toBe(1)

    const result = await removeAccountHandlingExitUsage(acc.id, { accounts, exits })
    expect(result.ok).toBe(true)
    expect(result.releasedExitUsage).toBe(true)
    expect(result.preservedExitUsage).toBe(false)
    expect(exits.getEntry(exitId)!.useCount).toBe(0)
    expect(accounts.get(acc.id)).toBeUndefined()
  })

  it('does NOT release useCount when deleting a suspended (blocked) account', async () => {
    const { accounts, exits, pools } = await setup()
    const acc = await accounts.create({ label: 'bad', accessToken: 'tok', enabled: true })
    const assigned = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    const exitId = assigned.exitId!
    expect(exits.getEntry(exitId)!.useCount).toBe(1)

    accounts.pool.markSuspended(acc.id, 'ACCOUNT_BLOCKED', 'blocked by upstream')
    accounts.syncFromPool(acc.id)
    await accounts.flush()
    const blocked = accounts.get(acc.id)!
    expect(blocked.suspended).toBe(true)

    const result = await removeAccountHandlingExitUsage(acc.id, { accounts, exits })
    expect(result.ok).toBe(true)
    expect(result.preservedExitUsage).toBe(true)
    expect(result.releasedExitUsage).toBe(false)
    expect(exits.getEntry(exitId)!.useCount).toBe(1)
  })

  it('does NOT release useCount when deleting a quota-exhausted account', async () => {
    const { accounts, exits, pools } = await setup()
    const acc = await accounts.create({ label: 'ex', accessToken: 'tok', enabled: true })
    const assigned = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    const exitId = assigned.exitId!
    expect(exits.getEntry(exitId)!.useCount).toBe(1)

    await accounts.update(acc.id, {
      quotaUsed: 50,
      quotaLimit: 50,
      quotaExhaustedAt: Date.now(),
      quotaResetAt: Date.now() + 3_600_000,
    })

    const result = await removeAccountHandlingExitUsage(acc.id, { accounts, exits })
    expect(result.ok).toBe(true)
    expect(result.preservedExitUsage).toBe(true)
    expect(result.releasedExitUsage).toBe(false)
    expect(exits.getEntry(exitId)!.useCount).toBe(1)
  })

  it('admin DELETE preserves exit useCount for blocked accounts', async () => {
    const { accounts, exits, pools, config } = await setup()
    const acc = await accounts.create({ label: 'api', accessToken: 'tok', enabled: true })
    const assigned = await assignAccountToPool(acc, 'p1', { accounts, exits, pools })
    const exitId = assigned.exitId!
    accounts.pool.markSuspended(acc.id, 'BLOCKED')
    accounts.syncFromPool(acc.id)
    await accounts.flush()

    const app = createServer(accounts, config, exits, pools)
    const res = await app.request('/admin/accounts/' + acc.id, {
      method: 'DELETE',
      headers: { 'x-admin-token': 'adm' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.preservedExitUsage).toBe(true)
    expect(body.releasedExitUsage).toBe(false)
    expect(exits.getEntry(exitId)!.useCount).toBe(1)
  })

  it('ExitsStore.releaseUse floors at 0', async () => {
    const { exits } = await setup()
    const before = exits.getEntry('e0')!.useCount ?? 0
    expect(before).toBe(0)
    await exits.releaseUse('e0')
    expect(exits.getEntry('e0')!.useCount).toBe(0)
    await exits.bumpUse('e0')
    await exits.bumpUse('e0')
    expect(exits.getEntry('e0')!.useCount).toBe(2)
    await exits.releaseUse('e0')
    expect(exits.getEntry('e0')!.useCount).toBe(1)
  })
})
