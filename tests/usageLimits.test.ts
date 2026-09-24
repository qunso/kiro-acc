import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AccountStore } from '../src/accounts/store.js'
import { ApiKeyStore } from '../src/apiKeys/store.js'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { loadConfig } from '../src/config.js'
import {
  creditQuotaFromUsageLimits,
  normalizeResetAt,
  profileArnForUsageLimits,
} from '../src/kiro/usageLimits.js'

vi.mock('../src/kiro/usageLimits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kiro/usageLimits.js')>()
  return {
    ...actual,
    getUsageLimits: vi.fn(),
  }
})

import { getUsageLimits } from '../src/kiro/usageLimits.js'
import { createServer } from '../src/server.js'

const dirs: string[] = []
afterEach(async () => {
  vi.mocked(getUsageLimits).mockReset()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('creditQuotaFromUsageLimits', () => {
  it('maps CREDIT breakdown with trial + bonuses', () => {
    const q = creditQuotaFromUsageLimits(
      {
        usageBreakdownList: [
          {
            resourceType: 'CREDIT',
            currentUsageWithPrecision: 12.5,
            usageLimitWithPrecision: 100,
            freeTrialInfo: {
              freeTrialStatus: 'ACTIVE',
              currentUsageWithPrecision: 1,
              usageLimitWithPrecision: 10,
            },
            bonuses: [{ currentUsageWithPrecision: 0.5, usageLimitWithPrecision: 5 }],
          },
        ],
        nextDateReset: 1_800_000_000,
        subscriptionInfo: { subscriptionTitle: 'Kiro Pro' },
      },
      'https://q.us-east-1.amazonaws.com',
    )
    expect(q.used).toBe(14)
    expect(q.limit).toBe(115)
    expect(q.subscriptionTitle).toBe('Kiro Pro')
    expect(q.resetAt).toBe(1_800_000_000 * 1000)
    expect(normalizeResetAt('2026-10-01T00:00:00.000Z')).toBe(
      Date.parse('2026-10-01T00:00:00.000Z'),
    )
  })

  it('omits BuilderId placeholder profileArn', () => {
    expect(
      profileArnForUsageLimits({
        id: 'a',
        label: 'a',
        accessToken: 't',
        createdAt: 1,
        updatedAt: 1,
        profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/KIRO_BUILDER_ID_PLACEHOLDER',
        authMethod: 'builder-id',
      } as any),
    ).toBeUndefined()
    expect(
      profileArnForUsageLimits({
        id: 'b',
        label: 'b',
        accessToken: 't',
        createdAt: 1,
        updatedAt: 1,
        provider: 'Github',
        authMethod: 'social',
      } as any),
    ).toMatch(/profile\/EHGA3GRVQMUK/)
  })
})

describe('refresh-subscription fetches usage limits', () => {
  it('persists CREDIT quota via applyQuota', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-usage-'))
    dirs.push(dir)
    const config = { ...loadConfig(), dataDir: dir, adminToken: 'adm', apiKey: 'k' }
    const accounts = new AccountStore(dir, config)
    await accounts.init()
    const a = await accounts.create({
      label: 'U',
      email: 'u@x.com',
      accessToken: 'tok',
      refreshToken: 'ref',
      enabled: true,
      expiresAt: Date.now() + 3600_000,
    })
    const apiKeys = new ApiKeyStore(dir, config.apiKey)
    await apiKeys.init()
    const modelMap = new ModelMapStore(dir)
    await modelMap.init()
    const app = createServer(accounts, config, undefined, undefined, { apiKeys, modelMap })

    vi.mocked(getUsageLimits).mockResolvedValue({
      used: 20,
      limit: 100,
      resetAt: Date.now() + 86400_000,
      subscriptionTitle: 'Kiro Free',
      raw: {},
      endpoint: 'https://q.us-east-1.amazonaws.com',
    })

    // refreshAccountToken will try network — stub by giving long-lived token and
    // mocking auth refresh via vi on the module is heavy; instead patch account
    // so refresh succeeds by mocking at route level is hard. Use a spy on refresh.
    const auth = await import('../src/kiro/auth.js')
    const spy = vi.spyOn(auth, 'refreshAccountToken').mockResolvedValue({
      success: true,
      accessToken: 'tok2',
      refreshToken: 'ref2',
      expiresAt: Date.now() + 7200_000,
    })

    const res = await app.request(`/admin/accounts/${a.id}/refresh-subscription`, {
      method: 'POST',
      headers: { 'x-admin-token': 'adm' },
    })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.usageFetched).toBe(true)
    expect(j.usage.used).toBe(20)
    expect(j.usage.limit).toBe(100)
    expect(j.account.quotaUsed).toBe(20)
    expect(j.account.quotaLimit).toBe(100)
    expect(getUsageLimits).toHaveBeenCalled()
    spy.mockRestore()
  })
})
