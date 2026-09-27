/**
 * Reasoning / thinking effort: client extraction, defaults precedence, and
 * Kiro `additionalModelRequestFields` wire shape.
 *
 * Precedence: request override > API-key default > account default > unset (omit).
 * Valid levels: low | medium | high | xhigh | max
 *
 * Upstream (Amazon Q / CodeWhisperer):
 * - Claude family → additionalModelRequestFields.output_config.effort (+ optional thinking)
 * - GPT-5.6 family → additionalModelRequestFields.reasoning.effort
 */

import type { KiroPayload } from './translator.js'

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export type ClaudeThinkingPassthrough = {
  type?: string
  display?: string
  budget_tokens?: number
  [key: string]: unknown
}

export interface EffortApplyOptions {
  effort?: EffortLevel
  /** Anthropic Messages `thinking` object, passed through when present. */
  thinking?: ClaudeThinkingPassthrough
  /** Resolved model id (friendly / upstream) used to pick wire key. */
  modelId?: string
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}

/** Parse a raw effort string; invalid / empty → undefined (unset). */
export function parseEffort(raw: unknown): EffortLevel | undefined {
  if (raw == null) return undefined
  if (typeof raw !== 'string') return undefined
  const s = raw.trim().toLowerCase()
  if (!s) return undefined
  return isEffortLevel(s) ? s : undefined
}

/**
 * Resolve effective effort.
 * request > apiKeyDefault > accountDefault > unset
 */
export function resolveEffort(
  requestEffort: EffortLevel | undefined,
  apiKeyDefault: EffortLevel | undefined,
  accountDefault: EffortLevel | undefined,
): EffortLevel | undefined {
  return requestEffort ?? apiKeyDefault ?? accountDefault
}

/** OpenAI-compatible: reasoning.effort and/or top-level reasoning_effort. */
export function extractEffortFromOpenAI(body: {
  reasoning_effort?: unknown
  reasoning?: unknown
}): EffortLevel | undefined {
  const fromTop = parseEffort(body.reasoning_effort)
  if (fromTop) return fromTop
  const reasoning = body.reasoning
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    return parseEffort((reasoning as { effort?: unknown }).effort)
  }
  return undefined
}

/** Anthropic Messages: output_config.effort */
export function extractEffortFromClaude(body: {
  output_config?: unknown
}): EffortLevel | undefined {
  const oc = body.output_config
  if (oc && typeof oc === 'object' && !Array.isArray(oc)) {
    return parseEffort((oc as { effort?: unknown }).effort)
  }
  return undefined
}

/** Anthropic Messages: thinking object (passthrough when present). */
export function extractThinkingFromClaude(body: {
  thinking?: unknown
}): ClaudeThinkingPassthrough | undefined {
  const t = body.thinking
  if (!t || typeof t !== 'object' || Array.isArray(t)) return undefined
  return { ...(t as ClaudeThinkingPassthrough) }
}

/** GPT-5.6 family uses reasoning.effort; everything else uses output_config.effort. */
export function usesGptReasoningEffort(modelId: string | undefined): boolean {
  const m = (modelId || '').trim().toLowerCase()
  return m.includes('gpt-5.6') || /^gpt-5\.6/.test(m)
}

/**
 * Attach additionalModelRequestFields for effort / thinking.
 * Omits the whole field when neither effort nor thinking is set.
 * Does not overwrite unrelated keys already on the payload.
 */
export function applyEffortToKiroPayload(
  payload: KiroPayload,
  opts: EffortApplyOptions,
): KiroPayload {
  const effort = opts.effort
  const thinking = opts.thinking
  if (!effort && !thinking) return payload

  const modelId =
    opts.modelId ||
    payload.conversationState.currentMessage.userInputMessage.modelId ||
    ''

  const fields: Record<string, unknown> = {
    ...(payload.additionalModelRequestFields || {}),
  }

  if (effort) {
    if (usesGptReasoningEffort(modelId)) {
      fields.reasoning = { effort }
      // Avoid leaving a stale Claude-shaped key if caller re-applies.
      delete fields.output_config
    } else {
      const prev =
        fields.output_config &&
        typeof fields.output_config === 'object' &&
        !Array.isArray(fields.output_config)
          ? (fields.output_config as Record<string, unknown>)
          : {}
      fields.output_config = { ...prev, effort }
      delete fields.reasoning
    }
  }

  if (thinking) {
    fields.thinking = thinking
  }

  payload.additionalModelRequestFields = fields
  return payload
}
