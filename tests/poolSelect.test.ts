import { describe, expect, it } from 'vitest'
import { hashAccountId } from '../src/exits/assign.js'
import type { ExitEntry } from '../src/exits/store.js'
import { pickExitFromPool, rankExits } from '../src/pools/select.js'

function exit(partial: Partial<ExitEntry> & { id: string }): ExitEntry {
  return {
    useCount: 0,
    banCount: 0,
    outboundProxyUrl: `socks5h://127.0.0.1:${9000 + (partial.useCount ?? 0)}`,
    ...partial,
  }
}

describe('pickExitFromPool / rankExits', () => {
  it('prefers lower useCount, then lower banCount, then stable hash', () => {
    const accountId = 'acc-1'
    const exits = [
      exit({ id: 'a', useCount: 5, banCount: 0 }),
      exit({ id: 'b', useCount: 1, banCount: 2 }),
      exit({ id: 'c', useCount: 1, banCount: 0 }),
      exit({ id: 'd', useCount: 1, banCount: 0 }),
    ]
    const ranked = rankExits(accountId, exits)
    expect(ranked[0]!.useCount).toBe(1)
    expect(ranked[0]!.banCount).toBe(0)
    // among c and d (same use/ban), sticky hash decides
    const hc = hashAccountId(`${accountId}\0c`)
    const hd = hashAccountId(`${accountId}\0d`)
    const expectedFirst = hc <= hd ? 'c' : 'd'
    expect(ranked[0]!.id).toBe(expectedFirst)
    expect(ranked.map((e) => e.id).slice(0, 2).sort()).toEqual(['c', 'd'])
    expect(pickExitFromPool(accountId, exits).id).toBe(expectedFirst)
  })

  it('excludes disabled and cooling exits', () => {
    const now = 1_000_000
    const exits = [
      exit({ id: 'ok', useCount: 10 }),
      exit({ id: 'dis', useCount: 0, disabled: true }),
      exit({ id: 'cool', useCount: 0, cooldownUntil: now + 60_000 }),
      exit({ id: 'bare', useCount: 0, outboundProxyUrl: undefined }),
    ]
    const ranked = rankExits('acc', exits, { now })
    expect(ranked.map((e) => e.id)).toEqual(['ok'])
  })

  it('excludeIds skips current exit', () => {
    const exits = [
      exit({ id: 'cur', useCount: 0 }),
      exit({ id: 'next', useCount: 1 }),
    ]
    expect(pickExitFromPool('acc', exits, { excludeIds: ['cur'] }).id).toBe('next')
  })
})
