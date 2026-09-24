import { describe, expect, it } from 'vitest'
import { mergeKiroUsageFromEvent } from '../src/kiro/client.js'
import type { KiroUsage } from '../src/kiro/translator.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { recordProxyUsage } from '../src/proxy/logUsage.js'
import { usageByApiKey } from '../src/admin/subscription.js'
import { globalRequestLog } from '../src/proxy/requestLog.js'

function emptyUsage(): KiroUsage {
  return { inputTokens: 0, outputTokens: 0, credits: 0 }
}

describe('mergeKiroUsageFromEvent', () => {
  it('reads metadataEvent.tokenUsage.uncachedInputTokens (real Kiro wire shape)', () => {
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(
      usage,
      {
        tokenUsage: {
          uncachedInputTokens: 1200,
          outputTokens: 340,
          cacheReadInputTokens: 50,
          cacheWriteInputTokens: 10,
        },
        stopReason: 'end_turn',
      },
      'metadataEvent',
    )
    expect(usage.inputTokens).toBe(1260) // 1200 + 50 + 10
    expect(usage.outputTokens).toBe(340)
    expect(usage.cacheReadTokens).toBe(50)
    expect(usage.cacheWriteTokens).toBe(10)
  })

  it('reads wrapped { metadataEvent: { tokenUsage } } payloads', () => {
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(
      usage,
      {
        metadataEvent: {
          tokenUsage: { uncachedInputTokens: 88, outputTokens: 12 },
        },
      },
      '',
    )
    expect(usage.inputTokens).toBe(88)
    expect(usage.outputTokens).toBe(12)
  })

  it('treats meteringEvent.usage as credits, not tokens', () => {
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(usage, { usage: 7, unit: 'CREDIT' }, 'meteringEvent')
    expect(usage.credits).toBe(7)
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
  })

  it('still accepts legacy usageEvent.inputTokens / outputTokens', () => {
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(
      usage,
      { usageEvent: { inputTokens: 10, outputTokens: 5 } },
      'usageEvent',
    )
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(5)
  })
})

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  globalRequestLog.clear()
})

describe('api-key admin summary after metadata usage', () => {
  it('shows nonzero Token 入/出 when UsageRecord has apiKeyId + tokens from metadataEvent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-tokfix-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir, apiKey: 'x', adminToken: 'a' }
    const store = new AccountStore(dir, config)
    await store.init()
    await store.create({
      label: 't',
      email: 't@example.com',
      accessToken: 'tok',
      enabled: true,
    })
    const accountId = store.list()[0]!.id

    // Simulate what the streaming handler should persist after mergeKiroUsageFromEvent
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(
      usage,
      {
        tokenUsage: { uncachedInputTokens: 500, outputTokens: 120 },
      },
      'metadataEvent',
    )

    await recordProxyUsage(
      store,
      {
        timestamp: Date.now(),
        accountId,
        model: 'claude-sonnet-4.5',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        success: true,
        responseTimeMs: 100,
        apiKeyId: 'd3316416-05d7-4fae-8b2b-ba0652b896e2',
        apiKeyLabel: 'cursor',
      },
      { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 },
    )

    const byKey = usageByApiKey(await store.getUsage())
    expect(byKey['d3316416-05d7-4fae-8b2b-ba0652b896e2']).toMatchObject({
      requestCount: 1,
      inputTokens: 500,
      outputTokens: 120,
      apiKeyLabel: 'cursor',
    })
  })
})
