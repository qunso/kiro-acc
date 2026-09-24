import type { AccountStore } from '../accounts/store.js'
import type { UsageRecord } from '../accounts/types.js'
import { globalRequestLog, type ApiStyle } from './requestLog.js'

export interface ProxyLogExtra {
  method?: string
  path: string
  apiStyle: ApiStyle
  status: number
}

/** Persist usage + push in-memory request log ring buffer. */
export async function recordProxyUsage(
  store: AccountStore,
  usage: UsageRecord,
  extra: ProxyLogExtra,
): Promise<void> {
  await store.recordUsage(usage)
  globalRequestLog.push({
    method: extra.method || 'POST',
    path: extra.path,
    apiStyle: extra.apiStyle,
    model: usage.model,
    accountId: usage.accountId,
    apiKeyId: usage.apiKeyId,
    apiKeyLabel: usage.apiKeyLabel,
    status: extra.status,
    success: usage.success,
    latencyMs: usage.responseTimeMs,
    error: usage.error,
    ts: usage.timestamp,
  })
}
