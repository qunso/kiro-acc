import path from 'node:path'

export type AccountSelectionStrategy = 'round-robin' | 'sticky'
export type PreferredEndpoint = 'codewhisperer' | 'amazonq'

export interface AppConfig {
  host: string
  port: number
  dataDir: string
  apiKey: string
  adminToken: string
  accountStrategy: AccountSelectionStrategy
  baseCooldownMs: number
  maxBackoffMultiplier: number
  quotaResetMs: number
  probabilisticRetryChance: number
  tokenRefreshBeforeExpirySec: number
  preferredEndpoint: PreferredEndpoint
  maxRetries: number
}

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function loadConfig(): AppConfig {
  const strategy = env('ACCOUNT_STRATEGY', 'round-robin')
  const preferred = env('PREFERRED_ENDPOINT', 'codewhisperer')
  return {
    host: env('HOST', '0.0.0.0'),
    port: envInt('PORT', 8787),
    dataDir: path.resolve(env('DATA_DIR', './data')),
    apiKey: env('API_KEY', 'change-me-api-key'),
    adminToken: env('ADMIN_TOKEN', 'change-me-admin-token'),
    accountStrategy: strategy === 'sticky' ? 'sticky' : 'round-robin',
    baseCooldownMs: envInt('BASE_COOLDOWN_MS', 60_000),
    maxBackoffMultiplier: envInt('MAX_BACKOFF_MULTIPLIER', 1440),
    quotaResetMs: envInt('QUOTA_RESET_MS', 3_600_000),
    probabilisticRetryChance: envFloat('PROBABILISTIC_RETRY_CHANCE', 0.1),
    tokenRefreshBeforeExpirySec: envInt('TOKEN_REFRESH_BEFORE_EXPIRY_SEC', 300),
    preferredEndpoint: preferred === 'amazonq' ? 'amazonq' : 'codewhisperer',
    maxRetries: envInt('MAX_RETRIES', 3),
  }
}

export type RuntimePoolConfig = Pick<
  AppConfig,
  | 'accountStrategy'
  | 'baseCooldownMs'
  | 'maxBackoffMultiplier'
  | 'quotaResetMs'
  | 'probabilisticRetryChance'
  | 'tokenRefreshBeforeExpirySec'
  | 'preferredEndpoint'
  | 'maxRetries'
>
