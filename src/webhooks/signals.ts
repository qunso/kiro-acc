import type { AccountStore } from '../accounts/store.js'
import type { ExitsStore } from '../exits/store.js'
import { notifyEvent } from './dispatch.js'
import { getGlobalWebhookStore } from './dispatch.js'

let lastAllQuotaNotifyAt = 0
const ALL_QUOTA_COOLDOWN_MS = 5 * 60 * 1000

export async function signalAccountSuspended(accountId: string, reason: string, message?: string): Promise<void> {
  await notifyEvent({
    event: 'account_suspended',
    title: 'Account suspended',
    text: `account=${accountId}\nreason=${reason}\n${message || ''}`.trim(),
    data: { accountId, reason, message },
  })
}

export async function signalRefreshFailed(accountId: string, error: string): Promise<void> {
  await notifyEvent({
    event: 'refresh_failed',
    title: 'Token refresh failed',
    text: `account=${accountId}\nerror=${error}`,
    data: { accountId, error },
  })
}

export async function signalDiagnoseFailed(accountId: string, error: string): Promise<void> {
  await notifyEvent({
    event: 'diagnose_failed',
    title: 'Diagnose failed',
    text: `account=${accountId}\nerror=${error}`,
    data: { accountId, error },
  })
}

export async function maybeSignalAllQuotaExhausted(store: AccountStore): Promise<void> {
  const status = store.pool.getQuotaStatus()
  // Only when every enabled account is exhausted/suspended (none available)
  if (status.total === 0 || status.available > 0) return
  if (status.exhausted + status.suspended < status.total) return
  const now = Date.now()
  if (now - lastAllQuotaNotifyAt < ALL_QUOTA_COOLDOWN_MS) return
  lastAllQuotaNotifyAt = now
  await notifyEvent({
    event: 'all_quota_exhausted',
    title: 'All account quota exhausted',
    text: `total=${status.total} exhausted=${status.exhausted} suspended=${status.suspended} available=${status.available}`,
    data: { ...status },
  })
}

export async function maybeSignalExitConsecutiveFailures(
  exits: ExitsStore | undefined,
  exitId: string | undefined,
): Promise<void> {
  if (!exits || !exitId) return
  const entry = exits.getEntry(exitId)
  if (!entry) return
  const threshold = getGlobalWebhookStore()?.getExitFailThreshold() ?? 3
  const count = entry.consecutiveFailCount ?? 0
  if (count < threshold) return
  // Fire when crossing the threshold exactly to limit spam
  if (count !== threshold && count % threshold !== 0) return
  await notifyEvent({
    event: 'exit_consecutive_failures',
    title: 'Exit consecutive failures',
    text: `exit=${exitId} consecutiveFailCount=${count} threshold=${threshold} banCount=${entry.banCount ?? 0}`,
    data: { exitId, consecutiveFailCount: count, threshold, banCount: entry.banCount ?? 0 },
  })
}

/** Test helper to reset debounce. */
export function resetSignalCooldowns(): void {
  lastAllQuotaNotifyAt = 0
}
