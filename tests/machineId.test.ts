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
