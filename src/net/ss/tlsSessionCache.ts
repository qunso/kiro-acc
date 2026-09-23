/**
 * Bounded LRU cache of TLS session tickets / PSKs for sticky Shadowsocks
 * HTTPS outbound.
 *
 * Purpose: performance / undici-parity session reuse on warm connects so the
 * ClientHello can include extension 0x0029 (pre_shared_key) when a cached
 * ticket is available. This is not fingerprint mimicry and does not forge
 * ClientHello / JA4.
 */
export class TlsSessionCache {
  private readonly maxEntries: number
  /** Insertion order = LRU: oldest at the front of the Map. */
  private readonly map = new Map<string, Buffer>()

  constructor(maxEntries = 64) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new Error('TlsSessionCache maxEntries must be >= 1')
    }
    this.maxEntries = Math.floor(maxEntries)
  }

  static cacheKey(servername: string, port: number): string {
    return `${servername}:${port}`
  }

  get size(): number {
    return this.map.size
  }

  get(servername: string, port: number): Buffer | undefined {
    const key = TlsSessionCache.cacheKey(servername, port)
    const session = this.map.get(key)
    if (!session) return undefined
    // Touch for LRU: move to the end (most recently used).
    this.map.delete(key)
    this.map.set(key, session)
    return session
  }

  set(servername: string, port: number, session: Buffer): void {
    const key = TlsSessionCache.cacheKey(servername, port)
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, session)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  invalidate(servername: string, port: number): void {
    this.map.delete(TlsSessionCache.cacheKey(servername, port))
  }

  clear(): void {
    this.map.clear()
  }
}
