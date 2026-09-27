import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'
import { parseEffort, type EffortLevel } from '../kiro/effort.js'


export const ENV_API_KEY_ID = 'env'
export const ENV_API_KEY_LABEL = 'ENV API_KEY'

export interface ResolvedApiKey {
  id: string
  label: string
  source: 'env' | 'managed'
  /** Optional default reasoning effort for this key (managed keys only). */
  defaultEffort?: EffortLevel
}

export interface ApiKeyRecord {
  id: string
  label: string
  /** Full API key secret (shown once on create; listed masked thereafter). */
  key: string
  createdAt: number
  revokedAt?: number
  /**
   * Optional default reasoning effort when the client omits it.
   * Valid: low | medium | high | xhigh | max. Missing = unset (omit upstream).
   * Precedence: request > this > account defaultEffort > unset.
   */
  defaultEffort?: EffortLevel
}

export interface ApiKeysFile {
  keys: ApiKeyRecord[]
}

export type ApiKeyCreateInput = {
  label?: string
  defaultEffort?: EffortLevel | string | null
}

export type ApiKeyUpdateInput = {
  label?: string
  /** Pass null or '' to clear. */
  defaultEffort?: EffortLevel | string | null
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function generateApiKey(): string {
  return `kk_${randomBytes(24).toString('base64url')}`
}

function normalizeDefaultEffort(
  raw: unknown,
  opts?: { requiredValid?: boolean },
): EffortLevel | undefined {
  if (raw == null || raw === '') return undefined
  const parsed = parseEffort(raw)
  if (!parsed && opts?.requiredValid) {
    throw new Error(`invalid defaultEffort (want low|medium|high|xhigh|max): ${String(raw)}`)
  }
  return parsed
}

export class ApiKeyStore {
  private file: JsonStore<ApiKeysFile>
  private keys: ApiKeyRecord[] = []
  /** Always-accepted key from env (legacy single API_KEY). */
  private envKey: string

  constructor(dataDir: string, envKey: string) {
    this.file = new JsonStore(path.join(dataDir, 'api-keys.json'), { keys: [] })
    this.envKey = envKey.trim()
  }

  async init(): Promise<void> {
    const data = await this.file.read()
    this.keys = Array.isArray(data.keys) ? data.keys : []
  }

  private async persist(): Promise<void> {
    await this.file.write({ keys: this.keys })
  }

  list(includeSecrets = false): Array<ApiKeyRecord & { masked: string; active: boolean }> {
    return this.keys.map((k) => ({
      ...k,
      key: includeSecrets ? k.key : '',
      masked: maskKey(k.key),
      active: !k.revokedAt,
    }))
  }

  /** Public view for admin UI (no full secrets). */
  listPublic() {
    return this.list(false).map(({ key: _k, ...rest }) => rest)
  }

  get(id: string): ApiKeyRecord | undefined {
    return this.keys.find((k) => k.id === id)
  }

  async create(labelOrInput: string | ApiKeyCreateInput = ''): Promise<ApiKeyRecord> {
    const input: ApiKeyCreateInput =
      typeof labelOrInput === 'string' ? { label: labelOrInput } : labelOrInput || {}
    const now = Date.now()
    const defaultEffort = normalizeDefaultEffort(input.defaultEffort, { requiredValid: true })
    const record: ApiKeyRecord = {
      id: randomUUID(),
      label: (input.label || '').trim() || `key-${now.toString(36)}`,
      key: generateApiKey(),
      createdAt: now,
      ...(defaultEffort ? { defaultEffort } : {}),
    }
    this.keys.push(record)
    await this.persist()
    return record
  }

  async revoke(id: string): Promise<ApiKeyRecord | undefined> {
    const rec = this.keys.find((k) => k.id === id)
    if (!rec) return undefined
    if (!rec.revokedAt) {
      rec.revokedAt = Date.now()
      await this.persist()
    }
    return rec
  }

  async updateLabel(id: string, label: string): Promise<ApiKeyRecord | undefined> {
    return this.update(id, { label })
  }

  async update(id: string, patch: ApiKeyUpdateInput): Promise<ApiKeyRecord | undefined> {
    const rec = this.keys.find((k) => k.id === id)
    if (!rec) return undefined
    if (patch.label !== undefined) {
      rec.label = patch.label.trim() || rec.label
    }
    if ('defaultEffort' in patch) {
      const next = normalizeDefaultEffort(patch.defaultEffort, { requiredValid: true })
      if (next) rec.defaultEffort = next
      else delete rec.defaultEffort
    }
    await this.persist()
    return rec
  }

  async remove(id: string): Promise<boolean> {
    const before = this.keys.length
    this.keys = this.keys.filter((k) => k.id !== id)
    if (this.keys.length === before) return false
    await this.persist()
    return true
  }


  /** Resolve a candidate secret to id/label for request logging & usage rollups. */
  resolveKey(candidate: string): ResolvedApiKey | null {
    const key = candidate.trim()
    if (!key) return null
    if (this.envKey && key === this.envKey) {
      return { id: ENV_API_KEY_ID, label: ENV_API_KEY_LABEL, source: 'env' }
    }
    const rec = this.keys.find((k) => !k.revokedAt && k.key === key)
    if (!rec) return null
    return {
      id: rec.id,
      label: rec.label,
      source: 'managed',
      ...(rec.defaultEffort ? { defaultEffort: rec.defaultEffort } : {}),
    }
  }

  isValidKey(candidate: string): boolean {
    const key = candidate.trim()
    if (!key) return false
    if (this.envKey && key === this.envKey) return true
    return this.keys.some((k) => !k.revokedAt && k.key === key)
  }

  /** Whether env API_KEY is configured (for UI hint). */
  hasEnvKey(): boolean {
    return Boolean(this.envKey)
  }

  envKeyMasked(): string {
    return maskKey(this.envKey)
  }
}
