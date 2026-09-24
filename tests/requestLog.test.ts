import { describe, expect, it } from 'vitest'
import { RequestLog } from '../src/proxy/requestLog.js'

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
})
