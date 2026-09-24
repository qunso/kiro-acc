import { describe, expect, it, afterEach } from 'vitest'
import {
  mergeKiroUsageFromEvent,
  extractEventType,
} from '../src/kiro/client.js'
import type { KiroUsage } from '../src/kiro/translator.js'
import {
  estimateInputFromContextPercentage,
  estimateTokensFromChars,
  estimateTokensFromPayload,
  getModelContextLength,
} from '../src/kiro/tokenEstimate.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

  it('reads messageMetadataEvent.tokenUsage (live wire alias of metadataEvent)', () => {
    const usage = emptyUsage()
    const result = mergeKiroUsageFromEvent(
      usage,
      {
        messageMetadataEvent: {
          tokenUsage: {
            uncachedInputTokens: 900,
            outputTokens: 40,
            cacheReadInputTokens: 100,
          },
        },
      },
      'messageMetadataEvent',
    )
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(40)
    expect(usage.cacheReadTokens).toBe(100)
    expect(result.hasRealInput).toBe(true)
    expect(result.hasRealOutput).toBe(true)
  })

  it('accepts numeric strings in tokenUsage fields', () => {
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(
      usage,
      {
        tokenUsage: {
          uncachedInputTokens: '250',
          outputTokens: '18',
        },
      },
      'metadataEvent',
    )
    expect(usage.inputTokens).toBe(250)
    expect(usage.outputTokens).toBe(18)
  })

  it('accepts snake_case token_usage field aliases (kiro.rs shape)', () => {
    const usage = emptyUsage()
    const result = mergeKiroUsageFromEvent(
      usage,
      {
        token_usage: {
          uncached_input_tokens: 70,
          cache_read_input_tokens: 30,
          output_tokens: 9,
          total_tokens: 109,
        },
      },
      'metadataEvent',
    )
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(9)
    expect(result.hasRealInput).toBe(true)
  })

  it('recovers input from totalTokens when uncached/input missing', () => {
    const usage = emptyUsage()
    mergeKiroUsageFromEvent(
      usage,
      {
        tokenUsage: {
          outputTokens: 30,
          totalTokens: 530,
        },
      },
      'messageMetadataEvent',
    )
    expect(usage.outputTokens).toBe(30)
    expect(usage.inputTokens).toBe(500)
  })

  it('surfaces contextUsagePercentage from contextUsageEvent without treating it as tokens', () => {
    const usage = emptyUsage()
    const result = mergeKiroUsageFromEvent(
      usage,
      { contextUsagePercentage: 12.7 },
      'contextUsageEvent',
    )
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(result.contextUsagePercentage).toBe(12.7)
    expect(result.hasRealInput).toBe(false)
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

describe('tokenEstimate fallbacks', () => {
  it('estimates payload tokens from UTF-8 bytes / 3', () => {
    const payload = JSON.stringify({ conversationState: { x: 'y'.repeat(300) } })
    const n = estimateTokensFromPayload(payload)
    expect(n).toBeGreaterThan(50)
    expect(n).toBe(Math.ceil(Buffer.byteLength(payload, 'utf-8') / 3))
  })

  it('estimates chars with chaogei coefficients', () => {
    expect(estimateTokensFromChars(1000, 'input')).toBe(420)
    expect(estimateTokensFromChars(1000, 'output')).toBe(400)
  })

  it('reverses contextUsagePercentage × model window', () => {
    // claude-sonnet-4.5 → 200_000 window; 12.7% → 25400
    expect(getModelContextLength('claude-sonnet-4.5')).toBe(200_000)
    expect(estimateInputFromContextPercentage(12.7, 'claude-sonnet-4.5')).toBe(25_400)
  })
})

describe('extractEventType', () => {
  function encodeHeaders(
    pairs: Array<{ name: string; valueType: number; value?: Uint8Array | string }>,
  ): Uint8Array {
    const parts: number[] = []
    for (const p of pairs) {
      const nameBytes = new TextEncoder().encode(p.name)
      parts.push(nameBytes.length, ...nameBytes, p.valueType)
      if (p.valueType === 7) {
        const vb = new TextEncoder().encode(String(p.value ?? ''))
        parts.push((vb.length >> 8) & 0xff, vb.length & 0xff, ...vb)
      } else if (p.valueType === 8) {
        // timestamp: 8 bytes
        parts.push(0, 0, 0, 0, 0, 0, 0, 1)
      } else if (p.valueType === 9) {
        parts.push(...new Array(16).fill(0))
      } else if (p.valueType === 4) {
        parts.push(0, 0, 0, 0)
      }
    }
    return Uint8Array.from(parts)
  }

  it('finds :event-type after a non-string header (skip, do not break)', () => {
    const headers = encodeHeaders([
      { name: ':message-type', valueType: 7, value: 'event' },
      { name: ':something-ts', valueType: 8 }, // timestamp — old code broke here
      { name: ':event-type', valueType: 7, value: 'messageMetadataEvent' },
      { name: ':content-type', valueType: 7, value: 'application/json' },
    ])
    expect(extractEventType(headers)).toBe('messageMetadataEvent')
  })

  it('returns metadataEvent when it is the first string header', () => {
    const headers = encodeHeaders([
      { name: ':event-type', valueType: 7, value: 'metadataEvent' },
    ])
    expect(extractEventType(headers)).toBe('metadataEvent')
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

  it('records payload-estimate input when metadata absent (fallback path)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-tokfb-'))
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

    // Simulate parseEventStream seeding when wire omits tokenUsage
    const payloadStr = JSON.stringify({ pad: 'x'.repeat(2000) })
    const inputTokens = estimateTokensFromPayload(payloadStr)
    expect(inputTokens).toBeGreaterThan(100)

    await recordProxyUsage(
      store,
      {
        timestamp: Date.now(),
        accountId,
        model: 'claude-sonnet-4.5',
        inputTokens,
        outputTokens: estimateTokensFromChars(16, 'output'),
        success: true,
        responseTimeMs: 50,
        apiKeyId: 'd3316416-05d7-4fae-8b2b-ba0652b896e2',
        apiKeyLabel: 'cursor',
      },
      { path: '/v1/chat/completions', apiStyle: 'openai', status: 200 },
    )

    const byKey = usageByApiKey(await store.getUsage())
    expect(byKey['d3316416-05d7-4fae-8b2b-ba0652b896e2']!.inputTokens).toBe(inputTokens)
    expect(byKey['d3316416-05d7-4fae-8b2b-ba0652b896e2']!.inputTokens).toBeGreaterThan(0)
  })
})
