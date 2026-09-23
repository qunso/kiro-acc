import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { setCustomModelMap } from '../src/kiro/translator.js'

const dirs: string[] = []
afterEach(async () => {
  setCustomModelMap({})
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-batch-'))
  dirs.push(dir)
  const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
  const accounts = new AccountStore(dir, config)
  await accounts.init()
  const a = await accounts.create({
    label: 'A',
    email: 'a@x.com',
    accessToken: 'tok',
    enabled: true,
    group: 'g1',
    tags: ['t1', 'prod'],
  })
  const b = await accounts.create({
    label: 'B',
    email: 'b@x.com',
    accessToken: 'tok2',
    enabled: true,
  })
  const apiKeys = new ApiKeyStore(dir, config.apiKey)
  await apiKeys.init()
  const modelMap = new ModelMapStore(dir)
  await modelMap.init()
  const app = createServer(accounts, config, undefined, undefined, { apiKeys, modelMap })
  return { app, accounts, a, b, config }
}

describe('admin accounts batch + api panel', () => {
  it('filters by group/tag and batch enable/disable/set-meta', async () => {
    const { app, a, b } = await setup()
    const headers = { 'x-admin-token': 'adm', 'content-type': 'application/json' }

    const listed = await app.request('/admin/accounts?group=g1', { headers })
    expect(listed.status).toBe(200)
    const lj = await listed.json()
    expect(lj.accounts).toHaveLength(1)
    expect(lj.groups).toContain('g1')
    expect(lj.tags).toEqual(expect.arrayContaining(['t1', 'prod']))

    const batch = await app.request('/admin/accounts/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'disable', ids: [a.id, b.id] }),
    })
    expect(batch.status).toBe(200)
    const bj = await batch.json()
    expect(bj.ok).toBe(2)

    const meta = await app.request('/admin/accounts/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'set-meta', ids: [b.id], group: 'g2', tags: ['x', 'y'] }),
    })
    expect((await meta.json()).ok).toBe(1)

    const one = await app.request('/admin/accounts/' + b.id, { headers })
    const oj = await one.json()
    expect(oj.group).toBe('g2')
    expect(oj.tags).toEqual(['x', 'y'])
    expect(oj.enabled).toBe(false)
  })

  it('supports api-key CRUD, model-map, and request-log endpoints', async () => {
    const { app } = await setup()
    const headers = { 'x-admin-token': 'adm', 'content-type': 'application/json' }

    const created = await app.request('/admin/api-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: 'ci' }),
    })
    expect(created.status).toBe(201)
    const cj = await created.json()
    expect(cj.key.key.startsWith('kk_')).toBe(true)

    const map = await app.request('/admin/model-map', {
      method: 'POST',
      headers,
      body: JSON.stringify({ openaiName: 'my-gpt', upstream: 'claude-haiku-4.5' }),
    })
    expect(map.status).toBe(200)
    expect((await map.json()).resolved).toBe('claude-haiku-4.5')

    const meta = await app.request('/admin/api-meta', { headers })
    const mj = await meta.json()
    expect(mj.endpoints.openaiChatCompletions).toContain('/v1/chat/completions')
    expect(mj.endpoints.anthropicMessages).toContain('/v1/messages')

    const log = await app.request('/admin/request-log', { headers })
    expect(log.status).toBe(200)
    expect((await log.json()).capacity).toBeGreaterThan(0)
  })
})
