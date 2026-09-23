import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookStore } from '../src/webhooks/store.js'
import { sendWebhookWithRetry, setGlobalWebhookStore } from '../src/webhooks/dispatch.js'
import {
  resetSignalCooldowns,
  signalAccountSuspended,
} from '../src/webhooks/signals.js'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { buildSubscriptionSummary } from '../src/admin/subscription.js'
import { createServer } from '../src/server.js'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { setCustomModelMap } from '../src/kiro/translator.js'

const dirs: string[] = []
afterEach(async () => {
  setGlobalWebhookStore(undefined)
  setCustomModelMap({})
  resetSignalCooldowns()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-wh-'))
  dirs.push(d)
  return d
}

describe('WebhookStore + dispatch', () => {
  it('persists hooks and retries failed sends', async () => {
    const dir = await tmp()
    const store = new WebhookStore(dir)
    await store.init()
    const created = await store.create({
      channel: 'generic',
      url: 'https://example.test/hook',
      label: 't',
      events: ['account_suspended'],
      maxRetries: 3,
    })
    expect(store.matching('account_suspended')).toHaveLength(1)
    expect(store.matching('refresh_failed')).toHaveLength(0)

    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts++
      if (attempts < 3) return { ok: false, status: 500, text: async () => 'err' }
      return { ok: true, status: 200, text: async () => 'ok' }
    })
    const result = await sendWebhookWithRetry(
      created,
      { event: 'account_suspended', title: 't', text: 'body', ts: Date.now() },
      fetchImpl as never,
    )
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(3)
  })

  it('formats channel payloads', async () => {
    const dir = await tmp()
    const store = new WebhookStore(dir)
    await store.init()
    const tg = await store.create({
      channel: 'telegram',
      url: 'https://api.telegram.org/botTOKEN',
      telegramChatId: '123',
      events: ['diagnose_failed'],
    })
    const seen: Array<{ url: string; body: string }> = []
    await sendWebhookWithRetry(
      tg,
      { event: 'diagnose_failed', title: 'x', text: 'y', ts: 1 },
      async (url, init) => {
        seen.push({ url, body: init.body })
        return { ok: true, status: 200, text: async () => '' }
      },
    )
    expect(seen[0]?.url).toContain('/sendMessage')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ chat_id: '123' })
  })
})

describe('subscription summary', () => {
  it('flags near-limit and disabled accounts', () => {
    const summary = buildSubscriptionSummary([
      {
        id: '1',
        label: 'a',
        accessToken: 't',
        enabled: true,
        provider: 'BuilderId',
        quotaUsed: 90,
        quotaLimit: 100,
      },
      {
        id: '2',
        label: 'b',
        accessToken: 't',
        enabled: false,
        authMethod: 'social',
        quotaUsed: 0,
        quotaLimit: 100,
      },
    ])
    expect(summary.nearLimit).toBe(1)
    expect(summary.disabled).toBe(1)
    expect(summary.rows[0]?.subscriptionType).toContain('BuilderId')
  })
})

describe('admin webhook + subscription routes', () => {
  it('CRUD webhooks and lists subscriptions', async () => {
    const dir = await tmp()
    const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
    const accounts = new AccountStore(dir, config)
    await accounts.init()
    await accounts.create({
      label: 'A',
      accessToken: 'tok',
      enabled: true,
      provider: 'Github',
      authMethod: 'social',
      quotaUsed: 5,
      quotaLimit: 10,
    })
    const apiKeys = new ApiKeyStore(dir, config.apiKey)
    await apiKeys.init()
    const modelMap = new ModelMapStore(dir)
    await modelMap.init()
    const webhooks = new WebhookStore(dir)
    await webhooks.init()
    const app = createServer(accounts, config, undefined, undefined, { apiKeys, modelMap, webhooks })
    const headers = { 'x-admin-token': 'adm', 'content-type': 'application/json' }

    const subs = await app.request('/admin/subscriptions', { headers })
    expect(subs.status).toBe(200)
    const sj = await subs.json()
    expect(sj.total).toBe(1)
    expect(sj.rows[0].subscriptionType).toContain('Github')

    const created = await app.request('/admin/webhooks', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channel: 'slack',
        url: 'https://hooks.slack.test/x',
        label: 'ops',
        events: ['account_suspended', 'refresh_failed'],
      }),
    })
    expect(created.status).toBe(201)
    const cj = await created.json()

    const listed = await app.request('/admin/webhooks', { headers })
    expect((await listed.json()).webhooks).toHaveLength(1)

    await app.request('/admin/webhooks/' + cj.id + '/disable', { method: 'POST', headers })
    expect(webhooks.get(cj.id)?.enabled).toBe(false)
  })

  it('notifies on account_suspended signal', async () => {
    const dir = await tmp()
    const store = new WebhookStore(dir)
    await store.init()
    await store.create({
      channel: 'generic',
      url: 'https://example.test/h',
      events: ['account_suspended'],
    })
    setGlobalWebhookStore(store)
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
    // monkey via notify path — signal uses global fetch; stub global fetch
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl as never
    try {
      await signalAccountSuspended('acc-1', 'TEMPORARILY_SUSPENDED', 'banned')
      expect(fetchImpl).toHaveBeenCalled()
      const body = JSON.parse((fetchImpl.mock.calls[0] as never as [string, { body: string }])[1].body)
      expect(body.event).toBe('account_suspended')
      expect(body.data.accountId).toBe('acc-1')
    } finally {
      globalThis.fetch = original
    }
  })
})
