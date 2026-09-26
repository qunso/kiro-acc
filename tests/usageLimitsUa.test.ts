import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountRecord } from '../src/accounts/types.js'
import { getKiroIdeVersion } from '../src/kiro/ideVersion.js'
import {
  USAGE_LIMITS_AWS_SDK_VERSION_DEFAULT,
  USAGE_LIMITS_KIRO_VERSION_DEFAULT,
  getUsageLimits,
  usageLimitsAwsSdkVersion,
  usageLimitsKiroVersion,
} from '../src/kiro/usageLimits.js'

const okBody = JSON.stringify({
  usageBreakdownList: [
    {
      resourceType: 'CREDIT',
      currentUsageWithPrecision: 0,
      usageLimitWithPrecision: 5000,
    },
  ],
  subscriptionInfo: { subscriptionTitle: 'KIRO PRO MAX' },
})

function baseAccount(over: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 'acc-ua',
    label: 'BuilderId',
    accessToken: 'test-access-token',
    createdAt: 1,
    updatedAt: 1,
    authMethod: 'builder-id',
    profileArn:
      'arn:aws:codewhisperer:us-east-1:699475941385:profile/KIRO_BUILDER_ID_PLACEHOLDER',
    ...over,
  } as AccountRecord
}

describe('getUsageLimits User-Agent pin', () => {
  const envKeys = [
    'KIRO_USAGE_LIMITS_IDE_VERSION',
    'KIRO_USAGE_LIMITS_AWS_SDK_VERSION',
    'KIRO_IDE_VERSION',
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('uses pinned legacy UA, not getKiroIdeVersion()', async () => {
    process.env.KIRO_IDE_VERSION = '1.1.70'
    // Ensure live chat version would be 1.1.70 if used
    expect(getKiroIdeVersion()).toBe('1.1.70')
    expect(usageLimitsKiroVersion()).toBe(USAGE_LIMITS_KIRO_VERSION_DEFAULT)
    expect(usageLimitsAwsSdkVersion()).toBe(USAGE_LIMITS_AWS_SDK_VERSION_DEFAULT)

    const seen: Array<{ url: string; ua: string | null; amz: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        seen.push({
          url: String(url),
          ua: headers.get('user-agent'),
          amz: headers.get('x-amz-user-agent'),
        })
        return new Response(okBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const q = await getUsageLimits(baseAccount())
    expect(q.limit).toBe(5000)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]!.url).toMatch(/^https:\/\/q\.us-east-1\.amazonaws\.com\/getUsageLimits/)
    expect(seen[0]!.url).not.toContain('profileArn=')
    const ua = seen[0]!.ua || ''
    expect(ua).toContain(`aws-sdk-js/${USAGE_LIMITS_AWS_SDK_VERSION_DEFAULT}`)
    expect(ua).toContain(`KiroIDE-${USAGE_LIMITS_KIRO_VERSION_DEFAULT}-`)
    expect(ua).not.toContain('KiroIDE-1.1.70')
    expect(ua).not.toContain(`KiroIDE-${getKiroIdeVersion()}`)
    expect(seen[0]!.amz).toContain(`KiroIDE-${USAGE_LIMITS_KIRO_VERSION_DEFAULT}-`)
  })

  it('honors KIRO_USAGE_LIMITS_IDE_VERSION override only for usage limits', async () => {
    process.env.KIRO_IDE_VERSION = '1.1.14'
    process.env.KIRO_USAGE_LIMITS_IDE_VERSION = '0.6.18'
    process.env.KIRO_USAGE_LIMITS_AWS_SDK_VERSION = '1.0.18'

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const ua = headers.get('user-agent') || ''
        expect(ua).toContain('KiroIDE-0.6.18-')
        expect(ua).toContain('aws-sdk-js/1.0.18')
        expect(ua).not.toContain('KiroIDE-1.1.14')
        return new Response(okBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    await getUsageLimits(baseAccount({ machineId: 'mid-fixed' }))
    expect(vi.mocked(fetch)).toHaveBeenCalled()
  })

  it('aggregates errors preferring q.* over codewhisperer fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = JSON.stringify({ message: 'Invalid profileArn.' })
        return new Response(body, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const err = await getUsageLimits(baseAccount()).catch((e) => e)
    expect(err.name).toBe('UsageLimitsError')
    expect(err.statusCode).toBe(400)
    expect(err.message).toContain('https://q.us-east-1.amazonaws.com')
    expect(err.message).toMatch(/also tried:/)
    expect(err.message).toContain('codewhisperer.us-east-1.amazonaws.com')
    // Primary host in the message must be Amazon Q, not the CW fallback alone
    expect(err.message.startsWith('getUsageLimits HTTP 400 @ https://codewhisperer.')).toBe(
      false,
    )
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
