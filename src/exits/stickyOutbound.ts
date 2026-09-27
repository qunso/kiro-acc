/**
 * Resolve the sticky outbound proxy URL for an account so that
 * admin tests (chat-test / diagnose / tls-probe) and live chat share
 * the SAME exit path — never env ALL_PROXY / direct when an exit is bound.
 */
import type { AccountRecord } from '../accounts/types.js'
import type { AccountStore } from '../accounts/store.js'
import type { ExitsStore } from './store.js'
import { resolveOutboundProxyUrl } from '../net/outboundDispatcher.js'

export interface StickyOutboundResult {
  account: AccountRecord
  proxyUrl?: string
  exitId?: string
  poolId?: string
  /** Where the proxy URL came from */
  source: 'exit' | 'account' | 'env' | 'none'
  /** True when account.outboundProxyUrl was updated to match the exit */
  synced: boolean
}

/**
 * Prefer the bound exit's ensureProxyUrl (same path as exit IP probe).
 * Fall back to account.outboundProxyUrl, then env proxy — only when unbound.
 */
export async function ensureAccountStickyOutbound(
  account: AccountRecord,
  deps: { accounts?: AccountStore; exits?: ExitsStore },
): Promise<StickyOutboundResult> {
  const exitId = account.outboundExitId?.trim() || undefined
  const poolId = account.outboundPoolId?.trim() || undefined

  if (exitId && deps.exits) {
    const proxyUrl = await deps.exits.ensureProxyUrl(exitId)
    let synced = false
    let live = account
    if (deps.accounts && proxyUrl && proxyUrl !== account.outboundProxyUrl) {
      await deps.accounts.update(account.id, { outboundProxyUrl: proxyUrl })
      live = deps.accounts.get(account.id) || { ...account, outboundProxyUrl: proxyUrl }
      synced = true
    } else if (proxyUrl && proxyUrl !== account.outboundProxyUrl) {
      live = { ...account, outboundProxyUrl: proxyUrl }
      synced = true
    }
    return {
      account: live,
      proxyUrl,
      exitId,
      poolId,
      source: 'exit',
      synced,
    }
  }

  if (account.outboundProxyUrl?.trim()) {
    return {
      account,
      proxyUrl: account.outboundProxyUrl.trim(),
      exitId,
      poolId,
      source: 'account',
      synced: false,
    }
  }

  const envUrl = resolveOutboundProxyUrl(null)
  if (envUrl) {
    return {
      account,
      proxyUrl: envUrl,
      exitId,
      poolId,
      source: 'env',
      synced: false,
    }
  }

  return { account, proxyUrl: undefined, exitId, poolId, source: 'none', synced: false }
}
