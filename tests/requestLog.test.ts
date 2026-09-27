import { describe, expect, it } from 'vitest'
import { RequestLog, isClientAbort } from '../src/proxy/requestLog.js'

describe('RequestLog', () => {
  it('keeps a capped ring buffer and filters', () => {
    const log = new RequestLog(3)
    for (let i = 0; i < 5; i++) {
      log.push({
        method: 'POST',
        path: '/v1/messages',
        apiStyle: 'anthropic',
        model: i % 2 ? 'claude-sonnet-4.5' : 'gpt-4o',
        accountId: 'a' + i,
        status: 200,
        success: true,
        latencyMs: i,
      })
    }
    expect(log.size).toBe(3)
    const openaiish = log.list({ q: 'gpt-4o' })
    expect(openaiish.length).toBeGreaterThan(0)
    expect(openaiish.every((e) => (e.model || '').includes('gpt'))).toBe(true)
    const byStyle = log.list({ apiStyle: 'anthropic' })
    expect(byStyle).toHaveLength(3)
  })

  it('stores and filters by api key label/id', () => {
    const log = new RequestLog(10)
    log.push({
      method: 'POST',
      path: '/v1/messages',
      apiStyle: 'anthropic',
      model: 'claude-sonnet-4.5',
      accountId: 'acct-1',
      apiKeyId: 'key-aaa',
      apiKeyLabel: 'ops',
      status: 200,
      success: true,
      latencyMs: 12,
    })
    log.push({
      method: 'POST',
      path: '/v1/chat/completions',
      apiStyle: 'openai',
      model: 'gpt-4o',
      accountId: 'acct-2',
      apiKeyId: 'env',
      apiKeyLabel: 'ENV API_KEY',
      status: 200,
      success: true,
      latencyMs: 9,
    })
    const byLabel = log.list({ apiKey: 'ops' })
    expect(byLabel).toHaveLength(1)
    expect(byLabel[0]?.apiKeyId).toBe('key-aaa')
    const byQ = log.list({ q: 'env api_key' })
    expect(byQ.some((e) => e.apiKeyId === 'env')).toBe(true)
  })

  it('stores exit and account label on entries and includes them in q filter', () => {
    const log = new RequestLog(10)
    log.push({
      method: 'POST',
      path: '/v1/messages',
      apiStyle: 'anthropic',
      model: 'claude-sonnet-4.5',
      accountId: 'a510f4ca-93a1-4b2c-9def-1234567890ab',
      accountLabel: 'alice@example.com',
      apiKeyId: 'key-1',
      apiKeyLabel: 'ops',
      exitId: 'exit-42',
      exitIp: '1.2.3.4',
      status: 200,
      success: true,
      latencyMs: 15,
    })
    const byExit = log.list({ q: 'exit-42' })
    expect(byExit).toHaveLength(1)
    expect(byExit[0]?.exitIp).toBe('1.2.3.4')
    expect(byExit[0]?.accountLabel).toBe('alice@example.com')
    const byLabel = log.list({ q: 'alice@example.com' })
    expect(byLabel).toHaveLength(1)
  })

  it('supports incremental since/afterId listing', () => {
    const log = new RequestLog(20)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const e = log.push({
        method: 'POST',
        path: '/v1/messages',
        apiStyle: 'anthropic',
        model: 'm' + i,
        status: 200,
        success: true,
        latencyMs: i,
        ts: 1_000_000 + i * 10,
      })
      ids.push(e.id)
    }
    // newest-first: ids[4] is newest
    const after = log.list({ afterId: ids[2], limit: 10 })
    expect(after.map((e) => e.id)).toEqual([ids[4], ids[3]])
    const since = log.list({ since: 1_000_000 + 20, limit: 10 })
    expect(since.map((e) => e.model)).toEqual(['m4', 'm3'])
    // afterId + since: only newer than id and ts
    const both = log.list({ afterId: ids[3], since: 1_000_000 + 30, limit: 10 })
    expect(both.map((e) => e.id)).toEqual([ids[4]])
    // unknown afterId without since → empty incremental
    expect(log.list({ afterId: 'missing', limit: 10 })).toEqual([])
  })

  it('round-trips inputTokens / outputTokens including zero', () => {
    const log = new RequestLog(10)
    const withTok = log.push({
      method: 'POST',
      path: '/v1/chat/completions',
      apiStyle: 'openai',
      model: 'gpt-4o',
      status: 200,
      success: true,
      latencyMs: 40,
      inputTokens: 1200,
      outputTokens: 80,
    })
    expect(withTok.inputTokens).toBe(1200)
    expect(withTok.outputTokens).toBe(80)
    const zero = log.push({
      method: 'POST',
      path: '/v1/messages',
      apiStyle: 'anthropic',
      model: 'claude-sonnet-4.5',
      status: 499,
      success: false,
      latencyMs: 9000,
      error: 'client aborted',
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(zero.inputTokens).toBe(0)
    expect(zero.outputTokens).toBe(0)
    const missing = log.push({
      method: 'POST',
      path: '/v1/messages',
      apiStyle: 'anthropic',
      model: 'm',
      status: 200,
      success: true,
      latencyMs: 1,
    })
    expect(missing.inputTokens).toBeUndefined()
    expect(missing.outputTokens).toBeUndefined()
    const listed = log.list({ limit: 10 })
    expect(listed.find((e) => e.id === withTok.id)?.inputTokens).toBe(1200)
    expect(listed.find((e) => e.id === zero.id)?.error).toBe('client aborted')
  })
})

describe('isClientAbort', () => {
  it('detects AbortError, Request aborted, and aborted signal', () => {
    expect(isClientAbort(new Error('Request aborted'))).toBe(true)
    const ae = new Error('The operation was aborted')
    ae.name = 'AbortError'
    expect(isClientAbort(ae)).toBe(true)
    const ac = new AbortController()
    ac.abort()
    expect(isClientAbort(new Error('other'), ac.signal)).toBe(true)
    expect(isClientAbort(new Error('upstream 502'))).toBe(false)
  })
})
