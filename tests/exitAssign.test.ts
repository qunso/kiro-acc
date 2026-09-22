import { describe, it, expect } from 'vitest'
import { hashAccountId, pickExitId } from '../src/exits/assign.js'

describe('exit sticky hash', () => {
  const exits = Array.from({ length: 245 }, (_, i) => `ss1-${i}`)

  it('is stable for the same accountId', () => {
    const a = pickExitId('acc-abc', exits, 'sticky')
    const b = pickExitId('acc-abc', exits, 'sticky')
    expect(a).toBe(b)
  })

  it('matches hash modulo length', () => {
    const id = 'user-9'
    expect(pickExitId(id, exits, 'sticky')).toBe(exits[hashAccountId(id) % exits.length])
  })

  it('round-robin uses counter', () => {
    expect(pickExitId('x', exits, 'round-robin', 0)).toBe('ss1-0')
    expect(pickExitId('x', exits, 'round-robin', 244)).toBe('ss1-244')
    expect(pickExitId('x', exits, 'round-robin', 245)).toBe('ss1-0')
  })
})
