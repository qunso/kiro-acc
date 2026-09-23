import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ClaudeSseSession, claudeToKiro, estimateClaudeInputTokens, kiroToClaudeResponse } from '../src/kiro/anthropic.js'
import { createServer } from '../src/server.js'
import type { AppConfig } from '../src/config.js'

describe('claudeToKiro', () => {
  it('places system text in history and tool results on the current turn', () => {
    const payload = claudeToKiro(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        system: 'be brief',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling' },
              { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { q: 'x' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
          },
        ],
        tools: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object' } }],
      },
      'arn:aws:codewhisperer:us-east-1:1:profile/p',
    )
    const history = payload.conversationState.history || []
    expect(history[0]?.userInputMessage?.content).toContain('be brief')
    expect(history[1]?.assistantResponseMessage?.content).toContain('follow')
    expect(history[2]?.userInputMessage?.content).toBe('hi')
    expect(history[3]?.assistantResponseMessage?.toolUses?.[0]?.name).toBe('echo')
    const current = payload.conversationState.currentMessage.userInputMessage
    expect(current.userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe('toolu_1')
    expect(current.userInputMessageContext?.tools?.[0]?.toolSpecification.name).toBe('echo')
    expect(payload.inferenceConfig?.maxTokens).toBe(128)
    expect(payload.profileArn).toContain('profile/p')
  })

  it('maps a non-stream response into Anthropic content blocks', () => {
    const res = kiroToClaudeResponse(
      'hello',
      [{ toolUseId: 'toolu_1', name: 'echo', input: { q: 1 } }],
      { inputTokens: 3, outputTokens: 4, credits: 0 },
      'claude-sonnet-4.5',
    )
    expect(res.type).toBe('message')
    expect(res.role).toBe('assistant')
    expect(res.stop_reason).toBe('tool_use')
    expect(res.content.map((b) => b.type)).toEqual(['text', 'tool_use'])
    expect(res.usage).toEqual({ input_tokens: 3, output_tokens: 4 })
  })

  it('emits Anthropic SSE events for text then a tool', () => {
    const sse = new ClaudeSseSession('claude-sonnet-4.5', 'msg_test')
    const raw =
      sse.start(2) +
      sse.text('Hi') +
      sse.tool({ toolUseId: 'toolu_1', name: 'echo', input: { q: 'z' } }) +
      sse.finish({ output_tokens: 5 })
    const events = [...raw.matchAll(/^event: (\S+)/gm)].map((m) => m[1])
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(raw).toContain('"text_delta"')
    expect(raw).toContain('"input_json_delta"')
    expect(raw).toContain('"stop_reason":"tool_use"')
    expect(estimateClaudeInputTokens({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, model: 'x' })).toBeGreaterThan(0)
  })
})

describe('POST /v1/messages', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  async function app() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-msg-'))
    const base = loadConfig()
    const config: AppConfig = { ...base, dataDir: dir, apiKey: 'test-key', adminToken: 'test-admin', maxRetries: 0 }
    const store = new AccountStore(dir, config)
    await store.init()
    return createServer(store, config)
  }

  it('rejects missing api key and invalid bodies, and counts tokens', async () => {
    const server = await app()
    const unauth = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(unauth.status).toBe(401)

    const bad = await server.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [] }),
    })
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { error: { type: string } }
    expect(badBody.error.type).toBe('invalid_request_error')

    const empty = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    expect(empty.status).toBe(503)

    const counted = await server.request('/anthropic/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    })
    expect(counted.status).toBe(200)
    const tokens = (await counted.json()) as { input_tokens: number }
    expect(tokens.input_tokens).toBeGreaterThan(0)
  })
})
