import { describe, expect, it } from 'vitest'
import {
  encodeAddressHeader,
  evpBytesToKey,
  getCipherSpec,
  normalizeMethod,
  sealAndOpenForTest,
} from '../src/net/ss/crypto.js'
import { buildSsUrl, parseSsUrl } from '../src/net/ss/url.js'

describe('SS crypto', () => {
  it('normalizes method aliases', () => {
    expect(normalizeMethod('AEAD_AES_256_GCM')).toBe('aes-256-gcm')
    expect(normalizeMethod('aes-256-gcm')).toBe('aes-256-gcm')
    expect(normalizeMethod('chacha20-ietf-poly1305')).toBe('chacha20-ietf-poly1305')
  })

  it('EVP_BytesToKey length matches method', () => {
    const k = evpBytesToKey('password', getCipherSpec('aes-256-gcm').keySize)
    expect(k.length).toBe(32)
    const k128 = evpBytesToKey('password', getCipherSpec('aes-128-gcm').keySize)
    expect(k128.length).toBe(16)
  })

  it('round-trips AEAD chunk for aes-256-gcm', () => {
    const plain = Buffer.from('hello shadowsocks aead')
    const out = sealAndOpenForTest('aes-256-gcm', 'SHARED_PASS#17', plain)
    expect(out.equals(plain)).toBe(true)
  })

  it('round-trips AEAD chunk for chacha20-ietf-poly1305', () => {
    const plain = Buffer.from('chacha payload')
    const out = sealAndOpenForTest('chacha20-ietf-poly1305', 'pw', plain)
    expect(out.equals(plain)).toBe(true)
  })

  it('encodes IPv4 / domain address headers', () => {
    const v4 = encodeAddressHeader('1.2.3.4', 443)
    expect(v4[0]).toBe(0x01)
    expect(v4.subarray(1, 5).equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
    expect(v4.readUInt16BE(5)).toBe(443)

    const dom = encodeAddressHeader('example.com', 80)
    expect(dom[0]).toBe(0x03)
    expect(dom[1]).toBe('example.com'.length)
    expect(dom.subarray(2, 2 + 11).toString()).toBe('example.com')
    expect(dom.readUInt16BE(2 + 11)).toBe(80)
  })
})

describe('SS URL', () => {
  it('parses method:password@host:port with encoded #', () => {
    const ep = parseSsUrl('ss://aes-256-gcm:secret%2317@1.2.3.4:60123')
    expect(ep.method).toBe('aes-256-gcm')
    expect(ep.password).toBe('secret#17')
    expect(ep.server).toBe('1.2.3.4')
    expect(ep.port).toBe(60123)
  })

  it('builds canonical URL encoding # in password', () => {
    const url = buildSsUrl({
      method: 'aes-256-gcm',
      password: 'SHARED_PASS#0',
      server: 'ss.example.com',
      port: 60123,
    })
    expect(url).toBe('ss://aes-256-gcm:SHARED_PASS%230@ss.example.com:60123')
    expect(parseSsUrl(url).password).toBe('SHARED_PASS#0')
  })

  it('parses SIP002 userinfo base64', () => {
    const userinfo = Buffer.from('aes-256-gcm:pass#1', 'utf8').toString('base64url')
    const ep = parseSsUrl(`ss://${userinfo}@10.0.0.2:8388`)
    expect(ep.method).toBe('aes-256-gcm')
    expect(ep.password).toBe('pass#1')
    expect(ep.server).toBe('10.0.0.2')
    expect(ep.port).toBe(8388)
  })
})
