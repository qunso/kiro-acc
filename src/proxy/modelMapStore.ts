import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'
import { mapModelId as builtinMapModelId, PUBLIC_MODELS, setCustomModelMap } from '../kiro/translator.js'

export interface ModelMapFile {
  /** OpenAI / client model name → upstream public model id (e.g. claude-sonnet-4.5) */
  map: Record<string, string>
}

/**
 * Persisted OpenAI-name → upstream overrides layered on translator MODEL_ID_MAP.
 */
export class ModelMapStore {
  private file: JsonStore<ModelMapFile>
  private map: Record<string, string> = {}

  constructor(dataDir: string) {
    this.file = new JsonStore(path.join(dataDir, 'model-map.json'), { map: {} })
  }

  async init(): Promise<void> {
    const data = await this.file.read()
    this.map = normalizeMap(data.map || {})
    setCustomModelMap(this.map)
  }

  get(): Record<string, string> {
    return { ...this.map }
  }

  async set(map: Record<string, string>): Promise<Record<string, string>> {
    this.map = normalizeMap(map)
    setCustomModelMap(this.map)
    await this.file.write({ map: this.map })
    return this.get()
  }

  async upsert(openaiName: string, upstream: string): Promise<Record<string, string>> {
    const key = openaiName.trim().toLowerCase()
    const val = upstream.trim()
    if (!key || !val) throw new Error('openaiName and upstream are required')
    this.map[key] = val
    setCustomModelMap(this.map)
    await this.file.write({ map: this.map })
    return this.get()
  }

  async remove(openaiName: string): Promise<Record<string, string>> {
    const key = openaiName.trim().toLowerCase()
    delete this.map[key]
    setCustomModelMap(this.map)
    await this.file.write({ map: this.map })
    return this.get()
  }

  /** Resolve client model → upstream id using overrides then builtin map. */
  resolve(model: string): string {
    const raw = (model || '').trim()
    if (!raw) return builtinMapModelId(raw)
    if (/^[A-Z0-9_]+$/.test(raw) && raw.includes('CLAUDE')) return raw
    const lower = raw.toLowerCase()
    if (this.map[lower]) return this.map[lower]!
    return builtinMapModelId(raw)
  }

  builtinPublicModels() {
    return PUBLIC_MODELS.slice()
  }
}

function normalizeMap(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input || {})) {
    const key = String(k).trim().toLowerCase()
    const val = String(v).trim()
    if (key && val) out[key] = val
  }
  return out
}
