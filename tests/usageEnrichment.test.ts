import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import {
  bindUsageExitsStore,
  enrichUsageMeta,
  recordProxyUsage,
} from '../src/proxy/logUsage.js'
import { globalRequestLog } from '../src/proxy/requestLog.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  globalRequestLog.clear()
  bindUsageExitsStore(undefined)
})

async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-usage-enrich-'))
  dirs.push(d)
  return d
}

describe('usage enrichment (account label + exit)', () => {
  it('persists accountLabel, exitId, exitIp on new usage + request log', async () => {
    const dir = await tmpDir()
    const config = { ...loadConfig(), dataDir: dir, apiKey: 'x', adminToken: 'a' }
    const store = new AccountStore(dir, config)
    await store.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    await exits.importExits({
      exits: [
        {
          id: 'exit-7',
          server: 'ss.example.com',
          port: 8388,
          method: 'aes-256-gcm',
          password: 'pass#7',
          exitIp: '203.0.113.7',
        },
      ],
    })
    bindUsageExitsStore(exits)

    const acc = await store.create({
      label: 'Prod Alice',
      email: 'alice@example.com',
      accessToken: 'tok',
      enabled: true,
      outboundExitId: 'exit-7',
      outboundPoolId: 'pool-1',
    })

    await recordProxyUsage(
      store,
      {
        timestamp: 1000,
        accountId: acc.id,
        model: 'claude-sonnet-4.5',
        inputTokens: 11,
        outputTokens: 3,
        success: true,
        responseTimeMs: 42,
        apiKeyId: 'key-1',
        apiKeyLabel: 'ops',
      },
      { path: '/v1/messages', apiStyle: 'anthropic', status: 200 },
    )

    const usage = await store.getUsage()
    expect(usage.records).toHaveLength(1)
    const row = usage.records[0]!
    expect(row.accountLabel).toBe('Prod Alice')
    expect(row.exitId).toBe('exit-7')
    expect(row.exitIp).toBe('203.0.113.7')
    expect(row.apiKeyId).toBe('key-1')

    const entries = globalRequestLog.list({ limit: 5 })
    expect(entries[0]?.accountLabel).toBe('Prod Alice')
    expect(entries[0]?.exitId).toBe('exit-7')
    expect(entries[0]?.exitIp).toBe('203.0.113.7')
  })

  it('leaves exit blank when account has no outboundExitId', async () => {
    const dir = await tmpDir()
    const config = { ...loadConfig(), dataDir: dir, apiKey: 'x', adminToken: 'a' }
    const store = new AccountStore(dir, config)
    await store.init()
    const acc = await store.create({
      label: 'Bare',
      accessToken: 'tok',
      enabled: true,
    })
    const enriched = enrichUsageMeta(store, {
      timestamp: 1,
      accountId: acc.id,
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      success: true,
      responseTimeMs: 1,
    })
    expect(enriched.accountLabel).toBe('Bare')
    expect(enriched.exitId).toBeUndefined()
    expect(enriched.exitIp).toBeUndefined()
  })
})
