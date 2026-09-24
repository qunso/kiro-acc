import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { recordProxyUsage } from '../src/proxy/logUsage.js'
import { globalRequestLog } from '../src/proxy/requestLog.js'
import { usageByApiKey } from '../src/admin/subscription.js'
import { normalizeAccountImport } from '../src/accounts/importNormalize.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  globalRequestLog.clear()
})

async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-keyusage-'))
  dirs.push(d)
  return d
}

describe('usageByApiKey aggregation', () => {
  it('rolls up persisted usage records by apiKeyId', async () => {
    const dir = await tmpDir()
    const config = { ...loadConfig(), dataDir: dir, apiKey: 'x', adminToken: 'a' }
    const store = new AccountStore(dir, config)
    await store.init()
    await store.create({
      label: 't',
      email: 't@example.com',
      accessToken: 'tok',
      enabled: true,
    })
    const accounts = store.list()
    const accountId = accounts[0]!.id

    await recordProxyUsage(
      store,
      {
        timestamp: 1000,
        accountId,
        model: 'claude-sonnet-4.5',
        inputTokens: 10,
        outputTokens: 5,
        success: true,
        responseTimeMs: 50,
        apiKeyId: 'key-1',
        apiKeyLabel: 'ops',
      },
      { path: '/v1/messages', apiStyle: 'anthropic', status: 200 },
    )
    await recordProxyUsage(
      store,
      {
        timestamp: 2000,
        accountId,
        model: 'claude-sonnet-4.5',
        inputTokens: 3,
        outputTokens: 7,
        success: true,
        responseTimeMs: 40,
        apiKeyId: 'key-1',
        apiKeyLabel: 'ops',
      },
      { path: '/v1/messages', apiStyle: 'anthropic', status: 200 },
    )
    await recordProxyUsage(
      store,
      {
        timestamp: 3000,
        accountId,
        model: 'claude-haiku-4.5',
        inputTokens: 1,
        outputTokens: 1,
        success: true,
        responseTimeMs: 20,
        apiKeyId: 'env',
        apiKeyLabel: 'ENV API_KEY',
      },
      { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 },
    )

    const usage = await store.getUsage()
    const byKey = usageByApiKey(usage)
    expect(byKey['key-1']).toMatchObject({
      requestCount: 2,
      inputTokens: 13,
      outputTokens: 12,
      lastUsedAt: 2000,
      apiKeyLabel: 'ops',
    })
    expect(byKey['env']).toMatchObject({
      requestCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      lastUsedAt: 3000,
    })

    const logged = globalRequestLog.list({ limit: 10 })
    expect(logged.some((e) => e.apiKeyId === 'key-1' && e.apiKeyLabel === 'ops')).toBe(true)
    expect(logged.some((e) => e.apiKeyId === 'env')).toBe(true)
  })
})

describe('deviceId import (display-only)', () => {
  it('picks deviceId / machineId from import JSON without inventing values', () => {
    const withDevice = normalizeAccountImport({
      email: 'd@example.com',
      refreshToken: 'rt',
      deviceId: 'dev-abc-123',
    })
    expect(withDevice.accounts[0]?.deviceId).toBe('dev-abc-123')

    const withMachine = normalizeAccountImport({
      email: 'm@example.com',
      refreshToken: 'rt2',
      machineId: 'machine-xyz',
    })
    expect(withMachine.accounts[0]?.deviceId).toBe('machine-xyz')

    const bare = normalizeAccountImport({
      email: 'n@example.com',
      refreshToken: 'rt3',
    })
    expect(bare.accounts[0]?.deviceId).toBeUndefined()
  })
})
