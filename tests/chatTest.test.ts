import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { loadConfig } from '../src/config.js'
import { setCustomModelMap } from '../src/kiro/translator.js'

vi.mock('../src/kiro/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kiro/client.js')>()
  return {
    ...actual,
    callKiroApi: vi.fn(async () => ({
      content: 'pong from mock',
      toolUses: [],
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        credits: 1,
        modelId: 'claude-haiku-4.5',
      },
    })),
  }
})

import { callKiroApi } from '../src/kiro/client.js'
import { createServer } from '../src/server.js'

const dirs: string[] = []
afterEach(async () => {
  setCustomModelMap({})
  vi.mocked(callKiroApi).mockClear()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-chat-'))
  dirs.push(dir)
  const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
  const accounts = new AccountStore(dir, config)
  await accounts.init()
  const a = await accounts.create({
    label: 'ChatAcc',
    email: 'chat@x.com',
    accessToken: 'tok-live',
    enabled: true,
    expiresAt: Date.now() + 3600_000,
    quotaUsed: 10,
    quotaLimit: 100,
  })
  const apiKeys = new ApiKeyStore(dir, config.apiKey)
  await apiKeys.init()
  const modelMap = new ModelMapStore(dir)
  await modelMap.init()
  const app = createServer(accounts, config, undefined, undefined, { apiKeys, modelMap })
  return { app, accounts, a, config }
}

describe('admin chat-test', () => {
  it('lists public models', async () => {
    const { app } = await setup()
    const headers = { 'x-admin-token': 'adm' }
    const res = await app.request('/admin/chat-models', { headers })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.models).toEqual(expect.arrayContaining(['claude-haiku-4.5', 'claude-opus-5']))
  })

  it('validates body and pins account through callKiroApi', async () => {
    const { app, a } = await setup()
    const headers = { 'x-admin-token': 'adm', 'content-type': 'application/json' }

    const missing = await app.request('/admin/chat-test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-haiku-4.5', message: 'hi' }),
    })
    expect(missing.status).toBe(400)

    const noMsg = await app.request('/admin/chat-test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ accountId: a.id, model: 'claude-haiku-4.5' }),
    })
    expect(noMsg.status).toBe(400)

    const missingAcc = await app.request('/admin/chat-test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ accountId: 'nope', model: 'claude-haiku-4.5', message: 'hi' }),
    })
    expect(missingAcc.status).toBe(404)

    const ok = await app.request('/admin/chat-test', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountId: a.id,
        model: 'claude-haiku-4.5',
        message: 'ping',
      }),
    })
    expect(ok.status).toBe(200)
    const oj = await ok.json()
    expect(oj.ok).toBe(true)
    expect(oj.text).toBe('pong from mock')
    expect(oj.accountId).toBe(a.id)
    expect(oj.model).toBe('claude-haiku-4.5')
    expect(typeof oj.latencyMs).toBe('number')
    expect(callKiroApi).toHaveBeenCalledTimes(1)
    const [accArg, payload] = vi.mocked(callKiroApi).mock.calls[0]!
    expect(accArg.id).toBe(a.id)
    expect(payload.conversationState).toBeTruthy()
  })
})
