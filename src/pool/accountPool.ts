import type { AccountRecord, AccountStats } from '../accounts/types.js'

export enum ErrorType {
  FATAL = 'fatal',
  RECOVERABLE = 'recoverable',
}

export function classifyError(statusCode: number, reason?: string): ErrorType {
  if (statusCode === 402) return ErrorType.RECOVERABLE
  if (statusCode === 403) return ErrorType.RECOVERABLE
  if (statusCode === 429) return ErrorType.RECOVERABLE
  if (statusCode === 400) {
    if (reason === 'CONTENT_LENGTH_EXCEEDS_THRESHOLD') return ErrorType.FATAL
    return ErrorType.FATAL
  }
  if (statusCode === 422) return ErrorType.FATAL
  if (statusCode >= 500) return ErrorType.FATAL
  return ErrorType.FATAL
}

export interface AccountPoolConfig {
  baseCooldownMs: number
  maxBackoffMultiplier: number
  quotaResetMs: number
  probabilisticRetryChance: number
}

const DEFAULT_CONFIG: AccountPoolConfig = {
  baseCooldownMs: 60_000,
  maxBackoffMultiplier: 1440,
  quotaResetMs: 3_600_000,
  probabilisticRetryChance: 0.1,
}

export type AccountSelectionStrategy = 'round-robin' | 'sticky'

function emptyStats(): AccountStats {
  return {
    requests: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: 0,
    lastUsed: 0,
    avgResponseTime: 0,
    totalResponseTime: 0,
  }
}

/** Pool-facing account shape (subset of AccountRecord with runtime fields). */
export type PoolAccount = AccountRecord

export class AccountPool {
  private accounts = new Map<string, PoolAccount>()
  private accountStats = new Map<string, AccountStats>()
  private currentIndex = 0
  private config: AccountPoolConfig
  private strategy: AccountSelectionStrategy = 'round-robin'

  constructor(config: Partial<AccountPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  setConfig(partial: Partial<AccountPoolConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  getConfig(): AccountPoolConfig {
    return { ...this.config }
  }

  setStrategy(strategy: AccountSelectionStrategy): void {
    if (this.strategy !== strategy) {
      console.log(`[AccountPool] Strategy changed: ${this.strategy} → ${strategy}`)
      this.strategy = strategy
    }
  }

  getStrategy(): AccountSelectionStrategy {
    return this.strategy
  }

  addAccount(account: PoolAccount): void {
    const suspended = this.isSuspended(account) || account.suspended === true
    this.accounts.set(account.id, {
      ...account,
      isAvailable: account.enabled !== false && !suspended,
      requestCount: account.requestCount ?? 0,
      errorCount: account.errorCount ?? 0,
      lastUsed: account.lastUsed ?? 0,
    })
    if (!this.accountStats.has(account.id)) {
      this.accountStats.set(account.id, account.stats ?? emptyStats())
    }
  }

  removeAccount(accountId: string): void {
    this.accounts.delete(accountId)
    this.accountStats.delete(accountId)
  }

  updateAccount(accountId: string, updates: Partial<PoolAccount>): void {
    const account = this.accounts.get(accountId)
    if (!account) return
    this.accounts.set(accountId, { ...account, ...updates })
  }

  getNextAccount(excludeIds?: Set<string>): PoolAccount | null {
    const accountList = Array.from(this.accounts.values()).filter((a) => a.enabled !== false)
    if (accountList.length === 0) return null

    if (accountList.length === 1) {
      const account = accountList[0]!
      if (excludeIds?.has(account.id)) return null
      return account
    }

    const now = Date.now()
    const startIndex = this.currentIndex

    for (let i = 0; i < accountList.length; i++) {
      const idx = (startIndex + i) % accountList.length
      const account = accountList[idx]!
      if (excludeIds?.has(account.id)) continue
      if (this.isAccountAvailable(account, now)) return account
    }

    const candidates = excludeIds
      ? accountList.filter((a) => !excludeIds.has(a.id))
      : accountList
    const allExhausted =
      candidates.length > 0 && candidates.every((a) => this.isQuotaExhausted(a, now))
    if (allExhausted) return null

    const nonExhausted = candidates.filter((a) => !this.isQuotaExhausted(a, now))
    return this.getAccountWithShortestCooldown(nonExhausted, now)
  }

  getAccount(accountId: string): PoolAccount | null {
    return this.accounts.get(accountId) || null
  }

  getNextAvailableAccount(exclude: string | Set<string>): PoolAccount | null {
    const excludeSet = typeof exclude === 'string' ? new Set([exclude]) : exclude
    return this.getNextAccount(excludeSet)
  }

  getAllAccounts(): PoolAccount[] {
    return Array.from(this.accounts.values())
  }

  private isAccountAvailable(
    account: PoolAccount,
    now: number,
    allowProbabilisticRetry = true,
  ): boolean {
    if (account.enabled === false) return false
    if (this.isSuspended(account) || account.suspended === true) return false
    if (this.isQuotaExhausted(account, now)) return false

    if (account.expiresAt && account.expiresAt < now && !account.refreshToken) {
      return false
    }

    if (account.isAvailable === false) return false

    const failures = account.errorCount || 0
    if (failures > 0 && account.lastUsed) {
      const timeSinceFailure = now - account.lastUsed
      const backoffMultiplier = Math.min(
        Math.pow(2, failures - 1),
        this.config.maxBackoffMultiplier,
      )
      const effectiveCooldown = this.config.baseCooldownMs * backoffMultiplier

      if (timeSinceFailure < effectiveCooldown) {
        if (!allowProbabilisticRetry) return false
        if (Math.random() > this.config.probabilisticRetryChance) return false
      }
    }

    return true
  }

  isSuspended(account: PoolAccount): boolean {
    return typeof account.suspendedAt === 'number' && account.suspendedAt > 0
  }

  markSuspended(accountId: string, reason: string, message?: string): boolean {
    const account = this.accounts.get(accountId)
    if (!account) return false
    if (this.isSuspended(account) && account.suspendReason === reason) return false
    this.accounts.set(accountId, {
      ...account,
      suspended: true,
      suspendedAt: Date.now(),
      suspendReason: reason,
      suspendMessage: message,
      isAvailable: false,
    })
    return true
  }

  clearSuspended(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (!account || !this.isSuspended(account)) return
    this.accounts.set(accountId, {
      ...account,
      suspended: false,
      suspendedAt: undefined,
      suspendReason: undefined,
      suspendMessage: undefined,
      isAvailable: true,
      errorCount: 0,
    })
  }

  isQuotaExhausted(account: PoolAccount, now: number = Date.now()): boolean {
    if (account.quotaResetAt && account.quotaResetAt <= now) return false
    if (account.quotaExhaustedAt && account.quotaExhaustedAt > 0) return true
    if (
      account.quotaLimit &&
      account.quotaLimit > 0 &&
      (account.quotaUsed ?? 0) >= account.quotaLimit
    ) {
      return true
    }
    return false
  }

  private getAccountWithShortestCooldown(
    accounts: PoolAccount[],
    now: number,
  ): PoolAccount | null {
    let bestAccount: PoolAccount | null = null
    let shortestWait = Infinity

    for (const account of accounts) {
      const failures = account.errorCount || 0
      let wait = 0
      if (failures > 0 && account.lastUsed) {
        const backoffMultiplier = Math.min(
          Math.pow(2, failures - 1),
          this.config.maxBackoffMultiplier,
        )
        const effectiveCooldown = this.config.baseCooldownMs * backoffMultiplier
        wait = Math.max(0, account.lastUsed + effectiveCooldown - now)
      }
      if (account.cooldownUntil) {
        wait = Math.max(wait, account.cooldownUntil - now)
      }
      if (wait < shortestWait) {
        shortestWait = wait
        bestAccount = account
      }
    }
    return bestAccount
  }

  recordSuccess(
    accountId: string,
    tokens = 0,
    inputTokens = 0,
    outputTokens = 0,
    responseTimeMs = 0,
  ): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        requestCount: (account.requestCount || 0) + 1,
        errorCount: 0,
        lastUsed: Date.now(),
        isAvailable: true,
      })

      const accountList = Array.from(this.accounts.keys())
      const successIndex = accountList.indexOf(accountId)
      if (successIndex >= 0 && accountList.length > 0) {
        if (this.strategy === 'sticky') {
          this.currentIndex = successIndex
        } else {
          this.currentIndex = (successIndex + 1) % accountList.length
        }
      }
    }

    const stats = this.accountStats.get(accountId) ?? emptyStats()
    const totalResponseTime = stats.totalResponseTime + responseTimeMs
    const requests = stats.requests + 1
    this.accountStats.set(accountId, {
      ...stats,
      requests,
      tokens: stats.tokens + tokens,
      inputTokens: stats.inputTokens + inputTokens,
      outputTokens: stats.outputTokens + outputTokens,
      lastUsed: Date.now(),
      totalResponseTime,
      avgResponseTime: totalResponseTime / requests,
    })
  }

  recordError(
    accountId: string,
    errorType: ErrorType = ErrorType.RECOVERABLE,
    statusCode?: number,
  ): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    const now = Date.now()
    const stats = this.accountStats.get(accountId) ?? emptyStats()
    this.accountStats.set(accountId, { ...stats, errors: stats.errors + 1, lastUsed: now })

    if (errorType === ErrorType.FATAL) return

    const errorCount = (account.errorCount || 0) + 1
    let quotaExhaustedAt = account.quotaExhaustedAt
    let quotaResetAt = account.quotaResetAt

    const isQuotaError = statusCode === 402 || statusCode === 429
    if (isQuotaError) {
      quotaExhaustedAt = now
      if (!quotaResetAt || quotaResetAt <= now) {
        quotaResetAt = now + this.config.quotaResetMs
      }
    }

    this.accounts.set(accountId, {
      ...account,
      errorCount,
      quotaExhaustedAt,
      quotaResetAt,
      lastUsed: now,
    })
  }

  updateQuota(
    accountId: string,
    used: number,
    limit: number,
    resetAt?: number,
    detail?: AccountRecord['quotaDetail'],
  ): void {
    const account = this.accounts.get(accountId)
    if (!account) return
    this.accounts.set(accountId, {
      ...account,
      quotaUsed: used,
      quotaLimit: limit,
      quotaResetAt: resetAt,
      quotaExhaustedAt: used < limit ? undefined : account.quotaExhaustedAt,
      ...(detail
        ? {
            quotaDetail: detail,
            subscriptionTitle: detail.subscriptionTitle ?? account.subscriptionTitle,
          }
        : {}),
    })
  }

  getQuotaStatus(): {
    total: number
    available: number
    exhausted: number
    cooldown: number
    suspended: number
  } {
    const now = Date.now()
    const all = Array.from(this.accounts.values()).filter((a) => a.enabled !== false)
    let available = 0
    let exhausted = 0
    let cooldown = 0
    let suspended = 0

    for (const account of all) {
      if (this.isSuspended(account) || account.suspended) {
        suspended++
      } else if (this.isQuotaExhausted(account, now)) {
        exhausted++
      } else if (account.cooldownUntil && account.cooldownUntil > now) {
        cooldown++
      } else if (this.isAccountAvailable(account, now, false)) {
        available++
      } else {
        cooldown++
      }
    }

    return { total: all.length, available, exhausted, cooldown, suspended }
  }

  markNeedsRefresh(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, { ...account, isAvailable: false })
    }
  }

  getStats(): {
    accounts: Map<string, AccountStats>
    total: { requests: number; tokens: number; errors: number }
  } {
    let totalRequests = 0
    let totalTokens = 0
    let totalErrors = 0
    for (const stats of this.accountStats.values()) {
      totalRequests += stats.requests
      totalTokens += stats.tokens
      totalErrors += stats.errors
    }
    return {
      accounts: new Map(this.accountStats),
      total: { requests: totalRequests, tokens: totalTokens, errors: totalErrors },
    }
  }

  getAccountStats(accountId: string): AccountStats | undefined {
    return this.accountStats.get(accountId)
  }

  reset(): void {
    for (const [id, account] of this.accounts) {
      this.accounts.set(id, {
        ...account,
        isAvailable: true,
        errorCount: 0,
        cooldownUntil: undefined,
        quotaExhaustedAt: undefined,
        suspended: false,
        suspendedAt: undefined,
        suspendReason: undefined,
        suspendMessage: undefined,
      })
    }
    this.currentIndex = 0
  }

  clear(): void {
    this.accounts.clear()
    this.accountStats.clear()
    this.currentIndex = 0
  }

  get size(): number {
    return this.accounts.size
  }

  get availableCount(): number {
    const now = Date.now()
    let count = 0
    for (const account of this.accounts.values()) {
      if (this.isAccountAvailable(account, now, false)) count++
    }
    return count
  }
}
