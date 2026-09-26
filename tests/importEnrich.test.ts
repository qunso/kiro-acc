import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import { createServer } from '../src/server.js'

vi.mock('../src/kiro/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kiro/auth.js')>()
  return {
    ...actual,
    refreshAccountToken: vi.fn(async (account: { accessToken?: string; refreshToken?: string }) => ({
      success: true,
      accessToken: account.accessToken || 'access-after-refresh',
      refreshToken: account.refreshToken || 'rt',
      expiresAt: Date.now() + 3600_000,
    })),
  }
})

vi.mock('../src/kiro/usageLimits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kiro/usageLimits.js')>()
  return {
    ...actual,
    getUsageLimits: vi.fn(async () => ({
      used: 10,
      limit: 5000,
      resetAt: Date.now() + 86400_000,
      subscriptionTitle: 'KIRO PRO MAX',
      baseUsed: 10,
      baseLimit: 5000,
      trialUsed: 0,
      trialLimit: 0,
      bonusUsed: 0,
      bonusLimit: 0,
      bonusCount: 0,
      resourceType: 'CREDIT',
      raw: {},
      endpoint: 'https://q.us-east-1.amazonaws.com',
    })),
  }
})

import { refreshAccountToken } from '../src/kiro/auth.js'
import { getUsageLimits } from '../src/kiro/usageLimits.js'

const dirs: string[] = []
afterEach(async () => {
  vi.mocked(refreshAccountToken).mockClear()
  vi.mocked(getUsageLimits).mockClear()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-import-enrich-'))
  dirs.push(dir)
  const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
  const accounts = new AccountStore(dir, config)
  await accounts.init()
  const exits = new ExitsStore(dir)
  await exits.init()
  await exits.importExits({
    exits: [
      {
        id: 'ex-a',
        server: '127.0.0.1',
        port: 60001,
        method: 'aes-256-gcm',
        password: 'p#1',
        exitIp: '203.0.113.50',
      },
      {
        id: 'ex-b',
        server: '127.0.0.1',
        port: 60002,
        method: 'aes-256-gcm',
        password: 'p#2',
        exitIp: '203.0.113.51',
      },
    ],
  })
  const pools = new PoolsStore(dir)
  await pools.init()
  await pools.upsert({ id: 'default', name: 'Default', exitIds: ['ex-a', 'ex-b'] })
  const app = createServer(accounts, config, exits, pools)
  const headers = { 'x-admin-token': 'adm', 'content-type': 'application/json' }
  return { app, accounts, exits, pools, headers }
}

describe('POST /admin/accounts/import enrichment', () => {
  it('auto-binds default pool, fetches quota, returns per-account summary', async () => {
    const { app, accounts, headers } = await setup()
    const res = await app.request('/admin/accounts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accounts: [
          {
            email: 'new@example.com',
            refreshToken: 'rt-new',
            clientId: 'c',
            clientSecret: 's',
            provider: 'BuilderId',
            accessToken: 'tok-new',
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.created).toBe(1)
    expect(body.updated).toBe(0)
    expect(body.failed).toBe(0)
    expect(body.imported).toBe(1)
    expect(body.defaultPoolId).toBe('default')
    expect(body.accounts).toHaveLength(1)
    const row = body.accounts[0]
    expect(row.action).toBe('created')
    expect(row.provider).toBe('BuilderId')
    expect(row.authMethod).toBeTruthy()
    expect(row.machineId).toBeTruthy()
    expect(row.outboundPoolId).toBe('default')
    expect(['ex-a', 'ex-b']).toContain(row.outboundExitId)
    expect(row.autoBound).toBe(true)
    expect(row.unbound).toBe(false)
    expect(row.quotaFetched).toBe(true)
    expect(row.quotaUsed).toBe(10)
    expect(row.quotaLimit).toBe(5000)
    expect(row.subscriptionTitle).toBe('KIRO PRO MAX')
    expect(getUsageLimits).toHaveBeenCalled()
    expect(refreshAccountToken).toHaveBeenCalled()

    const stored = accounts.get(row.id)!
    expect(stored.outboundExitId).toBe(row.outboundExitId)
    expect(stored.quotaUsed).toBe(10)
  })

  it('does not overwrite explicit pool/exit on create', async () => {
    const { app, headers } = await setup()
    const res = await app.request('/admin/accounts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accounts: [
          {
            email: 'explicit@example.com',
            refreshToken: 'rt',
            clientId: 'c',
            clientSecret: 's',
            provider: 'BuilderId',
            accessToken: 'tok',
            outboundPoolId: 'default',
            outboundExitId: 'ex-b',
            outboundProxyUrl: 'ss://aes-256-gcm:p%232@127.0.0.1:60002',
          },
        ],
      }),
    })
    const body = await res.json()
    expect(body.accounts[0].outboundExitId).toBe('ex-b')
    expect(body.accounts[0].autoBound).toBe(false)
    expect(body.accounts[0].quotaFetched).toBe(true)
  })

  it('quota failure is warning-only; import still ok', async () => {
    vi.mocked(getUsageLimits).mockRejectedValueOnce(new Error('boom-quota'))
    const { app, headers } = await setup()
    const res = await app.request('/admin/accounts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accounts: [
          {
            email: 'qfail@example.com',
            refreshToken: 'rt',
            clientId: 'c',
            clientSecret: 's',
            provider: 'BuilderId',
            accessToken: 'tok',
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.created).toBe(1)
    expect(body.failed).toBe(0)
    expect(body.accounts[0].quotaFetched).toBe(false)
    expect(body.accounts[0].quotaError).toMatch(/boom-quota/)
    expect(body.accounts[0].autoBound).toBe(true)
  })

  it('updates existing account without re-binding exit', async () => {
    const { app, accounts, headers } = await setup()
    await accounts.create({
      id: 'acct:keep@example.com',
      label: 'keep',
      email: 'keep@example.com',
      accessToken: 'old',
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's',
      provider: 'BuilderId',
      authMethod: 'IdC',
      enabled: true,
      outboundPoolId: 'default',
      outboundExitId: 'ex-a',
      outboundProxyUrl: 'ss://aes-256-gcm:p%231@127.0.0.1:60001',
    } as any)

    const res = await app.request('/admin/accounts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'merge',
        accounts: [
          {
            id: 'acct:keep@example.com',
            email: 'keep@example.com',
            refreshToken: 'rt2',
            clientId: 'c',
            clientSecret: 's',
            provider: 'BuilderId',
            accessToken: 'new-tok',
          },
        ],
      }),
    })
    const body = await res.json()
    expect(body.updated).toBe(1)
    expect(body.created).toBe(0)
    expect(body.accounts[0].action).toBe('updated')
    expect(body.accounts[0].outboundExitId).toBe('ex-a')
    expect(body.accounts[0].autoBound).toBe(false)
  })
})
