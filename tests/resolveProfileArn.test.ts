import { describe, expect, it } from 'vitest'
import type { AccountRecord } from '../src/accounts/types.js'
import {
  KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_BUILDER_ID_PLACEHOLDER_ARN_LEGACY,
  KIRO_SOCIAL_PROFILE_ARN,
  isPlaceholderProfileArn,
  resolveProfileArn,
} from '../src/kiro/auth.js'

function account(over: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 'a1',
    label: 'a1',
    accessToken: 't',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as AccountRecord
}

describe('isPlaceholderProfileArn', () => {
  it('treats empty as placeholder', () => {
    expect(isPlaceholderProfileArn(undefined)).toBe(true)
    expect(isPlaceholderProfileArn('')).toBe(true)
  })

  it('treats correct AAAACCCCXXXX BuilderId ARN as placeholder', () => {
    expect(isPlaceholderProfileArn(KIRO_BUILDER_ID_PLACEHOLDER_ARN)).toBe(true)
    expect(
      isPlaceholderProfileArn(
        'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
      ),
    ).toBe(true)
  })

  it('treats legacy wrong KIRO_BUILDER_ID_PLACEHOLDER ARN as placeholder', () => {
    expect(isPlaceholderProfileArn(KIRO_BUILDER_ID_PLACEHOLDER_ARN_LEGACY)).toBe(true)
    expect(
      isPlaceholderProfileArn(
        'arn:aws:codewhisperer:us-east-1:699475941385:profile/KIRO_BUILDER_ID_PLACEHOLDER',
      ),
    ).toBe(true)
  })

  it('does not treat real social / custom ARNs as placeholders', () => {
    expect(isPlaceholderProfileArn(KIRO_SOCIAL_PROFILE_ARN)).toBe(false)
    expect(
      isPlaceholderProfileArn(
        'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
      ),
    ).toBe(false)
    expect(
      isPlaceholderProfileArn('arn:aws:codewhisperer:us-east-1:123:profile/real-profile'),
    ).toBe(false)
  })
})

describe('resolveProfileArn BuilderId fallback', () => {
  it('returns correct AAAACCCCXXXX ARN for BuilderId when profileArn missing', () => {
    expect(
      resolveProfileArn(account({ authMethod: 'builder-id', provider: 'BuilderId' })),
    ).toBe(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
    expect(KIRO_BUILDER_ID_PLACEHOLDER_ARN).toBe(
      'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
    )
  })

  it('replaces legacy wrong stored placeholder with correct ARN', () => {
    expect(
      resolveProfileArn(
        account({
          authMethod: 'builder-id',
          provider: 'BuilderId',
          profileArn: KIRO_BUILDER_ID_PLACEHOLDER_ARN_LEGACY,
        }),
      ),
    ).toBe(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
  })

  it('replaces stored AAAACCCCXXXX placeholder with constant (same value)', () => {
    expect(
      resolveProfileArn(
        account({
          authMethod: 'builder-id',
          profileArn: KIRO_BUILDER_ID_PLACEHOLDER_ARN,
        }),
      ),
    ).toBe(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
  })

  it('keeps a real non-placeholder profileArn', () => {
    const real = 'arn:aws:codewhisperer:us-east-1:123:profile/my-real-id'
    expect(
      resolveProfileArn(account({ authMethod: 'builder-id', profileArn: real })),
    ).toBe(real)
  })

  it('returns social ARN for Github/Google', () => {
    expect(resolveProfileArn(account({ provider: 'Github', authMethod: 'social' }))).toBe(
      KIRO_SOCIAL_PROFILE_ARN,
    )
    expect(resolveProfileArn(account({ provider: 'Google', authMethod: 'social' }))).toBe(
      KIRO_SOCIAL_PROFILE_ARN,
    )
  })
})
