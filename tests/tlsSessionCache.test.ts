import { describe, expect, it } from 'vitest'
import { TlsSessionCache } from '../src/net/ss/tlsSessionCache.js'

describe('TlsSessionCache', () => {
  it('returns undefined for a miss', () => {
    const cache = new TlsSessionCache(4)
    expect(cache.get('example.com', 443)).toBeUndefined()
  })

  it('stores and returns a session Buffer by servername:port', () => {
    const cache = new TlsSessionCache(4)
    const session = Buffer.from('ticket-a')
    cache.set('example.com', 443, session)
    expect(cache.get('example.com', 443)?.equals(session)).toBe(true)
    expect(cache.get('example.com', 8443)).toBeUndefined()
    expect(cache.get('other.example', 443)).toBeUndefined()
  })

  it('invalidate drops the entry', () => {
    const cache = new TlsSessionCache(4)
    cache.set('a.example', 443, Buffer.from('t'))
    cache.invalidate('a.example', 443)
    expect(cache.get('a.example', 443)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('evicts least-recently-used when over capacity', () => {
    const cache = new TlsSessionCache(2)
    cache.set('a.example', 443, Buffer.from('a'))
    cache.set('b.example', 443, Buffer.from('b'))
    // Touch a so b becomes the LRU victim when c is inserted.
    expect(cache.get('a.example', 443)?.toString()).toBe('a')
    cache.set('c.example', 443, Buffer.from('c'))
    expect(cache.get('b.example', 443)).toBeUndefined()
    expect(cache.get('a.example', 443)?.toString()).toBe('a')
    expect(cache.get('c.example', 443)?.toString()).toBe('c')
    expect(cache.size).toBe(2)
  })

  it('set on an existing key refreshes LRU without growing size', () => {
    const cache = new TlsSessionCache(2)
    cache.set('a.example', 443, Buffer.from('a1'))
    cache.set('b.example', 443, Buffer.from('b'))
    cache.set('a.example', 443, Buffer.from('a2'))
    expect(cache.size).toBe(2)
    expect(cache.get('a.example', 443)?.toString()).toBe('a2')
    // a was refreshed; inserting c should evict b.
    cache.set('c.example', 443, Buffer.from('c'))
    expect(cache.get('b.example', 443)).toBeUndefined()
    expect(cache.get('a.example', 443)?.toString()).toBe('a2')
  })

  it('rejects non-positive maxEntries', () => {
    expect(() => new TlsSessionCache(0)).toThrow(/maxEntries/)
    expect(() => new TlsSessionCache(-1)).toThrow(/maxEntries/)
  })
})
