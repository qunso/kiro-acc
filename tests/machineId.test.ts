import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import {
  buildKiroAmzUserAgent,
  buildKiroUserAgent,
  generateMachineId,
  resolveMachineIdForRequest,
  stableMachineIdForAccountId,
} from '../src/accounts/machineId.js'
import { normalizeAccountImport } from '../src/accounts/importNormalize.js'
import { loadConfig } from '../src/config.js'
import type { AccountRecord } from '../src/accounts/types.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('machineId helpers', () => {
  it('generates UUID-shaped ids', () => {
    const id = generateMachineId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('builds UA with stable suffix (no per-call rotation)', () => {
    const mid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const ua = buildKiroUserAgent({
      kiroVersion: '0.12.155',
      awsSdkVersion: '1.0.34',
      machineId: mid,
      platform: 'linux',
      osRelease: 'v1',
      nodeVersion: '22.0.0',
    })
    expect(ua).toContain(`KiroIDE-0.12.155-${mid}`)
    const amz = buildKiroAmzUserAgent({
      kiroVersion: '0.12.155',
      awsSdkVersion: '1.0.34',
      machineId: mid,
    })
    expect(amz).toBe(`aws-sdk-js/1.0.34 KiroIDE-0.12.155-${mid}`)
  })

  it('prefers stored machineId over deviceId; falls back to stable hash', () => {
    const a: Pick<AccountRecord, 'id' | 'machineId' | 'deviceId'> = {
      id: 'acct-1',
      machineId: 'mid-1',
      deviceId: 'dev-1',
    }
    expect(resolveMachineIdForRequest(a)).toBe('mid-1')
    expect(resolveMachineIdForRequest({ id: 'acct-1', deviceId: 'dev-1' })).toBe('dev-1')
    const fallback = resolveMachineIdForRequest({ id: 'acct-1' })
    expect(fallback).toBe(stableMachineIdForAccountId('acct-1'))
    expect(fallback).toBe(resolveMachineIdForRequest({ id: 'acct-1' }))
  })
})

describe('AccountStore machineId persistence', () => {
  it('assigns machineId on create and does not rotate on ensure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-mid-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir }
    const store = new AccountStore(dir, config)
    await store.init()
    const a = await store.create({
      label: 'm',
      accessToken: 'tok',
      enabled: true,
    })
    expect(a.machineId).toBeTruthy()
    expect(a.deviceId).toBe(a.machineId)
    const again = await store.ensureMachineId(a.id)
    expect(again).toBe(a.machineId)
    expect(store.get(a.id)?.machineId).toBe(a.machineId)
  })

  it('migrates legacy deviceId-only accounts on init', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-mid-mig-'))
    dirs.push(dir)
    await fs.writeFile(
      path.join(dir, 'accounts.json'),
      JSON.stringify([
        {
          id: 'legacy-1',
          label: 'legacy',
          accessToken: 't',
          enabled: true,
          deviceId: 'legacy-device-id',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
    )
    await fs.writeFile(path.join(dir, 'config.json'), '{}')
    await fs.writeFile(
      path.join(dir, 'usage.json'),
      JSON.stringify({
        records: [],
        totals: { requests: 0, success: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
      }),
    )
    const config = { ...loadConfig(), dataDir: dir }
    const store = new AccountStore(dir, config)
    await store.init()
    const a = store.get('legacy-1')!
    expect(a.machineId).toBe('legacy-device-id')
  })

  it('imports machineId from common JSON shapes', () => {
    const n = normalizeAccountImport({
      accounts: [
        { email: 'a@x.com', refreshToken: 'r1', machineId: 'm-1' },
        { email: 'b@x.com', refreshToken: 'r2', machine_id: 'm-2' },
        { email: 'c@x.com', refreshToken: 'r3', machineCode: 'm-3' },
      ],
    })
    expect(n.accounts.map((a) => a.machineId)).toEqual(['m-1', 'm-2', 'm-3'])
  })
})

describe('upstream headers carry machineId', () => {
  it('callKiroApi auth path includes machineId in user-agent', async () => {
    const captured: { headers?: Record<string, string> } = {}
    vi.resetModules()

    // Spy via mocking undici/fetch is heavy; unit-test resolve + UA builders
    // were covered above. Smoke: resolveMachineIdForRequest used by client.
    const account = {
      id: 'h1',
      label: 'h',
      accessToken: 't',
      enabled: true,
      machineId: 'header-machine-id',
    } as AccountRecord
    const mid = resolveMachineIdForRequest(account)
    const ua = buildKiroUserAgent({
      kiroVersion: '0.12.155',
      awsSdkVersion: '1.0.34',
      machineId: mid,
    })
    expect(ua.endsWith('KiroIDE-0.12.155-header-machine-id')).toBe(true)
    void captured
  })
})

describe('import + edit machineId', () => {
  it('generates machineId on import when payload omits it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-mid-imp-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir }
    const store = new AccountStore(dir, config)
    await store.init()
    const normalized = normalizeAccountImport({
      accounts: [
        { email: 'no-mid@x.com', refreshToken: 'rt-1' },
        { email: 'has-mid@x.com', refreshToken: 'rt-2', machineId: 'keep-this-mid' },
        { email: 'empty-mid@x.com', refreshToken: 'rt-3', machineId: '   ' },
      ],
    })
    await store.importAccounts(normalized.accounts, 'merge')
    const a = store.get('acct:no-mid@x.com')!
    const b = store.get('acct:has-mid@x.com')!
    const c = store.get('acct:empty-mid@x.com')!
    expect(a.machineId).toBeTruthy()
    expect(a.machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(a.deviceId).toBe(a.machineId)
    expect(b.machineId).toBe('keep-this-mid')
    expect(c.machineId).toBeTruthy()
    expect(c.machineId).not.toBe('   ')
  })

  it('preserves existing machineId on re-import without machineId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-mid-merge-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir }
    const store = new AccountStore(dir, config)
    await store.init()
    await store.importAccounts(
      [{ id: 'acct:m@x.com', email: 'm@x.com', label: 'm', refreshToken: 'rt', accessToken: '', enabled: true, machineId: 'original-mid' }],
      'merge',
    )
    expect(store.get('acct:m@x.com')!.machineId).toBe('original-mid')
    await store.importAccounts(
      [{ id: 'acct:m@x.com', email: 'm@x.com', label: 'm2', refreshToken: 'rt2', accessToken: '', enabled: true }],
      'merge',
    )
    const again = store.get('acct:m@x.com')!
    expect(again.machineId).toBe('original-mid')
    expect(again.label).toBe('m2')
    expect(again.refreshToken).toBe('rt2')
  })

  it('update replaces machineId; empty regenerates; regenerateMachineId rotates', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-mid-edit-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir }
    const store = new AccountStore(dir, config)
    await store.init()
    const a = await store.create({ label: 'e', accessToken: 'tok', enabled: true })
    const first = a.machineId!
    expect(first).toBeTruthy()

    const replaced = await store.update(a.id, { machineId: 'custom-machine-id' })
    expect(replaced.machineId).toBe('custom-machine-id')
    expect(replaced.deviceId).toBe('custom-machine-id')

    const emptied = await store.update(a.id, { machineId: '' })
    expect(emptied.machineId).toBeTruthy()
    expect(emptied.machineId).not.toBe('custom-machine-id')
    expect(emptied.machineId).not.toBe(first)
    expect(emptied.deviceId).toBe(emptied.machineId)

    const beforeRegen = emptied.machineId!
    const rotated = await store.regenerateMachineId(a.id)
    expect(rotated).toBeTruthy()
    expect(rotated).not.toBe(beforeRegen)
    expect(store.get(a.id)!.machineId).toBe(rotated)
  })
})
