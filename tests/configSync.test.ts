import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNoSecretsInBundle,
  buildConfigSyncBundle,
  parseConfigSyncBundle,
} from '../src/admin/configSync.js'
import { AccountStore } from '../src/accounts/store.js'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { PoolsStore } from '../src/pools/store.js'
import { WebhookStore } from '../src/webhooks/store.js'
import { OpsSettingsStore } from '../src/admin/opsSettings.js'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { setCustomModelMap } from '../src/kiro/translator.js'
import { setGlobalWebhookStore } from '../src/webhooks/dispatch.js'
import { globalRequestLog } from '../src/proxy/requestLog.js'

const dirs: string[] = []
afterEach(async () => {
  setCustomModelMap({})
  setGlobalWebhookStore(undefined)
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-sync-'))
  dirs.push(d)
  return d
}

describe('configSync helpers', () => {
  it('round-trips export parse and redacts webhook secrets', () => {
    const bundle = buildConfigSyncBundle({
      poolConfig: { accountStrategy: 'sticky', maxRetries: 2 },
      pools: [{ id: 'p1', exitIds: ['e1', 'e2'], name: 'main' }],
      modelMap: { 'gpt-x': 'claude-haiku-4.5' },
      webhooks: [
        {
          id: 'w1',
          label: 'ops',
          channel: 'dingtalk',
          url: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
          enabled: true,
          events: ['account_suspended'],
          secret: 'super-secret',
          createdAt: 1,
        },
      ],
      exitFailThreshold: 4,
      apiKeys: [
        { id: 'k1', label: 'ci', createdAt: 1, active: true },
      ],
      opsSettings: { requestLogCapacity: 200, uiPrefs: { defaultTab: 'home' } },
    })
    expect(bundle.kind).toBe('kiro-acc-ops-config')
    expect(bundle.webhooks?.[0]?.secretRedacted).toBe(true)
    expect(JSON.stringify(bundle)).not.toContain('super-secret')
    expect(assertNoSecretsInBundle(bundle)).toEqual([])

    const parsed = parseConfigSyncBundle(JSON.parse(JSON.stringify(bundle)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.bundle.pools?.[0]?.exitIds).toEqual(['e1', 'e2'])
      expect(parsed.bundle.modelMap?.['gpt-x']).toBe('claude-haiku-4.5')
      expect(parsed.bundle.opsSettings?.requestLogCapacity).toBe(200)
    }
  })

  it('rejects unknown kind / future version', () => {
    expect(parseConfigSyncBundle({ kind: 'other' }).ok).toBe(false)
    expect(parseConfigSyncBundle({ kind: 'kiro-acc-ops-config', version: 99 }).ok).toBe(false)
  })
})

describe('admin dashboard + config-sync + settings', () => {
  it('exports, imports with confirm, and updates settings', async () => {
    const dir = await tmp()
    const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
    const accounts = new AccountStore(dir, config)
    await accounts.init()
    await accounts.create({ label: 'A', accessToken: 'tok', enabled: true })

    const pools = new PoolsStore(dir)
    await pools.init()
    await pools.upsert({ id: 'pool-a', exitIds: ['x1'], name: 'A' })

    const apiKeys = new ApiKeyStore(dir, config.apiKey)
    await apiKeys.init()
    await apiKeys.create('lab')

    const modelMap = new ModelMapStore(dir)
    await modelMap.init()
    await modelMap.upsert('my-model', 'claude-sonnet-4.5')

    const webhooks = new WebhookStore(dir)
    await webhooks.init()
    await webhooks.create({
      channel: 'generic',
      url: 'https://example.test/hook',
      label: 'g',
      events: ['refresh_failed'],
      secret: 'keep-me',
    })

    const opsSettings = new OpsSettingsStore(dir)
    await opsSettings.init()
    await opsSettings.patch({ requestLogCapacity: 150 })
    globalRequestLog.setCapacity(150)

    const app = createServer(accounts, config, undefined, pools, {
      apiKeys,
      modelMap,
      webhooks,
      opsSettings,
    })
    const headers = { 'x-admin-token': 'adm', 'content-type': 'application/json' }

    const dash = await app.request('/admin/dashboard', { headers })
    expect(dash.status).toBe(200)
    const dj = await dash.json()
    expect(dj.accounts.total).toBe(1)
    expect(dj.shortcuts.length).toBeGreaterThan(0)

    const exp = await app.request('/admin/config-sync/export', { headers })
    expect(exp.status).toBe(200)
    const ej = await exp.json()
    expect(ej.bundle.pools[0].id).toBe('pool-a')
    expect(JSON.stringify(ej.bundle)).not.toMatch(/accessToken|refreshToken|"password"/)
    expect(JSON.stringify(ej.bundle)).not.toContain('keep-me')
    // api key raw secret not present
    expect(JSON.stringify(ej.bundle.apiKeys)).not.toMatch(/kk_/)

    const noConfirm = await app.request('/admin/config-sync/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ bundle: ej.bundle }),
    })
    expect(noConfirm.status).toBe(400)

    // mutate then import back
    await pools.upsert({ id: 'pool-b', exitIds: ['y1'] })
    await modelMap.set({})
    const imp = await app.request('/admin/config-sync/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ bundle: ej.bundle, confirm: true }),
    })
    expect(imp.status).toBe(200)
    expect(modelMap.get()['my-model']).toBe('claude-sonnet-4.5')
    expect(pools.list().some((p) => p.id === 'pool-a')).toBe(true)

    const set = await app.request('/admin/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        poolConfig: { accountStrategy: 'sticky', maxRetries: 5 },
        opsSettings: { requestLogCapacity: 250 },
        exitFailThreshold: 7,
      }),
    })
    expect(set.status).toBe(200)
    expect(globalRequestLog.capacity).toBe(250)
    expect(webhooks.getExitFailThreshold()).toBe(7)
    expect(accounts.getPersistedConfig().accountStrategy).toBe('sticky')

    const about = await app.request('/admin/about', { headers })
    expect(about.status).toBe(200)
    const aj = await about.json()
    expect(aj.version).toBeTruthy()
    expect(aj.name).toBe('kiro-acc')
  })
})
