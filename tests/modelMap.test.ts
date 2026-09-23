import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { mapModelId, setCustomModelMap } from '../src/kiro/translator.js'

const dirs: string[] = []
afterEach(async () => {
  setCustomModelMap({})
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('ModelMapStore', () => {
  it('persists overrides and layers onto mapModelId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-mmap-'))
    dirs.push(dir)
    const store = new ModelMapStore(dir)
    await store.init()
    await store.upsert('gpt-4o-mini', 'claude-haiku-4.5')
    expect(mapModelId('gpt-4o-mini')).toBe('claude-haiku-4.5')
    expect(mapModelId('gpt-4o')).toBe('claude-sonnet-4.5') // builtin

    const again = new ModelMapStore(dir)
    await again.init()
    expect(again.get()['gpt-4o-mini']).toBe('claude-haiku-4.5')
    expect(mapModelId('GPT-4O-MINI')).toBe('claude-haiku-4.5')
  })
})
