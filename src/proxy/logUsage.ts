import type { AccountStore } from '../accounts/store.js'
import type { UsageRecord } from '../accounts/types.js'
import type { ExitsStore } from '../exits/store.js'
import { globalRequestLog, type ApiStyle } from './requestLog.js'

export interface ProxyLogExtra {
  method?: string
  path: string
  apiStyle: ApiStyle
  status: number
}

/** Optional exits catalog — bound from createServer so usage rows can record exit IP. */
let usageExitsStore: ExitsStore | undefined

export function bindUsageExitsStore(exits?: ExitsStore): void {
  usageExitsStore = exits
}

/** Resolve account label + sticky exit fields for a usage row (does not overwrite caller-provided values). */
export function enrichUsageMeta(store: AccountStore, usage: UsageRecord): UsageRecord {
  const acc = store.get(usage.accountId)
  const exitId = usage.exitId || acc?.outboundExitId
  const exit = exitId && usageExitsStore ? usageExitsStore.getEntry(exitId) : undefined
  const exitIp =
    usage.exitIp ||
    exit?.exitIp ||
    exit?.expectedExitIp ||
    undefined
  const accountLabel =
    usage.accountLabel ||
    (acc?.label && acc.label.trim()) ||
    (acc?.email && acc.email.trim()) ||
    undefined
  return {
    ...usage,
    accountLabel,
    exitId,
    exitIp,
  }
}

/** Persist usage + push in-memory request log ring buffer. */
export async function recordProxyUsage(
  store: AccountStore,
  usage: UsageRecord,
  extra: ProxyLogExtra,
): Promise<void> {
  const enriched = enrichUsageMeta(store, usage)
  await store.recordUsage(enriched)
  globalRequestLog.push({
    method: extra.method || 'POST',
    path: extra.path,
    apiStyle: extra.apiStyle,
    model: enriched.model,
    accountId: enriched.accountId,
    accountLabel: enriched.accountLabel,
    apiKeyId: enriched.apiKeyId,
    apiKeyLabel: enriched.apiKeyLabel,
    exitId: enriched.exitId,
    exitIp: enriched.exitIp,
    status: extra.status,
    success: enriched.success,
    latencyMs: enriched.responseTimeMs,
    error: enriched.error,
    ts: enriched.timestamp,
  })
}
