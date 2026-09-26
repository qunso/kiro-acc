/**
 * Fetch Kiro / Amazon Q credit usage limits (GetUsageLimits REST).
 * Endpoint & response mapping adapted from chaogei/Kiro-account-manager (AGPL-3.0).
 * Includes per-account Machine ID in User-Agent (stable; no JA4/MITM).
 */
import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { AccountQuotaDetail, AccountRecord } from '../accounts/types.js'
import {
  buildKiroAmzUserAgent,
  buildKiroUserAgent,
  resolveMachineIdForRequest,
} from '../accounts/machineId.js'
import { getDispatcherForAccount } from '../net/outboundDispatcher.js'
import { isPlaceholderProfileArn, resolveProfileArn } from './auth.js'

/**
 * getUsageLimits is sensitive to KiroIDE UA major: live BuilderId accounts return
 * HTTP 200 with KiroIDE-0.6.18 (upstream registrar) but HTTP 400 "Invalid profileArn"
 * with KiroIDE-1.1.x even when profileArn is omitted. Chat/generateAssistantResponse
 * keeps live IDE version via getKiroIdeVersion(); only this REST path is pinned.
 *
 * Override with KIRO_USAGE_LIMITS_IDE_VERSION / KIRO_USAGE_LIMITS_AWS_SDK_VERSION.
 */
export const USAGE_LIMITS_KIRO_VERSION_DEFAULT = '0.6.18'
export const USAGE_LIMITS_AWS_SDK_VERSION_DEFAULT = '1.0.18'

export function usageLimitsKiroVersion(): string {
  return process.env.KIRO_USAGE_LIMITS_IDE_VERSION?.trim() || USAGE_LIMITS_KIRO_VERSION_DEFAULT
}

export function usageLimitsAwsSdkVersion(): string {
  return (
    process.env.KIRO_USAGE_LIMITS_AWS_SDK_VERSION?.trim() || USAGE_LIMITS_AWS_SDK_VERSION_DEFAULT
  )
}

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
  const machineId = resolveMachineIdForRequest(account)
  const kiroVersion = usageLimitsKiroVersion()
  const awsSdkVersion = usageLimitsAwsSdkVersion()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${account.accessToken}`,
    'user-agent': buildKiroUserAgent({
      kiroVersion,
      awsSdkVersion,
      machineId,
    }),
    'x-amz-user-agent': buildKiroAmzUserAgent({
      kiroVersion,
      awsSdkVersion,
      machineId,
    }),
    'amz-sdk-invocation-id': randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
  }
  if (account.authMethod === 'external_idp' || account.provider === 'ExternalIdp') {
    headers.TokenType = 'EXTERNAL_IDP'
  }
  return headers
}

/**
 * Account-bound GET: sticky outbound exit via getDispatcherForAccount (same SS/undici
 * path as chat + OIDC refresh) so TLS/JA4 stays consistent. Never bare global-only
 * fetch when the account has outboundProxyUrl.
 */
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
function aggregateUsageLimitsErrors(errors: UsageLimitsError[]): UsageLimitsError {
  if (errors.length === 0) {
    return new UsageLimitsError('getUsageLimits failed on all endpoints')
  }
  // Prefer Amazon Q host failure over codewhisperer fallback — CW often repeats the
  // same 400 Invalid profileArn and would otherwise become the misleading final error.
  const preferred =
    errors.find((e) => /@ https:\/\/q\./.test(e.message)) || errors[0]!
  if (errors.length === 1) return preferred
  const tried = errors.map((e) => e.message.replace(/^getUsageLimits /, '')).join('; ')
  return new UsageLimitsError(
    `${preferred.message} (also tried: ${tried})`,
    preferred.statusCode,
    preferred.body,
  )
}

export async function getUsageLimits(account: AccountRecord): Promise<CreditQuota> {
  if (!account.accessToken) {
    throw new UsageLimitsError('account has no accessToken')
  }

  const profileArn = profileArnForUsageLimits(account)
  const path = buildPath(profileArn)
  const region = account.region || 'us-east-1'
  const primary = restBaseForRegion(region)
  // Prefer q.us-east-1 / q.eu-central-1 (upstream); codewhisperer is last-resort only.
  const candidates = [
    primary,
    fallbackRestBase(primary),
    'https://codewhisperer.us-east-1.amazonaws.com',
  ].filter((v, i, arr) => arr.indexOf(v) === i)

  const errors: UsageLimitsError[] = []
  for (const base of candidates) {
    const url = `${base}${path}`
    try {
      const res = await accountGet(account, url)
      const text = await res.text()
      if (!res.ok) {
        const err = new UsageLimitsError(
          `getUsageLimits HTTP ${res.status} @ ${base}`,
          res.status,
          text.slice(0, 500),
        )
        errors.push(err)
        // try next on 403/404/5xx / 400; auth failure is fatal
        if (res.status === 401) throw err
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
      errors.push(
        err instanceof UsageLimitsError
          ? err
          : new UsageLimitsError(err instanceof Error ? err.message : String(err)),
      )
    }
  }
  throw aggregateUsageLimitsErrors(errors)
}
