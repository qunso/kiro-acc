import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultTokenRefresh } from '../src/kiro/auth.js'
import type { AccountRecord } from '../src/accounts/types.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function baseAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 'acct-oidc-1',
    label: 'oidc',
    accessToken: '',
    refreshToken: 'rt-live',
    clientId: 'cid-1',
    clientSecret: 'csec-1',
    provider: 'BuilderId',
    authMethod: 'builder_id',
    enabled: true,
    ...overrides,
  }
}

describe('OIDC refreshOidc via defaultTokenRefresh', () => {
  it('POSTs JSON camelCase body (not form-urlencoded) and parses camelCase tokens', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('content-type')).toBe('application/json')
      const raw = String(init?.body ?? '')
      expect(raw).not.toMatch(/grant_type=|refresh_token=|client_id=/)
      expect(raw).not.toContain('application/x-www-form-urlencoded')
      const parsed = JSON.parse(raw) as Record<string, string>
      expect(parsed).toEqual({
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        refreshToken: 'rt-live',
        grantType: 'refresh_token',
      })
      return new Response(
        JSON.stringify({
          accessToken: 'at-new',
          refreshToken: 'rt-new',
          expiresIn: 7200,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const result = await defaultTokenRefresh(baseAccount())
    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('at-new')
    expect(result.refreshToken).toBe('rt-new')
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 7200_000 - 50)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 7200_000 + 50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://oidc.us-east-1.amazonaws.com/token')
  })

  it('accepts snake_case token response fields for compatibility', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'at-snake',
            refresh_token: 'rt-snake',
            expires_in: 1800,
          }),
          { status: 200 },
        ),
      ),
    )

    const before = Date.now()
    const result = await defaultTokenRefresh(baseAccount({ provider: 'IdC', authMethod: 'idc', region: 'eu-west-1' }))
    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('at-snake')
    expect(result.refreshToken).toBe('rt-snake')
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 1800_000 - 50)
  })

  it('uses region-specific IdC OIDC URL still with JSON body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: 'at', expiresIn: 60 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await defaultTokenRefresh(
      baseAccount({
        provider: 'Enterprise',
        authMethod: 'idc',
        region: 'ap-southeast-2',
      }),
    )
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://oidc.ap-southeast-2.amazonaws.com/token')
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(String(init?.body)).toContain('"grantType":"refresh_token"')
  })

  it('leaves social refresh on the social endpoint with refreshToken-only JSON', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'social-rt' })
      return new Response(
        JSON.stringify({ accessToken: 'sat', refreshToken: 'social-rt', expiresIn: 3600 }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await defaultTokenRefresh(
      baseAccount({
        provider: 'Google',
        authMethod: 'social',
        refreshToken: 'social-rt',
        clientId: undefined,
        clientSecret: undefined,
      }),
    )
    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('sat')
  })
})
