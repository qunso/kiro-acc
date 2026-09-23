import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeAccountImport, splitCredentialLine } from '../src/accounts/importNormalize.js'
import { AccountStore } from '../src/accounts/store.js'
import { isTokenExpiringSoon } from '../src/kiro/auth.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import { createServer } from '../src/server.js'
import type { AppConfig } from '../src/config.js'

describe('normalizeAccountImport', () => {
  it('accepts OIDC JSON, nested credentials, and card-key lines', () => {
    const oidc = normalizeAccountImport({
      refreshToken: 'rt-1',
      clientId: 'cid',
      clientSecret: 'sec',
      provider: 'BuilderId',
      email: 'A@Example.com',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    expect(oidc.accounts).toHaveLength(1)
    expect(oidc.accounts[0]).toMatchObject({
      id: 'acct:a@example.com',
      authMethod: 'IdC',
      provider: 'BuilderId',
      refreshToken: 'rt-1',
      clientId: 'cid',
    })
    expect(oidc.accounts[0]?.expiresAt).toBe(Date.parse('2030-01-01T00:00:00.000Z'))
    expect(oidc.accounts[0]?.accessToken).toBe('')

    const nested = normalizeAccountImport({
      mode: 'replace',
      accounts: [
        {
          email: 'g@example.com',
          credentials: {
            refreshToken: 'social-rt',
            provider: 'Github',
          },
        },
      ],
    })
    expect(nested.mode).toBe('replace')
    expect(nested.accounts[0]).toMatchObject({
      id: 'acct:g@example.com',
      authMethod: 'social',
      provider: 'Github',
      refreshToken: 'social-rt',
    })

    expect(splitCredentialLine('a----b----c----d----e----Google')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'Google',
    ])
    const cards = normalizeAccountImport({
      text: '# comment\na@x.com----secret----rt-card---- ---- ----Google\n',
    })
    expect(cards.accounts[0]).toMatchObject({
      email: 'a@x.com',
      refreshToken: 'rt-card',
      authMethod: 'social',
      provider: 'Google',
    })
    expect(cards.accounts[0]).not.toHaveProperty('password')

    const roundTrip = normalizeAccountImport({
      accounts: [
        {
          id: 'keep-me',
          email: 'k@example.com',
          accessToken: 'tok',
          outboundProxyUrl: 'http://127.0.0.1:18080',
          outboundPoolId: 'pool-a',
          outboundExitId: 'ss1-0',
        },
      ],
    })
    expect(roundTrip.accounts[0]).toMatchObject({
      id: 'keep-me',
      outboundProxyUrl: 'http://127.0.0.1:18080',
      outboundPoolId: 'pool-a',
      outboundExitId: 'ss1-0',
    })
  })

  it('treats a refresh-only account as needing a token refresh', () => {
    expect(
      isTokenExpiringSoon(
        { id: 'a', label: 'a', accessToken: '', refreshToken: 'rt', enabled: true },
        300,
      ),
    ).toBe(true)
    expect(
      isTokenExpiringSoon(
        { id: 'b', label: 'b', accessToken: 'tok', enabled: true },
        300,
      ),
    ).toBe(false)
  })
})

describe('admin account bind + import', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('imports OIDC JSON and shows the assigned exit after pool bind', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-admin-'))
    const base = loadConfig()
    const config: AppConfig = { ...base, dataDir: dir, apiKey: 'test-key', adminToken: 'test-admin' }
    const accounts = new AccountStore(dir, config)
    await accounts.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    await exits.importExits({
      exits: [
        {
          id: 'ss1-0',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#0',
          exitIp: '203.0.113.10',
        },
        {
          id: 'ss1-1',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'PASS#1',
          exitIp: '203.0.113.11',
        },
      ],
    })
    const app = createServer(accounts, config, exits, pools)
    const headers = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' }

    const imported = await app.request('/admin/accounts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accounts: [{ email: 'a@example.com', refreshToken: 'rt', clientId: 'c', clientSecret: 's', provider: 'BuilderId' }],
      }),
    })
    expect(imported.status).toBe(200)
    const importedBody = (await imported.json()) as { imported: number }
    expect(importedBody.imported).toBe(1)

    await app.request('/admin/pools', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'pool-a', name: 'main', exitIds: ['ss1-0', 'ss1-1'] }),
    })

    const bound = await app.request(
      '/admin/accounts/' + encodeURIComponent('acct:a@example.com') + '/bind-pool',
      {
      method: 'POST',
      headers,
      body: JSON.stringify({ poolId: 'pool-a' }),
    })
    expect(bound.status).toBe(200)
    const boundBody = (await bound.json()) as {
      assignedExit: { exitId: string; exitIp: string | null; poolId: string }
    }
    expect(boundBody.assignedExit.poolId).toBe('pool-a')
    expect(['ss1-0', 'ss1-1']).toContain(boundBody.assignedExit.exitId)
    expect(boundBody.assignedExit.exitIp).toMatch(/^203\.0\.113\.1/)

    const listed = await app.request('/admin/accounts', { headers })
    const listBody = (await listed.json()) as {
      accounts: Array<{ assignedExit: { exitId: string; exitIp: string | null } | null }>
    }
    expect(listBody.accounts[0]?.assignedExit?.exitId).toBe(boundBody.assignedExit.exitId)
    expect(listBody.accounts[0]?.assignedExit?.exitIp).toBe(boundBody.assignedExit.exitIp)

    const probe = await app.request('/admin/tls-probe', {
      method: 'POST',
      headers,
      body: JSON.stringify({ accountId: 'missing', compareDirect: false }),
    })
    expect(probe.status).toBe(404)

    const badUrl = await app.request('/admin/tls-probe', {
      method: 'POST',
      headers,
      body: JSON.stringify({ compareDirect: false, url: 'http://example.com' }),
    })
    expect(badUrl.status).toBe(400)
  })
})
