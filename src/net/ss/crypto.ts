/**
 * Shadowsocks AEAD crypto helpers (SIP004).
 * Pure Node crypto — no native addons.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

export type SsMethod = 'aes-256-gcm' | 'chacha20-ietf-poly1305' | 'aes-128-gcm'

export interface SsCipherSpec {
  method: SsMethod
  keySize: number
  saltSize: number
  nonceSize: number
  tagSize: number
  /** Node crypto algorithm name */
  algorithm: string
}

const SPECS: Record<string, SsCipherSpec> = {
  'aes-256-gcm': {
    method: 'aes-256-gcm',
    keySize: 32,
    saltSize: 32,
    nonceSize: 12,
    tagSize: 16,
    algorithm: 'aes-256-gcm',
  },
  'aes-128-gcm': {
    method: 'aes-128-gcm',
    keySize: 16,
    saltSize: 16,
    nonceSize: 12,
    tagSize: 16,
    algorithm: 'aes-128-gcm',
  },
  'chacha20-ietf-poly1305': {
    method: 'chacha20-ietf-poly1305',
    keySize: 32,
    saltSize: 32,
    nonceSize: 12,
    tagSize: 16,
    algorithm: 'chacha20-poly1305',
  },
}

/** Normalize aliases used by catalogs / SIP002. */
export function normalizeMethod(raw: string): SsMethod {
  const key = raw.trim().toLowerCase().replace(/-/g, '_')
  const map: Record<string, SsMethod> = {
    aes_256_gcm: 'aes-256-gcm',
    aead_aes_256_gcm: 'aes-256-gcm',
    aes256gcm: 'aes-256-gcm',
    aes_128_gcm: 'aes-128-gcm',
    aead_aes_128_gcm: 'aes-128-gcm',
    chacha20_ietf_poly1305: 'chacha20-ietf-poly1305',
    aead_chacha20_ietf_poly1305: 'chacha20-ietf-poly1305',
    chacha20_poly1305: 'chacha20-ietf-poly1305',
  }
  // also accept already-hyphenated
  const hyphen = raw.trim().toLowerCase()
  if (hyphen === 'aes-256-gcm' || hyphen === 'aes-128-gcm' || hyphen === 'chacha20-ietf-poly1305') {
    return hyphen
  }
  const m = map[key]
  if (!m) {
    throw new Error(
      `Unsupported SS method "${raw}". Supported: aes-256-gcm, chacha20-ietf-poly1305, aes-128-gcm`,
    )
  }
  return m
}

export function getCipherSpec(method: string): SsCipherSpec {
  const m = normalizeMethod(method)
  return SPECS[m]!
}

/** OpenSSL EVP_BytesToKey with MD5, empty salt, count=1 (Shadowsocks convention). */
export function evpBytesToKey(password: string | Buffer, keyLen: number): Buffer {
  const passwordBuf = typeof password === 'string' ? Buffer.from(password, 'utf8') : password
  const parts: Buffer[] = []
  let prev = Buffer.alloc(0)
  while (Buffer.concat(parts).length < keyLen) {
    const h = createHash('md5')
    h.update(prev)
    h.update(passwordBuf)
    prev = h.digest()
    parts.push(prev)
  }
  return Buffer.concat(parts).subarray(0, keyLen)
}

export function deriveMasterKey(password: string, method: string): Buffer {
  const spec = getCipherSpec(method)
  return evpBytesToKey(password, spec.keySize)
}

/** SIP004 subkey: HKDF-SHA1(ikm=masterKey, salt=sessionSalt, info="ss-subkey"). */
export function deriveSubkey(masterKey: Buffer, salt: Buffer, keySize: number): Buffer {
  const out = hkdfSync('sha1', masterKey, salt, Buffer.from('ss-subkey'), keySize)
  return Buffer.from(out)
}

export function randomSalt(saltSize: number): Buffer {
  return randomBytes(saltSize)
}

/** Little-endian 12-byte nonce from uint32/uint64 counter (SS AEAD uses 12-byte LE). */
export function nonceFromCounter(counter: number, nonceSize = 12): Buffer {
  const nonce = Buffer.alloc(nonceSize, 0)
  // write as little-endian u64 in first 8 bytes (counter fits u32 for practical streams)
  nonce.writeUInt32LE(counter >>> 0, 0)
  // high 32 bits stay 0 for counters < 2^32
  return nonce
}

export class AeadEncryptor {
  private counter = 0
  constructor(
    private readonly subkey: Buffer,
    private readonly spec: SsCipherSpec,
  ) {}

  encrypt(plaintext: Buffer): Buffer {
    const nonce = nonceFromCounter(this.counter++, this.spec.nonceSize)
    const cipher = createCipheriv(
      this.spec.algorithm as 'aes-256-gcm',
      this.subkey,
      nonce,
    )
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([enc, tag])
  }

  /** SIP004 chunk: [encrypted 2-byte BE length][tag][encrypted payload][tag] */
  sealChunk(payload: Buffer): Buffer {
    if (payload.length > 0x3fff) {
      throw new Error(`SS chunk too large: ${payload.length} > 0x3fff`)
    }
    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16BE(payload.length, 0)
    const encLen = this.encrypt(lenBuf)
    const encPayload = this.encrypt(payload)
    return Buffer.concat([encLen, encPayload])
  }
}

export class AeadDecryptor {
  private counter = 0
  constructor(
    private readonly subkey: Buffer,
    private readonly spec: SsCipherSpec,
  ) {}

  decrypt(ciphertextAndTag: Buffer): Buffer {
    if (ciphertextAndTag.length < this.spec.tagSize) {
      throw new Error('SS ciphertext too short for tag')
    }
    const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - this.spec.tagSize)
    const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - this.spec.tagSize)
    const nonce = nonceFromCounter(this.counter++, this.spec.nonceSize)
    const decipher = createDecipheriv(
      this.spec.algorithm as 'aes-256-gcm',
      this.subkey,
      nonce,
    )
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  }
}

/** Encode SOCKS-like address for SS TCP header (ATYP + ADDR + PORT). */
export function encodeAddressHeader(host: string, port: number): Buffer {
  if (port < 0 || port > 65535 || !Number.isFinite(port)) {
    throw new Error(`Invalid target port: ${port}`)
  }
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(port, 0)

  // IPv4?
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const parts = ipv4.slice(1).map((x) => Number(x))
    if (parts.every((n) => n >= 0 && n <= 255)) {
      return Buffer.concat([Buffer.from([0x01]), Buffer.from(parts), portBuf])
    }
  }

  // IPv6? (simplified: contains ':' and parse via URL/net)
  if (host.includes(':')) {
    // Try to parse as IPv6
    const normalized = host.replace(/^\[|\]$/g, '')
    const buf = ipv6ToBuffer(normalized)
    if (buf) {
      return Buffer.concat([Buffer.from([0x04]), buf, portBuf])
    }
  }

  // Domain
  const hostBuf = Buffer.from(host, 'utf8')
  if (hostBuf.length > 255) throw new Error('Domain name too long for SS ATYP')
  return Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf, portBuf])
}

function ipv6ToBuffer(host: string): Buffer | null {
  // Expand :: and parse 8 hextets
  try {
    if (host.includes('.')) return null // v4-mapped — skip for simplicity unless pure hex
    const sides = host.split('::')
    if (sides.length > 2) return null
    const head = sides[0] ? sides[0].split(':') : []
    const tail = sides.length === 2 && sides[1] ? sides[1].split(':') : sides.length === 1 ? [] : []
    if (sides.length === 1) {
      const parts = host.split(':')
      if (parts.length !== 8) return null
      const out = Buffer.alloc(16)
      for (let i = 0; i < 8; i++) {
        const n = parseInt(parts[i]!, 16)
        if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
        out.writeUInt16BE(n, i * 2)
      }
      return out
    }
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    const hextets = [...head, ...Array(missing).fill('0'), ...tail]
    if (hextets.length !== 8) return null
    const out = Buffer.alloc(16)
    for (let i = 0; i < 8; i++) {
      const n = parseInt(hextets[i] || '0', 16)
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
      out.writeUInt16BE(n, i * 2)
    }
    return out
  } catch {
    return null
  }
}

/** Round-trip helper for tests: encrypt then decrypt one chunk stream with shared salt. */
export function sealAndOpenForTest(
  method: string,
  password: string,
  plaintext: Buffer,
): Buffer {
  const spec = getCipherSpec(method)
  const master = deriveMasterKey(password, method)
  const salt = randomSalt(spec.saltSize)
  const subkey = deriveSubkey(master, salt, spec.keySize)
  const enc = new AeadEncryptor(subkey, spec)
  const sealed = enc.sealChunk(plaintext)
  const dec = new AeadDecryptor(deriveSubkey(master, salt, spec.keySize), spec)
  // unseal
  const lenCipherLen = 2 + spec.tagSize
  const lenPlain = dec.decrypt(sealed.subarray(0, lenCipherLen))
  const payloadLen = lenPlain.readUInt16BE(0)
  const payloadCipher = sealed.subarray(lenCipherLen, lenCipherLen + payloadLen + spec.tagSize)
  return dec.decrypt(payloadCipher)
}
