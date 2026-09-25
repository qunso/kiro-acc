/**
 * Compat upstream account helpers (OpenAI / Anthropic API-key relays).
 * Distinct from `provider` (IdP: Google / Github / BuilderId).
 */
import type { AccountRecord, UpstreamType } from './types.js'

export const UPSTREAM_TYPES: readonly UpstreamType[] = [
  'kiro',
  'openai_compat',
  'anthropic_compat',
] as const

export function resolveUpstreamType(
  account: Pick<AccountRecord, 'upstreamType'> | null | undefined,
): UpstreamType {
  const raw = (account?.upstreamType || 'kiro').trim().toLowerCase()
  if (raw === 'openai_compat' || raw === 'openai-compatible' || raw === 'openai') {
    return 'openai_compat'
  }
  if (
    raw === 'anthropic_compat' ||
    raw === 'anthropic-compatible' ||
    raw === 'anthropic' ||
    raw === 'claude'
  ) {
    return 'anthropic_compat'
  }
  return 'kiro'
}

export function isCompatUpstream(
  account: Pick<AccountRecord, 'upstreamType'> | null | undefined,
): boolean {
  const t = resolveUpstreamType(account)
  return t === 'openai_compat' || t === 'anthropic_compat'
}

/** Whether this account can serve an inbound OpenAI or Anthropic-style request. */
export function accountSupportsApiStyle(
  account: Pick<AccountRecord, 'upstreamType'> | null | undefined,
  style: 'openai' | 'anthropic',
): boolean {
  const t = resolveUpstreamType(account)
  if (t === 'kiro') return true
  if (t === 'openai_compat') return style === 'openai'
  if (t === 'anthropic_compat') return style === 'anthropic'
  return false
}

/**
 * Join baseUrl + api path, strip trailing slashes, and avoid doubling `/v1`
 * when the operator already put `/v1` on baseUrl (OpenAI SDK convention).
 *
 * Examples:
 * - joinCompatUrl('https://api.openai.com', '/v1/chat/completions')
 *     → https://api.openai.com/v1/chat/completions
 * - joinCompatUrl('https://api.openai.com/v1/', '/v1/chat/completions')
 *     → https://api.openai.com/v1/chat/completions
 * - joinCompatUrl('https://relay.example/openai/v1', 'chat/completions')
 *     → https://relay.example/openai/v1/chat/completions
 */
export function joinCompatUrl(baseUrl: string, apiPath: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('baseUrl is required')
  let path = String(apiPath || '').trim()
  if (!path) throw new Error('apiPath is required')
  if (!path.startsWith('/')) path = `/${path}`

  if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(path)) {
    path = path.replace(/^\/v1/i, '') || '/'
    if (!path.startsWith('/')) path = `/${path}`
  }
  return `${base}${path === '/' ? '' : path}`
}

export function applyModelPrefix(
  model: string | undefined,
  prefix: string | undefined,
): string | undefined {
  if (model == null) return model
  const p = (prefix || '').trim()
  if (!p) return model
  if (model.startsWith(p)) return model
  return `${p}${model}`
}

export interface CompatAccountValidation {
  ok: boolean
  error?: string
}

/** Validate create/update payload for compat vs kiro credentials. */
export function validateAccountCredentials(
  input: Partial<AccountRecord> & { upstreamType?: string },
  opts: { partial?: boolean } = {},
): CompatAccountValidation {
  const t = resolveUpstreamType(input)
  if (t === 'kiro') {
    if (opts.partial) return { ok: true }
    if (!input.accessToken && !input.refreshToken) {
      return { ok: false, error: 'accessToken or refreshToken is required' }
    }
    return { ok: true }
  }
  const baseUrl = (input.baseUrl || '').trim()
  const key = (input.upstreamApiKey || '').trim()
  if (!opts.partial) {
    if (!baseUrl) return { ok: false, error: 'baseUrl is required for compat upstream accounts' }
    if (!key) {
      return { ok: false, error: 'upstreamApiKey is required for compat upstream accounts' }
    }
  } else {
    if ('baseUrl' in input && input.baseUrl != null && !String(input.baseUrl).trim()) {
      return { ok: false, error: 'baseUrl cannot be empty for compat upstream accounts' }
    }
    if (
      'upstreamApiKey' in input &&
      input.upstreamApiKey != null &&
      !String(input.upstreamApiKey).trim()
    ) {
      return { ok: false, error: 'upstreamApiKey cannot be empty for compat upstream accounts' }
    }
  }
  try {
    if (baseUrl) {
      const u = new URL(baseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, error: 'baseUrl must be http(s)' }
      }
    }
  } catch {
    return { ok: false, error: 'baseUrl is not a valid URL' }
  }
  return { ok: true }
}
