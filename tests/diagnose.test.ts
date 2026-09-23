import { describe, expect, it } from 'vitest'
import { buildSubscriptionSummary } from '../src/admin/subscription.js'

// diagnoseAccount hits network for TLS/exit — unit-test the report text path via subscription helper
// and a lightweight smoke of diagnose imports.
import { diagnoseAccount } from '../src/admin/diagnose.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('diagnoseAccount', () => {
  it('reports missing tokens without network when refresh/tls skipped', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-diag-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir }
    const accounts = new AccountStore(dir, config)
    await accounts.init()
    const acc = await accounts.create({
      label: 'bare',
      accessToken: 'live-token',
      refreshToken: 'rt',
      enabled: true,
      expiresAt: Date.now() + 3600_000,
    })
    const report = await diagnoseAccount(acc.id, {
      accounts,
      doRefresh: false,
      doTls: false,
    })
    expect(report.token.ok).toBe(true)
    expect(report.exit.ok).toBe(true)
    expect(report.text).toContain('Token')
    expect(report.text).toContain('No ClientHello')
  })

  it('fails cleanly for unknown account', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-diag-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir }
    const accounts = new AccountStore(dir, config)
    await accounts.init()
    const report = await diagnoseAccount('missing', {
      accounts,
      doRefresh: false,
      doTls: false,
    })
    expect(report.ok).toBe(false)
    expect(report.text).toContain('not found')
  })
})

describe('subscription helper export', () => {
  it('is importable alongside diagnose', () => {
    expect(buildSubscriptionSummary([]).total).toBe(0)
  })
})
