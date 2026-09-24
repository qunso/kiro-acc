/**
 * Fetch Kiro / Amazon Q credit usage limits (GetUsageLimits REST).
 * Endpoint & response mapping adapted from chaogei/Kiro-account-manager (AGPL-3.0).
 * Intentionally omits machine-ID spoofing.
 */
import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { AccountQuotaDetail, AccountRecord } from '../accounts/types.js'
import { getDispatcherForAccount } from '../net/outboundDispatcher.js'
import { isPlaceholderProfileArn, resolveProfileArn } from './auth.js'

const KIRO_VERSION = '0.12.155'
const AWS_SDK_VERSION = '1.0.34'

const REST_BASES: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com',
}

export interface UsageBreakdown {
  resourceType?: string
  type?: string
  displayName?: string
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  freeTrialInfo?: {
    freeTrialStatus?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    freeTrialExpiry?: number | string
  }
  bonuses?: Array<{
    bonusCode?: string
    displayName?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    expiresAt?: number | string
  }>
}

export interface UsageLimitsResponse {
  usageBreakdownList?: UsageBreakdown[]
  nextDateReset?: number | string
  subscriptionInfo?: {
    subscriptionTitle?: string
    subscriptionName?: string
    subscriptionType?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  userInfo?: { email?: string; userId?: string }
  overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
}

export interface CreditQuota {
  used: number
  limit: number
  /** ms epoch when quota resets, if known */
  resetAt?: number
  subscriptionTitle?: string
  baseUsed: number
  baseLimit: number
  trialUsed: number
  trialLimit: number
  bonusUsed: number
  bonusLimit: number
  bonusCount: number
  resourceType?: string
  overageCapability?: string
  upgradeCapability?: string
  overageStatus?: string
  userId?: string
  userEmail?: string
  raw: UsageLimitsResponse
  endpoint: string
}

export class UsageLimitsError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'UsageLimitsError'
  }
}

function getUserAgent(): string {
  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'macos' : 'linux'
  return `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${platform}#${process.version} lang/js md/nodejs#${process.versions.node} api/codewhispererstreaming#${AWS_SDK_VERSION} m/E KiroIDE-${KIRO_VERSION}`
}

function getAmzUserAgent(): string {
  return `aws-sdk-js/${AWS_SDK_VERSION} KiroIDE-${KIRO_VERSION}`
}

function restBaseForRegion(region?: string): string {
  if (!region) return REST_BASES['us-east-1']!
  if (REST_BASES[region]) return REST_BASES[region]!
  if (region.startsWith('eu-')) return REST_BASES['eu-central-1']!
  return REST_BASES['us-east-1']!
}

function fallbackRestBase(primary: string): string {
  return primary === REST_BASES['eu-central-1']
    ? REST_BASES['us-east-1']!
    : REST_BASES['eu-central-1']!
}

/** Prefer a real profileArn; never send BuilderId placeholder. */
export function profileArnForUsageLimits(account: AccountRecord): string | undefined {
  if (account.profileArn && !isPlaceholderProfileArn(account.profileArn)) {
    return account.profileArn
  }
  const resolved = resolveProfileArn(account)
  if (resolved && !isPlaceholderProfileArn(resolved)) return resolved
  return undefined
}

function authHeaders(account: AccountRecord): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${account.accessToken}`,
    'user-agent': getUserAgent(),
    'x-amz-user-agent': getAmzUserAgent(),
    'amz-sdk-invocation-id': randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
  }
  if (account.authMethod === 'external_idp' || account.provider === 'ExternalIdp') {
    headers.TokenType = 'EXTERNAL_IDP'
  }
  return headers
}

async function accountGet(
  account: AccountRecord,
  url: string,
  timeoutMs = 12_000,
): Promise<Response> {
  const dispatcher = getDispatcherForAccount(account.outboundProxyUrl)
  const signal = AbortSignal.timeout(timeoutMs)
  const init: RequestInit = {
    method: 'GET',
    headers: authHeaders(account),
    signal,
  }
  if (dispatcher) {
    return (await undiciFetch(url, {
      ...init,
      dispatcher,
    } as UndiciRequestInit)) as unknown as Response
  }
  return fetch(url, init)
}

function buildPath(profileArn?: string): string {
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true',
  })
  if (profileArn) params.set('profileArn', profileArn)
  return `/getUsageLimits?${params.toString()}`
}

function num(...vals: Array<number | undefined>): number {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}

export function normalizeResetAt(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    // Unix seconds → ms (heuristic: < year 2100 in seconds)
    return value < 1e12 ? value * 1000 : value
  }
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : undefined
}

/** Map CREDIT breakdown (+ active free trial + bonuses) → used/limit. */
export function creditQuotaFromUsageLimits(
  raw: UsageLimitsResponse,
  endpoint: string,
): CreditQuota {
  const list = raw.usageBreakdownList || []
  const credit =
    list.find((b) => (b.resourceType || b.type || '').toUpperCase() === 'CREDIT') || list[0]

  const baseUsed = num(credit?.currentUsageWithPrecision, credit?.currentUsage)
  const baseLimit = num(credit?.usageLimitWithPrecision, credit?.usageLimit)

  let trialUsed = 0
  let trialLimit = 0
  const trial = credit?.freeTrialInfo
  if (trial && String(trial.freeTrialStatus || '').toUpperCase() === 'ACTIVE') {
    trialUsed = num(trial.currentUsageWithPrecision, trial.currentUsage)
    trialLimit = num(trial.usageLimitWithPrecision, trial.usageLimit)
  }

  const bonuses = credit?.bonuses || []
  let bonusUsed = 0
  let bonusLimit = 0
  for (const b of bonuses) {
    bonusUsed += num(b.currentUsageWithPrecision, b.currentUsage)
    bonusLimit += num(b.usageLimitWithPrecision, b.usageLimit)
  }

  const sub = raw.subscriptionInfo
  const overage = raw.overageConfiguration

  return {
    used: baseUsed + trialUsed + bonusUsed,
    limit: baseLimit + trialLimit + bonusLimit,
    resetAt: normalizeResetAt(raw.nextDateReset),
    subscriptionTitle: sub?.subscriptionTitle || sub?.subscriptionName,
    baseUsed,
    baseLimit,
    trialUsed,
    trialLimit,
    bonusUsed,
    bonusLimit,
    bonusCount: bonuses.length,
    resourceType: (credit?.resourceType || credit?.type || 'CREDIT').toUpperCase(),
    overageCapability: sub?.overageCapability,
    upgradeCapability: sub?.upgradeCapability,
    overageStatus: overage?.overageStatus || (overage?.overageEnabled != null
      ? (overage.overageEnabled ? 'ENABLED' : 'DISABLED')
      : undefined),
    userId: raw.userInfo?.userId,
    userEmail: raw.userInfo?.email,
    raw,
    endpoint,
  }
}

/** Persistable subset for AccountRecord.quotaDetail */
export function quotaDetailFromCredit(q: CreditQuota): AccountQuotaDetail {
  return {
    baseUsed: q.baseUsed,
    baseLimit: q.baseLimit,
    trialUsed: q.trialUsed,
    trialLimit: q.trialLimit,
    bonusUsed: q.bonusUsed,
    bonusLimit: q.bonusLimit,
    bonusCount: q.bonusCount,
    resourceType: q.resourceType,
    subscriptionTitle: q.subscriptionTitle,
    overageCapability: q.overageCapability,
    upgradeCapability: q.upgradeCapability,
    overageStatus: q.overageStatus,
    kiroUserId: q.userId,
    kiroEmail: q.userEmail,
    fetchedAt: Date.now(),
  }
}

/**
 * GET {q|codewhisperer}.{region}.amazonaws.com/getUsageLimits
 * Tries regional Q endpoint, EU/US fallback, then codewhisperer.us-east-1.
 */
export async function getUsageLimits(account: AccountRecord): Promise<CreditQuota> {
  if (!account.accessToken) {
    throw new UsageLimitsError('account has no accessToken')
  }

  const profileArn = profileArnForUsageLimits(account)
  const path = buildPath(profileArn)
  const region = account.region || 'us-east-1'
  const primary = restBaseForRegion(region)
  const candidates = [
    primary,
    fallbackRestBase(primary),
    'https://codewhisperer.us-east-1.amazonaws.com',
  ].filter((v, i, arr) => arr.indexOf(v) === i)

  let lastErr: UsageLimitsError | undefined
  for (const base of candidates) {
    const url = `${base}${path}`
    try {
      const res = await accountGet(account, url)
      const text = await res.text()
      if (!res.ok) {
        lastErr = new UsageLimitsError(
          `getUsageLimits HTTP ${res.status} @ ${base}`,
          res.status,
          text.slice(0, 500),
        )
        // try next on 403/404/5xx
        if (res.status === 401) throw lastErr
        continue
      }
      let raw: UsageLimitsResponse
      try {
        raw = JSON.parse(text) as UsageLimitsResponse
      } catch {
        throw new UsageLimitsError(`getUsageLimits invalid JSON @ ${base}`, res.status, text.slice(0, 200))
      }
      return creditQuotaFromUsageLimits(raw, base)
    } catch (err) {
      if (err instanceof UsageLimitsError && err.statusCode === 401) throw err
      lastErr =
        err instanceof UsageLimitsError
          ? err
          : new UsageLimitsError(err instanceof Error ? err.message : String(err))
    }
  }
  throw lastErr || new UsageLimitsError('getUsageLimits failed on all endpoints')
}
