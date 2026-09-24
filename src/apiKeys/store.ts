import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'


export const ENV_API_KEY_ID = 'env'
export const ENV_API_KEY_LABEL = 'ENV API_KEY'

export interface ResolvedApiKey {
  id: string
  label: string
  source: 'env' | 'managed'
}

export interface ApiKeyRecord {
  id: string
  label: string
  /** Full API key secret (shown once on create; listed masked thereafter). */
  key: string
  createdAt: number
  revokedAt?: number
}

export interface ApiKeysFile {
  keys: ApiKeyRecord[]
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function generateApiKey(): string {
  return `kk_${randomBytes(24).toString('base64url')}`
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

  async create(label: string): Promise<ApiKeyRecord> {
    const now = Date.now()
    const record: ApiKeyRecord = {
      id: randomUUID(),
      label: (label || '').trim() || `key-${now.toString(36)}`,
      key: generateApiKey(),
      createdAt: now,
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
    const rec = this.keys.find((k) => k.id === id)
    if (!rec) return undefined
    rec.label = label.trim() || rec.label
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
    return { id: rec.id, label: rec.label, source: 'managed' }
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
