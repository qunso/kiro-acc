import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PoolsStore } from '../src/pools/store.js'
import { resolveDefaultPool } from '../src/pools/defaultPool.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function storeWith(...pools: Array<{ id: string; name?: string; exitIds: string[]; disabled?: boolean }>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-defpool-'))
  dirs.push(dir)
  const poolsStore = new PoolsStore(dir)
  await poolsStore.init()
  for (const p of pools) await poolsStore.upsert(p)
  return poolsStore
}

describe('resolveDefaultPool', () => {
  it('prefers id/name default', async () => {
    const s = await storeWith(
      { id: 'a', exitIds: ['e1'] },
      { id: 'default', name: 'Main', exitIds: ['e2'] },
    )
    expect(resolveDefaultPool(s)?.id).toBe('default')
  })

  it('uses sole eligible pool', async () => {
    const s = await storeWith({ id: 'only', exitIds: ['e1'] }, { id: 'empty', exitIds: [] })
    expect(resolveDefaultPool(s)?.id).toBe('only')
  })

  it('returns undefined when multiple non-default pools', async () => {
    const s = await storeWith(
      { id: 'p1', exitIds: ['e1'] },
      { id: 'p2', exitIds: ['e2'] },
    )
    expect(resolveDefaultPool(s)).toBeUndefined()
  })
})
