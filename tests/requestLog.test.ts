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
})
