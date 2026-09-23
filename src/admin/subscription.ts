import type { AccountRecord, UsageStore } from '../accounts/types.js'

export interface AccountSubscriptionRow {
  id: string
  label: string
  email?: string
  enabled: boolean
  suspended: boolean
  /** Derived from provider / authMethod (no remote subscription API). */
  subscriptionType: string
  tokenExpiresAt?: number
  tokenExpired: boolean
  tokenExpiringSoon: boolean
  quotaUsed: number
  quotaLimit: number
  quotaRatio: number | null
  quotaExhausted: boolean
  nearLimit: boolean
  usageRequests: number
  usageTokens: number
  usageErrors: number
  lastUsed?: number
}

export interface SubscriptionSummary {
  total: number
  enabled: number
  disabled: number
  suspended: number
  nearLimit: number
  exhausted: number
  tokenExpiringSoon: number
  rows: AccountSubscriptionRow[]
}

const NEAR_LIMIT_RATIO = 0.8
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000

export function deriveSubscriptionType(acc: AccountRecord): string {
  const provider = (acc.provider || '').trim()
  const method = (acc.authMethod || '').trim()
  if (provider && method) return `${provider} / ${method}`
  if (provider) return provider
  if (method) return method
  return 'unknown'
}

export function buildSubscriptionSummary(
  accounts: AccountRecord[],
  opts?: { nearLimitRatio?: number; expiringSoonMs?: number; now?: number },
): SubscriptionSummary {
  const now = opts?.now ?? Date.now()
  const nearRatio = opts?.nearLimitRatio ?? NEAR_LIMIT_RATIO
  const soonMs = opts?.expiringSoonMs ?? EXPIRING_SOON_MS

  const rows: AccountSubscriptionRow[] = accounts.map((acc) => {
    const quotaUsed = acc.quotaUsed ?? 0
    const quotaLimit = acc.quotaLimit ?? 0
    const quotaRatio = quotaLimit > 0 ? quotaUsed / quotaLimit : null
    const quotaExhausted = Boolean(
      acc.quotaExhaustedAt ||
        (quotaLimit > 0 && quotaUsed >= quotaLimit),
    )
    const nearLimit =
      !quotaExhausted && quotaRatio != null && quotaRatio >= nearRatio
    const tokenExpiresAt = acc.expiresAt
    const tokenExpired = Boolean(tokenExpiresAt && tokenExpiresAt <= now)
    const tokenExpiringSoon = Boolean(
      tokenExpiresAt && !tokenExpired && tokenExpiresAt - now <= soonMs,
    )
    const stats = acc.stats
    return {
      id: acc.id,
      label: acc.label || acc.email || acc.id,
      email: acc.email,
      enabled: acc.enabled !== false,
      suspended: Boolean(acc.suspended),
      subscriptionType: deriveSubscriptionType(acc),
      tokenExpiresAt,
      tokenExpired,
      tokenExpiringSoon,
      quotaUsed,
      quotaLimit,
      quotaRatio,
      quotaExhausted,
      nearLimit,
      usageRequests: stats?.requests ?? acc.requestCount ?? 0,
      usageTokens: stats?.tokens ?? 0,
      usageErrors: stats?.errors ?? acc.errorCount ?? 0,
      lastUsed: stats?.lastUsed || acc.lastUsed,
    }
  })

  return {
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    disabled: rows.filter((r) => !r.enabled).length,
    suspended: rows.filter((r) => r.suspended).length,
    nearLimit: rows.filter((r) => r.nearLimit).length,
    exhausted: rows.filter((r) => r.quotaExhausted).length,
    tokenExpiringSoon: rows.filter((r) => r.tokenExpiringSoon || r.tokenExpired).length,
    rows,
  }
}

/** Per-account usage rollup from persisted usage.json (optional enrichment). */
export function usageByAccount(usage: UsageStore): Record<
  string,
  { requests: number; success: number; failed: number; inputTokens: number; outputTokens: number }
> {
  const out: Record<
    string,
    { requests: number; success: number; failed: number; inputTokens: number; outputTokens: number }
  > = {}
  for (const rec of usage.records || []) {
    const cur = out[rec.accountId] || {
      requests: 0,
      success: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    cur.requests++
    if (rec.success) cur.success++
    else cur.failed++
    cur.inputTokens += rec.inputTokens || 0
    cur.outputTokens += rec.outputTokens || 0
    out[rec.accountId] = cur
  }
  return out
}
