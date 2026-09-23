import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'

export interface ProxyPool {
  id: string
  name?: string
  exitIds: string[]
  disabled?: boolean
  updatedAt?: number
}

export interface PoolsFile {
  pools: ProxyPool[]
  updatedAt?: number
}

function normalizePool(p: ProxyPool): ProxyPool {
  const id = String(p.id).trim()
  if (!id) throw new Error('pool id is required')
  const exitIds = Array.isArray(p.exitIds)
    ? [...new Set(p.exitIds.map((x) => String(x).trim()).filter(Boolean))]
    : []
  return {
    id,
    name: p.name?.trim() || undefined,
    exitIds,
    disabled: p.disabled ? true : undefined,
    updatedAt: p.updatedAt != null ? Number(p.updatedAt) : undefined,
  }
}

export class PoolsStore {
  private file: JsonStore<PoolsFile>
  private data: PoolsFile = { pools: [] }

  constructor(dataDir: string) {
    this.file = new JsonStore(path.join(dataDir, 'pools.json'), { pools: [] })
  }

  async init(): Promise<void> {
    this.data = await this.file.read()
    if (!Array.isArray(this.data.pools)) this.data.pools = []
  }

  get(id: string): ProxyPool | undefined {
    const p = this.data.pools.find((x) => x.id === id)
    return p ? { ...p, exitIds: [...p.exitIds] } : undefined
  }

  list(): ProxyPool[] {
    return this.data.pools.map((p) => ({ ...p, exitIds: [...p.exitIds] }))
  }

  async upsert(pool: ProxyPool): Promise<ProxyPool> {
    const next = normalizePool({ ...pool, updatedAt: Date.now() })
    const idx = this.data.pools.findIndex((p) => p.id === next.id)
    if (idx >= 0) this.data.pools[idx] = next
    else this.data.pools.push(next)
    this.data.updatedAt = Date.now()
    await this.file.write(this.data)
    return { ...next, exitIds: [...next.exitIds] }
  }

  async upsertMany(pools: ProxyPool[]): Promise<ProxyPool[]> {
    const out: ProxyPool[] = []
    for (const p of pools) out.push(await this.upsert(p))
    return out
  }

  async delete(id: string): Promise<boolean> {
    const before = this.data.pools.length
    this.data.pools = this.data.pools.filter((p) => p.id !== id)
    if (this.data.pools.length === before) return false
    this.data.updatedAt = Date.now()
    await this.file.write(this.data)
    return true
  }

  async setExitIds(poolId: string, exitIds: string[]): Promise<ProxyPool> {
    const pool = this.get(poolId)
    if (!pool) throw new Error(`Unknown pool id: ${poolId}`)
    return this.upsert({ ...pool, exitIds })
  }

  async setDisabled(id: string, disabled: boolean): Promise<ProxyPool> {
    const pool = this.get(id)
    if (!pool) throw new Error(`Unknown pool id: ${id}`)
    return this.upsert({ ...pool, disabled: disabled ? true : undefined })
  }

  getExitIds(poolId: string): string[] {
    const pool = this.get(poolId)
    if (!pool) throw new Error(`Unknown pool id: ${poolId}`)
    return [...pool.exitIds]
  }
}
