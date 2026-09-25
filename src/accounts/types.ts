export interface AccountStats {
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
  errors: number
  lastUsed: number
  avgResponseTime: number
  totalResponseTime: number
}


/** Persisted CREDIT breakdown from GetUsageLimits (detail drawer + card reuse). */
export interface AccountQuotaDetail {
  baseUsed: number
  baseLimit: number
  trialUsed: number
  trialLimit: number
  bonusUsed: number
  bonusLimit: number
  bonusCount: number
  resourceType?: string
  subscriptionTitle?: string
  overageCapability?: string
  upgradeCapability?: string
  overageStatus?: string
  kiroUserId?: string
  kiroEmail?: string
  fetchedAt?: number
}

/** How outbound LLM traffic is sent for this account. Default/absent = kiro. */
export type UpstreamType = 'kiro' | 'openai_compat' | 'anthropic_compat'

export interface AccountRecord {
  id: string
  label: string
  email?: string
  accessToken: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp' | 'builder_id'
  provider?: string
  /**
   * Upstream protocol for this account in the pool.
   * - `kiro` (default): translate to CodeWhisperer / Amazon Q
   * - `openai_compat`: relay OpenAI-style chat/completions to baseUrl
   * - `anthropic_compat`: relay Anthropic Messages to baseUrl
   * Distinct from `provider` (identity IdP: Google / Github / BuilderId).
   */
  upstreamType?: UpstreamType
  /** Required for *_compat: upstream API root (trailing slash ok). */
  baseUrl?: string
  /** Required for *_compat: Bearer / x-api-key sent to upstream. */
  upstreamApiKey?: string
  /** Optional extra headers merged into upstream requests. */
  defaultHeaders?: Record<string, string>
  /** Optional prefix prepended to client model id when forwarding. */
  modelPrefix?: string
  /**
   * Manual model allowlist. When non-empty, account only serves requests whose
   * model matches (prefix-aware). Takes precedence over upstreamModels cache.
   */
  supportedModels?: string[]
  /** Cached upstream model ids from GET .../models (compat accounts). */
  upstreamModels?: string[]
  /** When upstreamModels was last refreshed (epoch ms). */
  upstreamModelsFetchedAt?: number
  profileArn?: string
  expiresAt?: number
  enabled: boolean
  suspended?: boolean
  suspendedAt?: number
  suspendReason?: string
  suspendMessage?: string
  group?: string
  tags?: string[]
  outboundProxyUrl?: string
  /** Exit catalog id (native SS or legacy ss-exit broker) */
  outboundExitId?: string
  /** Proxy pool id — account binds to a pool of interchangeable exits */
  outboundPoolId?: string
  /** runtime / pool fields */
  lastUsed?: number
  requestCount?: number
  errorCount?: number
  isAvailable?: boolean
  cooldownUntil?: number
  quotaUsed?: number
  quotaLimit?: number
  quotaExhaustedAt?: number
  quotaResetAt?: number
  /** Last known GetUsageLimits CREDIT breakdown for account detail drawer */
  quotaDetail?: AccountQuotaDetail
  /** Cached subscription title from GetUsageLimits */
  subscriptionTitle?: string
  /**
   * Per-account Machine ID / 机器码 — stable client identity appended to
   * KiroIDE User-Agent on upstream calls. Same field as original managers'
   * `machineId` (zh label 机器码, en label Machine ID). Not OS MachineGuid;
   * not rotated per request.
   */
  machineId?: string
  /**
   * @deprecated Alias of machineId (PR #9 display-only import). Prefer machineId.
   * Still accepted on import; mirrored for older admin UI clients.
   */
  deviceId?: string
  stats?: AccountStats
  createdAt?: number
  updatedAt?: number
}

export type AccountCreateInput = Omit<AccountRecord, 'id' | 'stats' | 'createdAt' | 'updatedAt'> & {
  id?: string
  enabled?: boolean
}

export type AccountUpdateInput = Partial<Omit<AccountRecord, 'id' | 'stats' | 'createdAt'>>

export interface PersistedConfig {
  accountStrategy?: 'round-robin' | 'sticky'
  baseCooldownMs?: number
  maxBackoffMultiplier?: number
  quotaResetMs?: number
  probabilisticRetryChance?: number
  tokenRefreshBeforeExpirySec?: number
  preferredEndpoint?: 'codewhisperer' | 'amazonq'
  maxRetries?: number
}

export interface UsageRecord {
  timestamp: number
  accountId: string
  model: string
  inputTokens: number
  outputTokens: number
  success: boolean
  error?: string
  responseTimeMs: number
  /** Managed / env API key that authenticated the proxy request (optional, backward compatible). */
  apiKeyId?: string
  apiKeyLabel?: string
}

export interface UsageStore {
  records: UsageRecord[]
  totals: {
    requests: number
    success: number
    failed: number
    inputTokens: number
    outputTokens: number
  }
}
