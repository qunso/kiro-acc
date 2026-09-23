import type { AccountStore } from '../accounts/store.js'
import type { AccountRecord } from '../accounts/types.js'
import {
  DEFAULT_BAN_COOLDOWN_MS,
  type ExitsStore,
} from '../exits/store.js'
import type { PoolsStore } from './store.js'
import { pickExitFromPool } from './select.js'
import { maybeSignalExitConsecutiveFailures } from '../webhooks/signals.js'

export interface RebindResult {
  ok: boolean
  accountId: string
  previousExitId?: string
  exitId?: string
  outboundProxyUrl?: string
  poolId?: string
  error?: string
}

/**
 * After a ban/suspend: bumpBan on current exit (short cooldown), then pick next
 * eligible exit in the same pool. Never throws — caller should log and continue.
 */
export async function rebindAccountExitAfterBan(
  account: AccountRecord,
  deps: {
    accounts: AccountStore
    exits: ExitsStore
    pools: PoolsStore
    cooldownMs?: number
    /** When false, skip bumpBan (manual rebind without ban) */
    bumpBan?: boolean
  },
): Promise<RebindResult> {
  const accountId = account.id
  const poolId = account.outboundPoolId
  const previousExitId = account.outboundExitId
  if (!poolId) {
    return { ok: false, accountId, previousExitId, error: 'account has no outboundPoolId' }
  }

  try {
    const pool = deps.pools.get(poolId)
    if (!pool || pool.disabled) {
      return { ok: false, accountId, previousExitId, poolId, error: 'pool missing or disabled' }
    }

    if (deps.bumpBan !== false && previousExitId) {
      try {
        await deps.exits.bumpBan(previousExitId, {
          cooldownMs: deps.cooldownMs ?? DEFAULT_BAN_COOLDOWN_MS,
        })
        void maybeSignalExitConsecutiveFailures(deps.exits, previousExitId)
      } catch (err) {
        console.warn(
          `[rebind] bumpBan failed for exit=${previousExitId}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    const members = deps.exits.listByIds(pool.exitIds)
    const exclude = previousExitId ? [previousExitId] : []
    const chosen = pickExitFromPool(accountId, members, { excludeIds: exclude })
    const outboundProxyUrl = await deps.exits.ensureProxyUrl(chosen.id)
    await deps.exits.bumpUse(chosen.id)
    await deps.accounts.update(accountId, {
      outboundPoolId: poolId,
      outboundExitId: chosen.id,
      outboundProxyUrl,
    })
    return {
      ok: true,
      accountId,
      previousExitId,
      exitId: chosen.id,
      outboundProxyUrl,
      poolId,
    }
  } catch (err) {
    return {
      ok: false,
      accountId,
      previousExitId,
      poolId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function assignAccountToPool(
  account: AccountRecord,
  poolId: string,
  deps: { accounts: AccountStore; exits: ExitsStore; pools: PoolsStore },
): Promise<RebindResult> {
  try {
    const pool = deps.pools.get(poolId)
    if (!pool) return { ok: false, accountId: account.id, poolId, error: 'unknown pool' }
    if (pool.disabled) return { ok: false, accountId: account.id, poolId, error: 'pool disabled' }
    const members = deps.exits.listByIds(pool.exitIds)
    const chosen = pickExitFromPool(account.id, members)
    const outboundProxyUrl = await deps.exits.ensureProxyUrl(chosen.id)
    await deps.exits.bumpUse(chosen.id)
    await deps.accounts.update(account.id, {
      outboundPoolId: poolId,
      outboundExitId: chosen.id,
      outboundProxyUrl,
    })
    return {
      ok: true,
      accountId: account.id,
      exitId: chosen.id,
      outboundProxyUrl,
      poolId,
    }
  } catch (err) {
    return {
      ok: false,
      accountId: account.id,
      poolId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
