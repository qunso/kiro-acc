import { afterEach, describe, expect, it } from 'vitest'
import {
  closeOutboundDispatchers,
  getOutboundDispatcher,
  normalizeProxyUrl,
  resolveOutboundProxyUrl,
} from '../src/net/outboundDispatcher.js'

describe('normalizeProxyUrl', () => {
  it('keeps http(s) proxies', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7890')).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:7890',
    })
    expect(normalizeProxyUrl('https://proxy.example:8443').kind).toBe('http')
  })

  it('accepts socks5 and socks', () => {
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toEqual({
      kind: 'socks5',
      url: 'socks5://127.0.0.1:1080',
    })
    expect(normalizeProxyUrl('socks://127.0.0.1:1080').kind).toBe('socks5')
  })

  it('maps socks5h to socks5 for undici', () => {
    const r = normalizeProxyUrl('socks5h://127.0.0.1:1080')
    expect(r.kind).toBe('socks5')
    expect(r.url.startsWith('socks5://')).toBe(true)
    expect(r.url).toContain('127.0.0.1:1080')
  })

  it('preserves userinfo when rewriting socks5h', () => {
    const r = normalizeProxyUrl('socks5h://user:p%40ss@10.0.0.2:1080')
    expect(r.url).toMatch(/^socks5:\/\//)
    expect(r.url).toContain('user:')
    expect(r.url).toContain('10.0.0.2:1080')
  })

  it('accepts ss:// and canonicalizes password encoding', () => {
    const r = normalizeProxyUrl('ss://aes-256-gcm:secret%2317@1.2.3.4:60123')
    expect(r.kind).toBe('ss')
    expect(r.url).toBe('ss://aes-256-gcm:secret%2317@1.2.3.4:60123')
  })

  it('rejects socks4', () => {
    expect(() => normalizeProxyUrl('socks4://127.0.0.1:1080')).toThrow(/SOCKS4/)
  })

  it('rejects unknown schemes', () => {
    expect(() => normalizeProxyUrl('ftp://127.0.0.1:21')).toThrow(/Unsupported/)
  })
})

describe('resolveOutboundProxyUrl', () => {
  const keys = [
    'ALL_PROXY',
    'all_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
  ] as const
  const saved: Record<string, string | undefined> = {}

  afterEach(async () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await closeOutboundDispatchers()
  })

  function clearEnv() {
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  }

  it('prefers account proxy over env', () => {
    clearEnv()
    process.env.HTTPS_PROXY = 'http://env:1'
    expect(resolveOutboundProxyUrl('socks5h://127.0.0.1:1080')).toBe(
      'socks5h://127.0.0.1:1080',
    )
  })

  it('falls back to ALL_PROXY then HTTPS_PROXY', () => {
    clearEnv()
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    expect(resolveOutboundProxyUrl()).toBe('socks5://127.0.0.1:1080')
    delete process.env.ALL_PROXY
    expect(resolveOutboundProxyUrl()).toBe('http://127.0.0.1:7890')
  })
})

describe('getOutboundDispatcher', () => {
  afterEach(async () => {
    await closeOutboundDispatchers()
  })

  it('builds Socks5ProxyAgent for socks5h without throwing', () => {
    const d = getOutboundDispatcher('socks5h://127.0.0.1:11080')
    expect(d).toBeTruthy()
    expect(d!.constructor.name).toBe('Socks5ProxyAgent')
  })

  it('builds ProxyAgent for http', () => {
    const d = getOutboundDispatcher('http://127.0.0.1:7890')
    expect(d).toBeTruthy()
    expect(d!.constructor.name).toBe('ProxyAgent')
  })

  it('builds Agent for ss:// without throwing', () => {
    const d = getOutboundDispatcher('ss://aes-256-gcm:secret%2317@127.0.0.1:60123')
    expect(d).toBeTruthy()
    expect(d!.constructor.name).toBe('Agent')
  })

  it('caches by original url string', () => {
    const a = getOutboundDispatcher('socks5://127.0.0.1:1080')
    const b = getOutboundDispatcher('socks5://127.0.0.1:1080')
    expect(a).toBe(b)
  })

  it('caches ss:// by canonical url', () => {
    const a = getOutboundDispatcher('ss://aes-256-gcm:p%23x@10.0.0.1:1')
    const b = getOutboundDispatcher('ss://aes-256-gcm:p%23x@10.0.0.1:1')
    expect(a).toBe(b)
  })
})
