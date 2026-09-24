import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  AccountCreateInput,
  AccountRecord,
  AccountUpdateInput,
  PersistedConfig,
  UsageRecord,
  UsageStore,
} from './types.js'
import { JsonStore } from '../storage/jsonStore.js'
import { AccountPool } from '../pool/accountPool.js'
import type { AppConfig } from '../config.js'

const emptyUsage = (): UsageStore => ({
  records: [],
  totals: { requests: 0, success: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
})

export class AccountStore {
  private accountsFile: JsonStore<AccountRecord[]>
  private configFile: JsonStore<PersistedConfig>
  private usageFile: JsonStore<UsageStore>
  readonly pool: AccountPool
  private accounts = new Map<string, AccountRecord>()
  private persistConfig: PersistedConfig = {}

  constructor(
    private readonly dataDir: string,
    private readonly appConfig: AppConfig,
  ) {
    this.accountsFile = new JsonStore(path.join(dataDir, 'accounts.json'), [])
    this.configFile = new JsonStore(path.join(dataDir, 'config.json'), {})
    this.usageFile = new JsonStore(path.join(dataDir, 'usage.json'), emptyUsage())
    this.pool = new AccountPool({
      baseCooldownMs: appConfig.baseCooldownMs,
      maxBackoffMultiplier: appConfig.maxBackoffMultiplier,
      quotaResetMs: appConfig.quotaResetMs,
      probabilisticRetryChance: appConfig.probabilisticRetryChance,
    })
    this.pool.setStrategy(appConfig.accountStrategy)
  }

  async init(): Promise<void> {
    const [accounts, persisted, usage] = await Promise.all([
      this.accountsFile.read(),
      this.configFile.read(),
      this.usageFile.read(),
    ])
    void usage

    this.persistConfig = { ...persisted }
    this.applyPersistedConfig()

    this.accounts.clear()
    this.pool.clear()
    for (const acc of accounts) {
      this.accounts.set(acc.id, acc)
      this.pool.addAccount(acc)
    }
    console.log(`[AccountStore] Loaded ${this.accounts.size} accounts from ${this.dataDir}`)
  }

  private applyPersistedConfig(): void {
    const c = this.persistConfig
    if (c.accountStrategy) this.pool.setStrategy(c.accountStrategy)
    this.pool.setConfig({
      baseCooldownMs: c.baseCooldownMs ?? this.appConfig.baseCooldownMs,
      maxBackoffMultiplier: c.maxBackoffMultiplier ?? this.appConfig.maxBackoffMultiplier,
      quotaResetMs: c.quotaResetMs ?? this.appConfig.quotaResetMs,
      probabilisticRetryChance:
        c.probabilisticRetryChance ?? this.appConfig.probabilisticRetryChance,
    })
  }

  getPersistedConfig(): PersistedConfig {
    return {
      accountStrategy: this.pool.getStrategy(),
      ...this.pool.getConfig(),
      tokenRefreshBeforeExpirySec:
        this.persistConfig.tokenRefreshBeforeExpirySec ??
        this.appConfig.tokenRefreshBeforeExpirySec,
      preferredEndpoint:
        this.persistConfig.preferredEndpoint ?? this.appConfig.preferredEndpoint,
      maxRetries: this.persistConfig.maxRetries ?? this.appConfig.maxRetries,
    }
  }

  async patchConfig(patch: PersistedConfig): Promise<PersistedConfig> {
    this.persistConfig = { ...this.persistConfig, ...patch }
    await this.configFile.write(this.persistConfig)
    this.applyPersistedConfig()
    return this.getPersistedConfig()
  }

  list(): AccountRecord[] {
    return Array.from(this.accounts.values()).map((a) => this.withStats(a))
  }

  get(id: string): AccountRecord | undefined {
    const a = this.accounts.get(id)
    return a ? this.withStats(a) : undefined
  }

  private withStats(a: AccountRecord): AccountRecord {
    return { ...a, stats: this.pool.getAccountStats(a.id) }
  }

  private async persist(): Promise<void> {
    const list = Array.from(this.accounts.values()).map((a) => {
      const { stats: _s, ...rest } = a
      return {
        ...rest,
        ...this.poolSnapshot(a.id),
      }
    })
    await this.accountsFile.write(list)
  }

  private poolSnapshot(id: string): Partial<AccountRecord> {
    const p = this.pool.getAccount(id)
    if (!p) return {}
    return {
      lastUsed: p.lastUsed,
      requestCount: p.requestCount,
      errorCount: p.errorCount,
      isAvailable: p.isAvailable,
      cooldownUntil: p.cooldownUntil,
      quotaUsed: p.quotaUsed,
      quotaLimit: p.quotaLimit,
      quotaExhaustedAt: p.quotaExhaustedAt,
      quotaResetAt: p.quotaResetAt,
      quotaDetail: p.quotaDetail,
      subscriptionTitle: p.subscriptionTitle,
      suspended: p.suspended,
      suspendedAt: p.suspendedAt,
      suspendReason: p.suspendReason,
      suspendMessage: p.suspendMessage,
      accessToken: p.accessToken,
      refreshToken: p.refreshToken,
      expiresAt: p.expiresAt,
      profileArn: p.profileArn,
    }
  }

  async create(input: AccountCreateInput): Promise<AccountRecord> {
    const now = Date.now()
    const id = input.id || randomUUID()
    if (this.accounts.has(id)) throw new Error(`Account id already exists: ${id}`)
    if (!input.accessToken && !input.refreshToken) {
      throw new Error('accessToken or refreshToken is required')
    }
    const record: AccountRecord = {
      ...input,
      id,
      accessToken: input.accessToken || '',
      label: input.label || input.email || id.slice(0, 8),
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    }
    this.accounts.set(id, record)
    this.pool.addAccount(record)
    await this.persist()
    return this.withStats(record)
  }

  async update(id: string, patch: AccountUpdateInput): Promise<AccountRecord> {
    const existing = this.accounts.get(id)
    if (!existing) throw new Error(`Account not found: ${id}`)
    const updated: AccountRecord = {
      ...existing,
      ...patch,
      id,
      updatedAt: Date.now(),
    }
    this.accounts.set(id, updated)
    this.pool.updateAccount(id, updated)
    if (patch.enabled === false) {
      this.pool.updateAccount(id, { isAvailable: false })
    } else if (patch.enabled === true && !updated.suspended) {
      this.pool.updateAccount(id, { isAvailable: true })
    }
    await this.persist()
    return this.withStats(updated)
  }

  async remove(id: string): Promise<boolean> {
    if (!this.accounts.has(id)) return false
    this.accounts.delete(id)
    this.pool.removeAccount(id)
    await this.persist()
    return true
  }

  async setEnabled(id: string, enabled: boolean): Promise<AccountRecord> {
    return this.update(id, { enabled })
  }

  async applyTokenRefresh(
    id: string,
    tokens: { accessToken: string; refreshToken?: string; expiresAt?: number },
  ): Promise<void> {
    await this.update(id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    })
  }

  async importAccounts(
    items: AccountCreateInput[],
    mode: 'merge' | 'replace' = 'merge',
  ): Promise<{ imported: number; total: number }> {
    if (mode === 'replace') {
      this.accounts.clear()
      this.pool.clear()
    }
    let imported = 0
    for (const item of items) {
      const id = item.id || randomUUID()
      if (this.accounts.has(id)) {
        await this.update(id, item)
      } else {
        await this.create({ ...item, id })
      }
      imported++
    }
    return { imported, total: this.accounts.size }
  }

  exportAccounts(): AccountRecord[] {
    return this.list()
  }

  async recordUsage(rec: UsageRecord): Promise<void> {
    await this.usageFile.update((store) => {
      const records = [...store.records, rec].slice(-5000)
      return {
        records,
        totals: {
          requests: store.totals.requests + 1,
          success: store.totals.success + (rec.success ? 1 : 0),
          failed: store.totals.failed + (rec.success ? 0 : 1),
          inputTokens: store.totals.inputTokens + rec.inputTokens,
          outputTokens: store.totals.outputTokens + rec.outputTokens,
        },
      }
    })
    // sync pool token fields back to disk periodically
    await this.persist()
  }

  async getUsage(): Promise<UsageStore> {
    return this.usageFile.read()
  }

  /** Sync live pool state (tokens etc.) into store map without full rewrite of unrelated fields */
  syncFromPool(id: string): void {
    const snap = this.poolSnapshot(id)
    const existing = this.accounts.get(id)
    if (!existing) return
    this.accounts.set(id, { ...existing, ...snap, updatedAt: Date.now() })
  }

  async applyQuota(
    id: string,
    used: number,
    limit: number,
    resetAt?: number,
    detail?: AccountRecord['quotaDetail'],
  ): Promise<AccountRecord | undefined> {
    this.pool.updateQuota(id, used, limit, resetAt, detail)
    this.syncFromPool(id)
    await this.flush()
    return this.get(id)
  }

  async flush(): Promise<void> {
    await this.persist()
  }
}
