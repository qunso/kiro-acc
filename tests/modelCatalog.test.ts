import { afterEach, describe, expect, it } from 'vitest'
import {
  mapModelId,
  PUBLIC_MODELS,
  setCustomModelMap,
  toCodeWhispererModelId,
} from '../src/kiro/translator.js'

afterEach(() => {
  setCustomModelMap({})
})

describe('mapModelId', () => {
  it('maps opus-5 and aliases without collapsing to opus-4.5', () => {
    expect(mapModelId('claude-opus-5')).toBe('claude-opus-5')
    expect(mapModelId('CLAUDE-OPUS-5')).toBe('claude-opus-5')
    expect(mapModelId('claude-opus-5')).not.toBe('claude-opus-4.5')
  })

  it('normalizes dash/dot aliases for newer Claude models', () => {
    expect(mapModelId('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(mapModelId('claude-opus-4.7')).toBe('claude-opus-4.7')
    expect(mapModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
    expect(mapModelId('claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('maps gpt-5.6 and open-weight Kiro ids', () => {
    expect(mapModelId('gpt-5-6-sol')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(mapModelId('deepseek-3-2')).toBe('deepseek-3.2')
    expect(mapModelId('minimax-m2-5')).toBe('minimax-m2.5')
    expect(mapModelId('glm-5')).toBe('glm-5')
    expect(mapModelId('qwen3-coder-next')).toBe('qwen3-coder-next')
    expect(mapModelId('auto')).toBe('auto')
  })

  it('keeps admin custom overrides above builtins', () => {
    setCustomModelMap({ 'my-opus': 'claude-opus-5' })
    expect(mapModelId('my-opus')).toBe('claude-opus-5')
    expect(mapModelId('gpt-4o')).toBe('claude-sonnet-4.5')
  })
})

describe('toCodeWhispererModelId', () => {
  it('keeps known SCREAMING_SNAKE maps for Claude 4.x classics', () => {
    expect(toCodeWhispererModelId('claude-sonnet-4.5')).toBe('CLAUDE_SONNET_4_5_20250929_V1_0')
    expect(toCodeWhispererModelId('claude-haiku-4.5')).toBe('CLAUDE_HAIKU_4_5_20251001_V1_0')
    expect(toCodeWhispererModelId('claude-opus-4.5')).toBe('CLAUDE_OPUS_4_5_20251101_V1_0')
    expect(toCodeWhispererModelId('claude-sonnet-4')).toBe('CLAUDE_SONNET_4_20250514_V1_0')
  })

  it('passes through opus-5 and other newer Kiro ids instead of Sonnet 4 fallback', () => {
    expect(toCodeWhispererModelId('claude-opus-5')).toBe('claude-opus-5')
    expect(toCodeWhispererModelId('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(toCodeWhispererModelId('claude-opus-4.8')).toBe('claude-opus-4.8')
    expect(toCodeWhispererModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(toCodeWhispererModelId('claude-opus-5')).not.toBe('CLAUDE_SONNET_4_20250514_V1_0')
    expect(toCodeWhispererModelId('claude-opus-5')).not.toBe('CLAUDE_OPUS_4_5_20251101_V1_0')
  })

  it('still defaults unknown non-Kiro ids to Sonnet 4 CW id', () => {
    expect(toCodeWhispererModelId('totally-unknown-model')).toBe('CLAUDE_SONNET_4_20250514_V1_0')
  })
})

describe('PUBLIC_MODELS', () => {
  it('exposes opus-5 and other current Kiro models', () => {
    const ids = PUBLIC_MODELS.map((m) => m.id)
    for (const id of [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4.8',
      'claude-opus-4.7',
      'claude-opus-4.6',
      'claude-sonnet-4.6',
      'gpt-5.6-sol',
      'deepseek-3.2',
      'auto',
    ]) {
      expect(ids).toContain(id)
    }
  })
})
