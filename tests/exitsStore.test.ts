import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExitsStore } from '../src/exits/store.js'

describe('ExitsStore native SS', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  async function fresh() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-exits-'))
    const store = new ExitsStore(dir)
    await store.init()
    return store
  }

  it('importExits with SS fields precomputes ss:// outboundProxyUrl', async () => {
    const store = await fresh()
    const result = await store.importExits({
      exits: [
        {
          id: 'ss1-0',
          server: '1.2.3.4',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'SHARED_PASS#0',
          index: 0,
        },
      ],
    })
    expect(result.exits[0]!.outboundProxyUrl).toBe(
      'ss://aes-256-gcm:SHARED_PASS%230@1.2.3.4:60123',
    )
    expect(result.exits[0]!.useCount).toBe(0)
    expect(result.exits[0]!.banCount).toBe(0)
    expect(result.brokerBase).toBeUndefined()
  })

  it('ensureProxyUrl builds ss:// without broker', async () => {
    const store = await fresh()
    await store.importExits({
      exits: [
        {
          id: 'ss1-17',
          server: '10.0.0.1',
          port: 60123,
          method: 'aes-256-gcm',
          password: 'SECRET#17',
          index: 17,
        },
      ],
    })
    const url = await store.ensureProxyUrl('ss1-17')
    expect(url).toContain('ss://aes-256-gcm:')
    expect(url).toContain('SECRET%2317')
    expect(url).toContain('10.0.0.1:60123')
    // no brokerBase needed
    expect(store.get().brokerBase).toBeUndefined()
  })

  it('ensureProxyUrl returns existing socks/http url', async () => {
    const store = await fresh()
    await store.importExits({
      exits: [{ id: 'x', outboundProxyUrl: 'socks5h://127.0.0.1:19000' }],
    })
    expect(await store.ensureProxyUrl('x')).toBe('socks5h://127.0.0.1:19000')
  })

  it('ensureProxyUrl throws clearly when nothing configured', async () => {
    const store = await fresh()
    await store.importExits({ exitIds: ['bare'] })
    await expect(store.ensureProxyUrl('bare')).rejects.toThrow(/no SS fields/)
  })
})
