import { describe, it, expect, beforeEach } from 'vitest'
import {
  AccountPool,
  classifyError,
  ErrorType,
} from '../src/pool/accountPool.js'
import type { AccountRecord } from '../src/accounts/types.js'

function makeAccount(id: string, overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id,
    label: id,
    accessToken: `token-${id}`,
    enabled: true,
    ...overrides,
  }
}

describe('classifyError', () => {
  it('marks quota / auth / rate-limit as recoverable', () => {
    expect(classifyError(402)).toBe(ErrorType.RECOVERABLE)
    expect(classifyError(403)).toBe(ErrorType.RECOVERABLE)
    expect(classifyError(429)).toBe(ErrorType.RECOVERABLE)
  })

  it('marks bad request / validation / 5xx as fatal', () => {
    expect(classifyError(400)).toBe(ErrorType.FATAL)
    expect(classifyError(400, 'CONTENT_LENGTH_EXCEEDS_THRESHOLD')).toBe(ErrorType.FATAL)
    expect(classifyError(422)).toBe(ErrorType.FATAL)
    expect(classifyError(500)).toBe(ErrorType.FATAL)
    expect(classifyError(503)).toBe(ErrorType.FATAL)
  })
})

describe('AccountPool selection', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool({
      baseCooldownMs: 60_000,
      maxBackoffMultiplier: 1440,
      quotaResetMs: 3_600_000,
      probabilisticRetryChance: 0, // deterministic: no probabilistic retry in tests
    })
  })

  it('returns null when empty', () => {
    expect(pool.getNextAccount()).toBeNull()
  })

  it('returns the single account regardless of cooldown', () => {
    pool.addAccount(makeAccount('a1'))
    pool.recordError('a1', ErrorType.RECOVERABLE, 429)
    expect(pool.getNextAccount()?.id).toBe('a1')
  })

  it('round-robin advances after success', () => {
    pool.setStrategy('round-robin')
    pool.addAccount(makeAccount('a1'))
    pool.addAccount(makeAccount('a2'))
    pool.addAccount(makeAccount('a3'))

    const first = pool.getNextAccount()!
    pool.recordSuccess(first.id)
    const second = pool.getNextAccount()!
    expect(second.id).not.toBe(first.id)
    pool.recordSuccess(second.id)
    const third = pool.getNextAccount()!
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
  })

  it('sticky keeps the same account after success', () => {
    pool.setStrategy('sticky')
    pool.addAccount(makeAccount('a1'))
    pool.addAccount(makeAccount('a2'))

    const first = pool.getNextAccount()!
    pool.recordSuccess(first.id)
    const second = pool.getNextAccount()!
    expect(second.id).toBe(first.id)
  })

  it('skips suspended accounts', () => {
    pool.addAccount(makeAccount('a1'))
    pool.addAccount(makeAccount('a2'))
    pool.markSuspended('a1', 'TEMPORARILY_SUSPENDED')
    expect(pool.getNextAccount()?.id).toBe('a2')
    expect(pool.getQuotaStatus().suspended).toBe(1)
  })

  it('skips disabled accounts', () => {
    pool.addAccount(makeAccount('a1', { enabled: false }))
    pool.addAccount(makeAccount('a2'))
    expect(pool.getNextAccount()?.id).toBe('a2')
  })

  it('skips quota-exhausted accounts until reset', () => {
    pool.addAccount(makeAccount('a1'))
    pool.addAccount(makeAccount('a2'))
    pool.recordError('a1', ErrorType.RECOVERABLE, 402)
    expect(pool.isQuotaExhausted(pool.getAccount('a1')!)).toBe(true)
    expect(pool.getNextAccount()?.id).toBe('a2')
  })

  it('FATAL errors do not increase errorCount', () => {
    pool.addAccount(makeAccount('a1'))
    pool.recordError('a1', ErrorType.FATAL, 400)
    expect(pool.getAccount('a1')!.errorCount).toBe(0)
  })

  it('RECOVERABLE errors increase errorCount and trigger cooldown', () => {
    pool.addAccount(makeAccount('a1'))
    pool.addAccount(makeAccount('a2'))
    pool.recordError('a1', ErrorType.RECOVERABLE, 403)
    expect(pool.getAccount('a1')!.errorCount).toBe(1)
    // with probabilisticRetryChance=0, a1 should be skipped while cooling
    expect(pool.getNextAccount()?.id).toBe('a2')
  })

  it('excludes tried accounts within a request', () => {
    pool.addAccount(makeAccount('a1'))
    pool.addAccount(makeAccount('a2'))
    const first = pool.getNextAccount()!
    const second = pool.getNextAccount(new Set([first.id]))!
    expect(second.id).not.toBe(first.id)
    expect(pool.getNextAccount(new Set([first.id, second.id]))).toBeNull()
  })

  it('clearSuspended restores availability', () => {
    pool.addAccount(makeAccount('a1'))
    pool.markSuspended('a1', 'TEMPORARILY_SUSPENDED')
    pool.clearSuspended('a1')
    expect(pool.isSuspended(pool.getAccount('a1')!)).toBe(false)
    expect(pool.getNextAccount()?.id).toBe('a1')
  })

  it('expired token without refreshToken is unavailable (multi-account)', () => {
    pool.addAccount(
      makeAccount('a1', { expiresAt: Date.now() - 1000, refreshToken: undefined }),
    )
    pool.addAccount(makeAccount('a2'))
    expect(pool.getNextAccount()?.id).toBe('a2')
  })
})
