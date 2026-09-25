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
import { generateMachineId, pickStoredMachineId } from './machineId.js'
import {
  isCompatUpstream,
  resolveUpstreamType,
  validateAccountCredentials,
} from './upstream.js'

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
    let migratedMachineIds = 0
    for (const acc of accounts) {
      const next = { ...acc }
      const existing = pickStoredMachineId(next)
      if (!existing) {
        next.machineId = generateMachineId()
        migratedMachineIds++
      } else if (!next.machineId) {
        next.machineId = existing
        migratedMachineIds++
      }
      // Mirror for older admin UI that reads deviceId
      if (next.machineId && !next.deviceId) next.deviceId = next.machineId
      this.accounts.set(next.id, next)
      this.pool.addAccount(next)
    }
    if (migratedMachineIds > 0) {
      await this.persist()
      console.log(`[AccountStore] Assigned machineId on ${migratedMachineIds} account(s)`)
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
    const cred = validateAccountCredentials(input)
    if (!cred.ok) throw new Error(cred.error || 'invalid account credentials')
    const upstreamType = resolveUpstreamType(input)
    const machineId =
      pickStoredMachineId({ machineId: input.machineId, deviceId: input.deviceId }) ||
      generateMachineId()
    const record: AccountRecord = {
      ...input,
      id,
      accessToken: input.accessToken || '',
      upstreamType,
      baseUrl: input.baseUrl?.trim() || undefined,
      upstreamApiKey: input.upstreamApiKey?.trim() || undefined,
      modelPrefix: input.modelPrefix?.trim() || undefined,
      label: input.label || input.email || input.baseUrl || id.slice(0, 8),
      enabled: input.enabled !== false,
      machineId,
      deviceId: input.deviceId || machineId,
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

    const mergedForValidation: AccountRecord = { ...existing, ...patch }
    // Blank upstreamApiKey in PATCH means "keep existing" (masked form UX).
    if (
      typeof patch.upstreamApiKey === 'string' &&
      !patch.upstreamApiKey.trim()
    ) {
      mergedForValidation.upstreamApiKey = existing.upstreamApiKey
    }
    // Compat accounts must keep baseUrl + upstreamApiKey after every update.
    // Kiro accounts stay lenient on partial patches (token refresh, labels, etc.).
    if (isCompatUpstream(mergedForValidation)) {
      const full = validateAccountCredentials(mergedForValidation)
      if (!full.ok) throw new Error(full.error || 'invalid compat account')
    }

    // Apply patch but never let undefined machineId/deviceId from Partial spreads wipe
    // a stored value. Explicit empty/null regenerates; non-empty replaces.
    const next: AccountRecord = {
      ...existing,
      ...patch,
      id,
      updatedAt: Date.now(),
    }
    if ('upstreamType' in patch || isCompatUpstream(next)) {
      next.upstreamType = resolveUpstreamType(next)
    }
    if (typeof patch.baseUrl === 'string') {
      next.baseUrl = patch.baseUrl.trim() || undefined
    }
    if (typeof patch.upstreamApiKey === 'string') {
      // Blank form field = keep existing secret (do not clear / fail validation).
      const trimmedKey = patch.upstreamApiKey.trim()
      next.upstreamApiKey = trimmedKey || existing.upstreamApiKey
    }
    if (typeof patch.modelPrefix === 'string') {
      // Empty string clears the prefix (requirement).
      next.modelPrefix = patch.modelPrefix.trim() || undefined
    }
    if ('defaultHeaders' in patch) {
      const raw = patch.defaultHeaders
      if (raw == null) {
        next.defaultHeaders = undefined
      } else if (typeof raw === 'object' && !Array.isArray(raw)) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (v == null) continue
          const key = String(k).trim()
          if (!key) continue
          out[key] = String(v)
        }
        next.defaultHeaders = Object.keys(out).length ? out : undefined
      } else {
        next.defaultHeaders = undefined
      }
    }

    if ('machineId' in patch || 'deviceId' in patch) {
      const concrete =
        typeof patch.machineId === 'string' ||
        typeof patch.deviceId === 'string' ||
        patch.machineId === null ||
        patch.deviceId === null
      if (concrete) {
        const resolved = pickStoredMachineId({
          machineId: typeof patch.machineId === 'string' ? patch.machineId : undefined,
          deviceId: typeof patch.deviceId === 'string' ? patch.deviceId : undefined,
        })
        const machineId = resolved || generateMachineId()
        next.machineId = machineId
        next.deviceId = machineId
      } else {
        // Keys present as undefined only (e.g. import merge) — keep existing.
        next.machineId = existing.machineId
        next.deviceId = existing.deviceId
      }
    }

    // Never persist an account without a machineId after an update.
    if (!pickStoredMachineId(next)) {
      const machineId = generateMachineId()
      next.machineId = machineId
      next.deviceId = machineId
    } else if (next.machineId && !next.deviceId) {
      next.deviceId = next.machineId
    } else if (next.deviceId && !next.machineId) {
      next.machineId = next.deviceId
    }

    this.accounts.set(id, next)
    this.pool.updateAccount(id, next)
    if (patch.enabled === false) {
      this.pool.updateAccount(id, { isAvailable: false })
    } else if (patch.enabled === true && !next.suspended) {
      this.pool.updateAccount(id, { isAvailable: true })
    }
    await this.persist()
    return this.withStats(next)
  }

  async remove(id: string): Promise<boolean> {
    if (!this.accounts.has(id)) return false
    this.accounts.delete(id)
    this.pool.removeAccount(id)
    await this.persist()
    return true
  }

  /** Persist a machineId if missing (stable; never rotates an existing one). */
  async ensureMachineId(id: string): Promise<string> {
    const existing = this.accounts.get(id)
    if (!existing) throw new Error(`Account not found: ${id}`)
    const current = pickStoredMachineId(existing)
    if (current) {
      if (!existing.machineId || !existing.deviceId) {
        await this.update(id, {
          machineId: existing.machineId || current,
          deviceId: existing.deviceId || current,
        })
      }
      return current
    }
    const machineId = generateMachineId()
    await this.update(id, { machineId, deviceId: machineId })
    return machineId
  }

  /** Force a new machineId (admin edit / regenerate). Always rotates. */
  async regenerateMachineId(id: string): Promise<string> {
    const machineId = generateMachineId()
    await this.update(id, { machineId, deviceId: machineId })
    return machineId
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
        // Preserve existing machineId when import payload omits/empties it.
        // Non-empty machineId/deviceId from the payload still replaces.
        const patch: AccountUpdateInput = { ...item }
        if (!pickStoredMachineId({ machineId: item.machineId, deviceId: item.deviceId })) {
          delete patch.machineId
          delete patch.deviceId
        }
        await this.update(id, patch)
        // Existing row may have had no machineId (pre-migration data).
        await this.ensureMachineId(id)
      } else {
        // create() generates machineId when missing.
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
