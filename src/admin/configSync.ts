/**
 * Export / import non-secret ops config.
 * NEVER includes account tokens, exit passwords, or raw API key secrets.
 */
import type { PersistedConfig } from '../accounts/types.js'
import type { ProxyPool } from '../pools/store.js'
import type { WebhookRecord } from '../webhooks/types.js'
import type { OpsSettings } from './opsSettings.js'

export const CONFIG_SYNC_VERSION = 1 as const

export interface ConfigSyncApiKeyPublic {
  id: string
  label: string
  createdAt: number
  revokedAt?: number
  active: boolean
}

export interface ConfigSyncWebhookSafe {
  id?: string
  label: string
  channel: WebhookRecord['channel']
  url: string
  enabled: boolean
  events: WebhookRecord['events']
  telegramChatId?: string
  maxRetries?: number
  /** DingTalk secret is redacted on export; omit or leave empty on import to keep existing. */
  secretRedacted?: boolean
}

export interface ConfigSyncBundle {
  kind: 'kiro-acc-ops-config'
  version: typeof CONFIG_SYNC_VERSION
  exportedAt: number
  poolConfig?: PersistedConfig
  pools?: ProxyPool[]
  modelMap?: Record<string, string>
  webhooks?: ConfigSyncWebhookSafe[]
  exitFailThreshold?: number
  apiKeys?: ConfigSyncApiKeyPublic[]
  opsSettings?: OpsSettings
}

export interface ConfigSyncInput {
  poolConfig?: PersistedConfig
  pools?: ProxyPool[]
  modelMap?: Record<string, string>
  webhooks?: ConfigSyncWebhookSafe[]
  exitFailThreshold?: number
  opsSettings?: OpsSettings
  /** apiKeys are export-only metadata; ignored on import */
  apiKeys?: ConfigSyncApiKeyPublic[]
}

export function redactWebhookForExport(w: WebhookRecord): ConfigSyncWebhookSafe {
  return {
    id: w.id,
    label: w.label,
    channel: w.channel,
    url: w.url,
    enabled: w.enabled,
    events: [...w.events],
    telegramChatId: w.telegramChatId,
    maxRetries: w.maxRetries,
    secretRedacted: Boolean(w.secret),
  }
}

export function buildConfigSyncBundle(input: {
  poolConfig: PersistedConfig
  pools: ProxyPool[]
  modelMap: Record<string, string>
  webhooks: WebhookRecord[]
  exitFailThreshold: number
  apiKeys: ConfigSyncApiKeyPublic[]
  opsSettings: OpsSettings
}): ConfigSyncBundle {
  return {
    kind: 'kiro-acc-ops-config',
    version: CONFIG_SYNC_VERSION,
    exportedAt: Date.now(),
    poolConfig: { ...input.poolConfig },
    pools: input.pools.map((p) => ({
      id: p.id,
      name: p.name,
      exitIds: [...(p.exitIds || [])],
      disabled: p.disabled,
      updatedAt: p.updatedAt,
    })),
    modelMap: { ...input.modelMap },
    webhooks: input.webhooks.map(redactWebhookForExport),
    exitFailThreshold: input.exitFailThreshold,
    apiKeys: input.apiKeys.map((k) => ({ ...k })),
    opsSettings: {
      requestLogCapacity: input.opsSettings.requestLogCapacity,
      uiPrefs: { ...(input.opsSettings.uiPrefs || {}) },
    },
  }
}

export function parseConfigSyncBundle(raw: unknown): {
  ok: true
  bundle: ConfigSyncBundle
} | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' }
  const rec = raw as Record<string, unknown>
  if (rec.kind != null && rec.kind !== 'kiro-acc-ops-config') {
    return { ok: false, error: `unexpected kind: ${String(rec.kind)}` }
  }
  const version = rec.version != null ? Number(rec.version) : CONFIG_SYNC_VERSION
  if (!Number.isFinite(version) || version > CONFIG_SYNC_VERSION) {
    return { ok: false, error: `unsupported config sync version: ${String(rec.version)}` }
  }
  return {
    ok: true,
    bundle: {
      kind: 'kiro-acc-ops-config',
      version: CONFIG_SYNC_VERSION,
      exportedAt: typeof rec.exportedAt === 'number' ? rec.exportedAt : Date.now(),
      poolConfig:
        rec.poolConfig && typeof rec.poolConfig === 'object'
          ? (rec.poolConfig as PersistedConfig)
          : undefined,
      pools: Array.isArray(rec.pools) ? (rec.pools as ProxyPool[]) : undefined,
      modelMap:
        rec.modelMap && typeof rec.modelMap === 'object'
          ? (rec.modelMap as Record<string, string>)
          : undefined,
      webhooks: Array.isArray(rec.webhooks)
        ? (rec.webhooks as ConfigSyncWebhookSafe[])
        : undefined,
      exitFailThreshold:
        rec.exitFailThreshold != null && Number.isFinite(Number(rec.exitFailThreshold))
          ? Number(rec.exitFailThreshold)
          : undefined,
      apiKeys: Array.isArray(rec.apiKeys)
        ? (rec.apiKeys as ConfigSyncApiKeyPublic[])
        : undefined,
      opsSettings:
        rec.opsSettings && typeof rec.opsSettings === 'object'
          ? (rec.opsSettings as OpsSettings)
          : undefined,
    },
  }
}

/** Assert exported JSON never contains known secret field names with values. */
export function assertNoSecretsInBundle(bundle: ConfigSyncBundle): string[] {
  const json = JSON.stringify(bundle)
  const warnings: string[] = []
  // Structural checks
  for (const k of bundle.apiKeys || []) {
    if ('key' in (k as object) && (k as { key?: string }).key) {
      warnings.push(`apiKey ${k.id} unexpectedly includes raw key`)
    }
  }
  for (const w of bundle.webhooks || []) {
    if ('secret' in (w as object) && (w as { secret?: string }).secret) {
      warnings.push(`webhook ${w.label} unexpectedly includes secret`)
    }
  }
  if (/"accessToken"\s*:/.test(json) || /"refreshToken"\s*:/.test(json)) {
    warnings.push('bundle appears to contain account tokens')
  }
  if (/"password"\s*:/.test(json)) {
    warnings.push('bundle appears to contain exit passwords')
  }
  return warnings
}
