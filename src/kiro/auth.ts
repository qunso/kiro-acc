/**
 * Pluggable token refresh for Kiro / Amazon Q Builder ID / Social / IdC accounts.
 * Patterns adapted from chaogei/Kiro-account-manager (AGPL-3.0).
 */
import type { AccountRecord } from '../accounts/types.js'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { getDispatcherForAccount } from '../net/outboundDispatcher.js'

async function accountFetch(
  account: AccountRecord,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const dispatcher = getDispatcherForAccount(account.outboundProxyUrl)
  if (dispatcher) {
    return (await undiciFetch(url, {
      ...init,
      dispatcher,
    } as UndiciRequestInit)) as unknown as Response
  }
  return fetch(url, init)
}


export interface TokenRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  error?: string
}

export type TokenRefreshFn = (account: AccountRecord) => Promise<TokenRefreshResult>

const SOCIAL_REFRESH_URL =
  process.env.KIRO_SOCIAL_REFRESH_URL ||
  'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'

const IDC_TOKEN_URL_TEMPLATE =
  process.env.KIRO_IDC_TOKEN_URL ||
  'https://oidc.{region}.amazonaws.com/token'

const BUILDER_ID_REFRESH_URL =
  process.env.KIRO_BUILDER_REFRESH_URL ||
  'https://oidc.us-east-1.amazonaws.com/token'

export const KIRO_SOCIAL_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

export const KIRO_BUILDER_ID_PLACEHOLDER_ARN =
  'arn:aws:codewhisperer:us-east-1:699475941385:profile/KIRO_BUILDER_ID_PLACEHOLDER'

export function isPlaceholderProfileArn(arn?: string): boolean {
  if (!arn) return true
  return arn.includes('PLACEHOLDER') || arn.includes('KIRO_BUILDER_ID_PLACEHOLDER')
}

export function resolveProfileArn(account: AccountRecord): string | undefined {
  if (account.profileArn && !isPlaceholderProfileArn(account.profileArn)) {
    return account.profileArn
  }
  if (account.provider === 'Enterprise' || account.authMethod === 'external_idp') {
    const region = account.region || 'us-east-1'
    return `arn:aws:codewhisperer:${region}:699475941385:profile/EHGA3GRVQMUK`
  }
  if (
    account.authMethod === 'social' ||
    account.provider === 'Github' ||
    account.provider === 'Google'
  ) {
    return KIRO_SOCIAL_PROFILE_ARN
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

async function refreshSocial(account: AccountRecord): Promise<TokenRefreshResult> {
  if (!account.refreshToken) {
    return { success: false, error: 'No refreshToken for social account' }
  }
  try {
    const res = await accountFetch(account, SOCIAL_REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: account.refreshToken }),
    })
    const text = await res.text()
    if (!res.ok) {
      return { success: false, error: `Social refresh HTTP ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = JSON.parse(text) as {
      accessToken?: string
      refreshToken?: string
      expiresIn?: number
      expiresAt?: number
    }
    if (!data.accessToken) {
      return { success: false, error: 'Social refresh response missing accessToken' }
    }
    const expiresAt =
      data.expiresAt ??
      (data.expiresIn ? Date.now() + data.expiresIn * 1000 : Date.now() + 3600_000)
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || account.refreshToken,
      expiresAt,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function refreshOidc(
  account: AccountRecord,
  tokenUrl: string,
): Promise<TokenRefreshResult> {
  if (!account.refreshToken) {
    return { success: false, error: 'No refreshToken for OIDC account' }
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
  })
  if (account.clientId) body.set('client_id', account.clientId)
  if (account.clientSecret) body.set('client_secret', account.clientSecret)

  try {
    const res = await accountFetch(account, tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await res.text()
    if (!res.ok) {
      return { success: false, error: `OIDC refresh HTTP ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = JSON.parse(text) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!data.access_token) {
      return { success: false, error: 'OIDC refresh response missing access_token' }
    }
    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || account.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const defaultTokenRefresh: TokenRefreshFn = async (account) => {
  const method = (account.authMethod || '').toLowerCase()
  const provider = (account.provider || '').toLowerCase()

  if (method === 'social' || provider === 'github' || provider === 'google') {
    return refreshSocial(account)
  }

  if (method === 'idc' || method === 'external_idp' || provider === 'enterprise') {
    const region = account.region || 'us-east-1'
    const url = IDC_TOKEN_URL_TEMPLATE.replace('{region}', region)
    return refreshOidc(account, url)
  }

  // builder_id / default → AWS OIDC refresh
  if (account.refreshToken) {
    return refreshOidc(account, BUILDER_ID_REFRESH_URL)
  }

  return {
    success: false,
    error:
      'No refresh strategy available (missing refreshToken / authMethod). Provide a valid accessToken or configure refresh.',
  }
}

const inFlight = new Map<string, Promise<TokenRefreshResult>>()

export async function refreshAccountToken(
  account: AccountRecord,
  refreshFn: TokenRefreshFn = defaultTokenRefresh,
): Promise<TokenRefreshResult> {
  const existing = inFlight.get(account.id)
  if (existing) return existing

  const task = (async () => {
    // small jitter to avoid thundering herd
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 500)))
    return refreshFn(account)
  })()

  inFlight.set(account.id, task)
  try {
    return await task
  } finally {
    inFlight.delete(account.id)
  }
}

export function isTokenExpiringSoon(
  account: AccountRecord,
  beforeExpirySec: number,
): boolean {
  if (!account.expiresAt) return false
  return Date.now() + beforeExpirySec * 1000 >= account.expiresAt
}
