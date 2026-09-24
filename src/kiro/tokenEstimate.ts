/**
 * Token estimation helpers for when Kiro stream metadata is missing/partial.
 *
 * Priority chain (mirrors chaogei/Kiro-account-manager):
 *   1. Real metadataEvent/messageMetadataEvent.tokenUsage
 *   2. contextUsageEvent.contextUsagePercentage × model context window
 *   3. Payload UTF-8 byte length / 3 (JSON payload empirical ±10%)
 *   4. Char-coefficient fallback (input ≈ 0.42 tok/char, output ≈ 0.4)
 *
 * No tiktoken dependency — keep the binary lean; estimates are for accounting
 * when the upstream wire omits tokenUsage (common on short completions).
 */

const modelContextWindowCache = new Map<string, number>()

export function setModelContextWindow(modelId: string, maxInputTokens: number): void {
  if (modelId && maxInputTokens > 0) {
    modelContextWindowCache.set(modelId, maxInputTokens)
  }
}

export function getModelContextWindow(modelId: string): number | undefined {
  return modelContextWindowCache.get(modelId)
}

function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-._]/g, '')
    .replace(/\d{8}/g, '')
    .replace(/v\d+$/g, '')
    .replace(/v\d+_\d+$/g, '')
}

function guessContextFromCache(modelId: string): number | undefined {
  if (modelContextWindowCache.size === 0) return undefined
  const queryNorm = normalizeModelId(modelId)
  if (!queryNorm) return undefined
  for (const [id, ctx] of modelContextWindowCache) {
    if (normalizeModelId(id) === queryNorm) return ctx
  }
  for (const [id, ctx] of modelContextWindowCache) {
    const idNorm = normalizeModelId(id)
    if (idNorm.includes(queryNorm) || queryNorm.includes(idNorm)) return ctx
  }
  return undefined
}

/** Context window size for reverse-estimating input from contextUsagePercentage. */
export function getModelContextLength(modelId: string | undefined | null): number {
  if (!modelId) return 200_000

  const cached = modelContextWindowCache.get(modelId)
  if (cached && cached > 0) return cached

  const guessed = guessContextFromCache(modelId)
  if (guessed && guessed > 0) return guessed

  const id = modelId.toLowerCase()
  if (
    id.includes('claude-opus-4') ||
    id.includes('claude-sonnet-4') ||
    id.includes('claude-haiku-4') ||
    id.includes('claude-3-7') ||
    id.includes('claude-3.7') ||
    id.includes('claude-3-5') ||
    id.includes('claude-3.5') ||
    id.includes('claude-3') ||
    id.includes('claude-2.1')
  ) {
    return 200_000
  }
  if (id.includes('claude-2') || id.includes('claude-instant')) return 100_000
  if (id.includes('gpt-4o') || id.includes('gpt-4-turbo') || id.includes('o1') || id.includes('o3')) {
    return 128_000
  }
  if (id.includes('gpt-4.1')) return 1_000_000
  if (id.includes('gpt-4-32k')) return 32_768
  if (id.includes('gpt-4')) return 8192
  if (id.includes('gpt-3.5-turbo-16k')) return 16_384
  if (id.includes('gpt-3.5')) return 4096
  if (id.includes('gemini-2.5') || id.includes('gemini-2.0') || id.includes('gemini-1.5')) {
    return 1_000_000
  }
  if (id.includes('gemini')) return 32_768
  if (id.includes('nova-pro') || id.includes('nova-lite')) return 300_000
  if (id.includes('nova-micro')) return 128_000
  if (id.includes('titan')) return 8000
  return 200_000
}

/** Estimate tokens from a JSON payload string (UTF-8 bytes / 3). */
export function estimateTokensFromPayload(payloadStr: string): number {
  if (!payloadStr) return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(payloadStr, 'utf-8') / 3))
}

/** Char-coefficient estimate (input 0.42 / output 0.4), chaogei empirical. */
export function estimateTokensFromChars(chars: number, kind: 'input' | 'output' = 'input'): number {
  if (chars <= 0) return 0
  const coeff = kind === 'output' ? 0.4 : 0.42
  return Math.max(1, Math.round(chars * coeff))
}

/** Reverse input tokens from contextUsagePercentage × model window. */
export function estimateInputFromContextPercentage(
  percentage: number,
  modelId?: string | null,
): number {
  if (!Number.isFinite(percentage) || percentage <= 0) return 0
  const window = getModelContextLength(modelId)
  return Math.max(1, Math.round((window * percentage) / 100))
}
