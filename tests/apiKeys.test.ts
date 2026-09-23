import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { apiKeyAuth } from '../src/middleware/auth.js'
import { Hono } from 'hono'
import type { AppConfig } from '../src/config.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-apikeys-'))
  dirs.push(d)
  return d
}

describe('ApiKeyStore', () => {
  it('creates, lists masked, validates, and revokes keys', async () => {
    const dir = await tmpDir()
    const store = new ApiKeyStore(dir, 'env-secret')
    await store.init()
    const created = await store.create('ops')
    expect(created.key.startsWith('kk_')).toBe(true)
    expect(store.isValidKey(created.key)).toBe(true)
    expect(store.isValidKey('env-secret')).toBe(true)
    expect(store.isValidKey('nope')).toBe(false)

    const listed = store.listPublic()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.masked).toContain('…')
    expect((listed[0] as { key?: string }).key).toBeUndefined()

    await store.revoke(created.id)
    expect(store.isValidKey(created.key)).toBe(false)
    expect(store.isValidKey('env-secret')).toBe(true)
  })

  it('wires into apiKeyAuth middleware', async () => {
    const dir = await tmpDir()
    const keys = new ApiKeyStore(dir, 'env-only')
    await keys.init()
    const created = await keys.create('t')
    const config = { apiKey: 'env-only', adminToken: 'adm' } as AppConfig
    const app = new Hono()
    app.use('*', apiKeyAuth(config, keys))
    app.get('/v1/x', (c) => c.json({ ok: true }))

    const bad = await app.request('/v1/x')
    expect(bad.status).toBe(401)
    const envOk = await app.request('/v1/x', { headers: { authorization: 'Bearer env-only' } })
    expect(envOk.status).toBe(200)
    const keyOk = await app.request('/v1/x', { headers: { 'x-api-key': created.key } })
    expect(keyOk.status).toBe(200)
  })
})
