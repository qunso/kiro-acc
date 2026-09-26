/**
 * Post-import enrichment: auto-bind sticky exit + best-effort quota fetch.
 * Network calls use account outbound dispatcher (same JA4 path as chat).
 */
import type { AccountStore } from './store.js'
import type { AccountRecord } from './types.js'
import { pickStoredMachineId } from './machineId.js'
import { resolveUpstreamType } from './upstream.js'
import type { ExitsStore } from '../exits/store.js'
import type { PoolsStore } from '../pools/store.js'
import { assignAccountToPool } from '../pools/rebind.js'
import { resolveDefaultPool } from '../pools/defaultPool.js'
import { refreshAccountToken } from '../kiro/auth.js'
import {
  getUsageLimits,
  quotaDetailFromCredit,
  UsageLimitsError,
} from '../kiro/usageLimits.js'

export interface ImportAccountSummary {
  id: string
  action: 'created' | 'updated' | 'failed' | 'skipped'
  label?: string
  email?: string
  provider?: string
  authMethod?: string
  upstreamType?: string
  machineId?: string
  deviceId?: string
  outboundPoolId?: string | null
  outboundExitId?: string | null
  exitIp?: string | null
  unbound?: boolean
  autoBound?: boolean
  autoBindError?: string | null
  quotaFetched?: boolean
  quotaUsed?: number | null
  quotaLimit?: number | null
  subscriptionTitle?: string | null
  quotaError?: string | null
  error?: string
}

export interface ImportPostProcessDeps {
  accounts: AccountStore
  exits?: ExitsStore
  pools?: PoolsStore
}

function isKiroAccount(acc: AccountRecord): boolean {
  return resolveUpstreamType(acc) === 'kiro'
}

function formatUsageError(err: unknown): string {
  if (err instanceof UsageLimitsError) {
    return err.message + (err.body ? `: ${err.body.slice(0, 180)}` : '')
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Auto-bind exit for newly created Kiro accounts missing outboundExitId.
 * Does not change accounts that already have an explicit exit.
 * If outboundPoolId is set but exit is missing, assign within that pool.
 * Otherwise use resolveDefaultPool when available.
 */
export async function maybeAutoBindImportedAccount(
  account: AccountRecord,
  deps: ImportPostProcessDeps,
  opts: { isNew: boolean },
): Promise<{ account: AccountRecord; autoBound: boolean; autoBindError?: string }> {
  if (!opts.isNew) return { account, autoBound: false }
  if (!isKiroAccount(account)) return { account, autoBound: false }
  if (account.outboundExitId?.trim()) return { account, autoBound: false }
  if (!deps.exits || !deps.pools) {
    return { account, autoBound: false, autoBindError: 'exits/pools not configured' }
  }

  const poolId =
    account.outboundPoolId?.trim() || resolveDefaultPool(deps.pools)?.id
  if (!poolId) {
    return { account, autoBound: false }
  }

  const result = await assignAccountToPool(account, poolId, {
    accounts: deps.accounts,
    exits: deps.exits,
    pools: deps.pools,
  })
  const live = deps.accounts.get(account.id) || account
  if (!result.ok) {
    return {
      account: live,
      autoBound: false,
      autoBindError: result.error || 'auto-bind failed',
    }
  }
  return { account: live, autoBound: true }
}

/**
 * Best-effort token refresh + getUsageLimits for Kiro accounts.
 * Failures are returned as quotaError; never thrown.
 * Uses account outboundProxyUrl via getDispatcherForAccount inside those calls.
 */
export async function maybeFetchQuotaOnImport(
  account: AccountRecord,
  deps: ImportPostProcessDeps,
): Promise<{
  account: AccountRecord
  quotaFetched: boolean
  quotaError?: string
}> {
  if (!isKiroAccount(account)) {
    return { account, quotaFetched: false }
  }
  // Need refreshToken and/or accessToken
  if (!account.accessToken && !account.refreshToken) {
    return { account, quotaFetched: false, quotaError: 'no accessToken/refreshToken' }
  }

  try {
    let live = deps.accounts.get(account.id) || account
    if (live.refreshToken) {
      const refreshed = await refreshAccountToken(live)
      if (refreshed.success && refreshed.accessToken) {
        await deps.accounts.applyTokenRefresh(live.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        })
        deps.accounts.pool.updateAccount(live.id, { isAvailable: true })
        live = deps.accounts.get(live.id) || live
      } else if (!live.accessToken) {
        return {
          account: live,
          quotaFetched: false,
          quotaError: refreshed.error || 'token refresh failed',
        }
      }
      // If refresh failed but we still have accessToken, try usage limits anyway.
    }

    live = deps.accounts.get(account.id) || live
    if (!live.accessToken) {
      return { account: live, quotaFetched: false, quotaError: 'no accessToken after refresh' }
    }

    const quota = await getUsageLimits(live)
    const detail = quotaDetailFromCredit(quota)
    await deps.accounts.applyQuota(live.id, quota.used, quota.limit, quota.resetAt, detail)
    live = deps.accounts.get(live.id) || live
    return { account: live, quotaFetched: true }
  } catch (err) {
    const live = deps.accounts.get(account.id) || account
    return { account: live, quotaFetched: false, quotaError: formatUsageError(err) }
  }
}

export function summarizeImportedAccount(
  account: AccountRecord | undefined,
  base: {
    id: string
    action: ImportAccountSummary['action']
    error?: string
    autoBound?: boolean
    autoBindError?: string
    quotaFetched?: boolean
    quotaError?: string
  },
  exits?: ExitsStore,
): ImportAccountSummary {
  if (!account) {
    return {
      id: base.id,
      action: base.action,
      error: base.error || 'account missing',
      unbound: true,
    }
  }
  const exit = account.outboundExitId ? exits?.getEntry(account.outboundExitId) : undefined
  const machineId = pickStoredMachineId(account)
  const unbound = !account.outboundExitId && !account.outboundPoolId
  return {
    id: account.id,
    action: base.action,
    label: account.label,
    email: account.email,
    provider: account.provider,
    authMethod: account.authMethod,
    upstreamType: resolveUpstreamType(account),
    machineId,
    deviceId: account.deviceId || machineId,
    outboundPoolId: account.outboundPoolId ?? null,
    outboundExitId: account.outboundExitId ?? null,
    exitIp: exit?.exitIp || exit?.expectedExitIp || null,
    unbound,
    autoBound: base.autoBound || false,
    autoBindError: base.autoBindError || null,
    quotaFetched: base.quotaFetched || false,
    quotaUsed: account.quotaUsed ?? null,
    quotaLimit: account.quotaLimit ?? null,
    subscriptionTitle: account.subscriptionTitle ?? account.quotaDetail?.subscriptionTitle ?? null,
    quotaError: base.quotaError || null,
    error: base.error,
  }
}
