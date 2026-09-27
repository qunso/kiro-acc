import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import {
  applyEffortToKiroPayload,
  extractEffortFromClaude,
  extractEffortFromOpenAI,
  extractThinkingFromClaude,
  parseEffort,
  resolveEffort,
  usesGptReasoningEffort,
} from '../src/kiro/effort.js'
import { openaiToKiro, type KiroPayload } from '../src/kiro/translator.js'
import { claudeToKiro } from '../src/kiro/anthropic.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-effort-'))
  dirs.push(d)
  return d
}

function emptyPayload(modelId: string): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'c1',
      currentMessage: {
        userInputMessage: { content: 'hi', modelId, origin: 'AI_EDITOR' },
      },
    },
  }
}

describe('parseEffort / resolveEffort', () => {
  it('accepts valid levels and rejects junk', () => {
    expect(parseEffort('high')).toBe('high')
    expect(parseEffort(' XHIGH ')).toBe('xhigh')
    expect(parseEffort('')).toBeUndefined()
    expect(parseEffort('ultra')).toBeUndefined()
    expect(parseEffort(null)).toBeUndefined()
  })

  it('precedence: request > apiKey > account', () => {
    expect(resolveEffort('max', 'low', 'medium')).toBe('max')
    expect(resolveEffort(undefined, 'low', 'medium')).toBe('low')
    expect(resolveEffort(undefined, undefined, 'medium')).toBe('medium')
    expect(resolveEffort(undefined, undefined, undefined)).toBeUndefined()
  })
})

describe('client extractors', () => {
  it('reads OpenAI reasoning_effort and reasoning.effort', () => {
    expect(extractEffortFromOpenAI({ reasoning_effort: 'high' })).toBe('high')
    expect(extractEffortFromOpenAI({ reasoning: { effort: 'xhigh' } })).toBe('xhigh')
    expect(extractEffortFromOpenAI({ reasoning_effort: 'high', reasoning: { effort: 'low' } })).toBe(
      'high',
    )
    expect(extractEffortFromOpenAI({})).toBeUndefined()
  })

  it('reads Claude output_config.effort and thinking', () => {
    expect(extractEffortFromClaude({ output_config: { effort: 'max' } })).toBe('max')
    expect(extractThinkingFromClaude({ thinking: { type: 'adaptive', display: 'summarized' } })).toEqual(
      { type: 'adaptive', display: 'summarized' },
    )
    expect(extractThinkingFromClaude({})).toBeUndefined()
  })
})

describe('applyEffortToKiroPayload wire shape', () => {
  it('omits fields when unset', () => {
    const p = emptyPayload('claude-opus-5')
    applyEffortToKiroPayload(p, {})
    expect(p.additionalModelRequestFields).toBeUndefined()
  })

  it('uses output_config.effort for Claude models', () => {
    const p = emptyPayload('claude-opus-5')
    applyEffortToKiroPayload(p, { effort: 'high', modelId: 'claude-opus-5' })
    expect(p.additionalModelRequestFields).toEqual({
      output_config: { effort: 'high' },
    })
  })

  it('uses reasoning.effort for GPT-5.6 models', () => {
    expect(usesGptReasoningEffort('gpt-5.6-sol')).toBe(true)
    const p = emptyPayload('gpt-5.6-sol')
    applyEffortToKiroPayload(p, { effort: 'max', modelId: 'gpt-5.6-sol' })
    expect(p.additionalModelRequestFields).toEqual({
      reasoning: { effort: 'max' },
    })
  })

  it('passes thinking alongside effort', () => {
    const p = emptyPayload('claude-sonnet-5')
    applyEffortToKiroPayload(p, {
      effort: 'medium',
      thinking: { type: 'adaptive' },
      modelId: 'claude-sonnet-5',
    })
    expect(p.additionalModelRequestFields).toEqual({
      output_config: { effort: 'medium' },
      thinking: { type: 'adaptive' },
    })
  })
})

describe('openaiToKiro / claudeToKiro effort', () => {
  it('openaiToKiro embeds request reasoning_effort when no opts', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'low',
    })
    expect(payload.additionalModelRequestFields).toEqual({
      output_config: { effort: 'low' },
    })
  })

  it('openaiToKiro omits when neither request nor opts set effort', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('openaiToKiro opts.effort wins over request when opts object passed', () => {
    const payload = openaiToKiro(
      {
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
      },
      undefined,
      { effort: 'low' },
    )
    expect(payload.additionalModelRequestFields).toEqual({
      output_config: { effort: 'low' },
    })
  })

  it('openaiToKiro opts with undefined effort omits even if request has effort', () => {
    // Handlers pass fully-resolved effort; empty resolve must not re-read request.
    const payload = openaiToKiro(
      {
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
      },
      undefined,
      { effort: undefined },
    )
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('claudeToKiro embeds output_config + thinking from request', () => {
    const payload = claudeToKiro({
      model: 'claude-opus-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'xhigh' },
      thinking: { type: 'adaptive', display: 'omitted' },
    })
    expect(payload.additionalModelRequestFields).toEqual({
      output_config: { effort: 'xhigh' },
      thinking: { type: 'adaptive', display: 'omitted' },
    })
  })

  it('claudeToKiro uses reasoning.effort for gpt-5.6', () => {
    const payload = claudeToKiro(
      {
        model: 'gpt-5.6-terra',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
      undefined,
      { effort: 'high', modelId: 'gpt-5.6-terra' },
    )
    expect(payload.additionalModelRequestFields).toEqual({
      reasoning: { effort: 'high' },
    })
  })
})

describe('ApiKeyStore defaultEffort persistence', () => {
  it('creates, updates, clears, and resolveKey returns defaultEffort', async () => {
    const dir = await tmpDir()
    const store = new ApiKeyStore(dir, '')
    await store.init()
    const created = await store.create({ label: 'ops', defaultEffort: 'high' })
    expect(created.defaultEffort).toBe('high')
    expect(store.resolveKey(created.key)?.defaultEffort).toBe('high')

    const updated = await store.update(created.id, { defaultEffort: 'max' })
    expect(updated?.defaultEffort).toBe('max')

    const cleared = await store.update(created.id, { defaultEffort: null })
    expect(cleared?.defaultEffort).toBeUndefined()
    expect(store.resolveKey(created.key)?.defaultEffort).toBeUndefined()

    await expect(store.create({ label: 'bad', defaultEffort: 'nope' })).rejects.toThrow(/invalid defaultEffort/)
  })
})

describe('AccountStore defaultEffort persistence', () => {
  it('persists and clears defaultEffort on create/update', async () => {
    const dir = await tmpDir()
    const config = { ...loadConfig(), dataDir: dir }
    const store = new AccountStore(dir, config)
    await store.init()
    const acc = await store.create({
      label: 'a1',
      accessToken: 'tok',
      enabled: true,
      defaultEffort: 'medium',
    })
    expect(store.get(acc.id)?.defaultEffort).toBe('medium')

    const next = await store.update(acc.id, { defaultEffort: 'low' })
    expect(next.defaultEffort).toBe('low')

    const cleared = await store.update(acc.id, { defaultEffort: '' as never })
    expect(cleared.defaultEffort).toBeUndefined()

    await expect(store.update(acc.id, { defaultEffort: 'bogus' as never })).rejects.toThrow(
      /invalid defaultEffort/,
    )
  })
})
