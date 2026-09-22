/**
 * Shadowsocks AEAD TCP tunnel (SIP004).
 * Opens TCP to SS server, sends encrypted address header, returns a Duplex
 * that exposes plaintext to the caller (suitable for undici / tls.connect).
 */
import net from 'node:net'
import { Duplex } from 'node:stream'
import {
  AeadDecryptor,
  AeadEncryptor,
  deriveMasterKey,
  deriveSubkey,
  encodeAddressHeader,
  getCipherSpec,
  randomSalt,
  type SsCipherSpec,
} from './crypto.js'
import type { SsEndpoint } from './url.js'

const MAX_CHUNK = 0x3fff

export interface OpenSsTunnelOptions extends SsEndpoint {
  targetHost: string
  targetPort: number
  connectTimeoutMs?: number
}

/**
 * Duplex over an AEAD-framed SS TCP session.
 * Writes are sealed into SS chunks; reads are opened from SS chunks.
 */
class SsAeadDuplex extends Duplex {
  private enc: AeadEncryptor
  private dec: AeadDecryptor | null = null
  private readonly spec: SsCipherSpec
  private readonly masterKey: Buffer
  private readonly socket: net.Socket
  private recvBuf = Buffer.alloc(0)
  private serverSaltPending: boolean
  private readLen = -1 // plaintext payload length expected after length frame
  private destroyedSocket = false

  constructor(
    socket: net.Socket,
    masterKey: Buffer,
    spec: SsCipherSpec,
    enc: AeadEncryptor,
  ) {
    super({ allowHalfOpen: false })
    this.socket = socket
    this.masterKey = masterKey
    this.spec = spec
    this.enc = enc
    this.serverSaltPending = true

    socket.on('data', (chunk: Buffer) => this.onSocketData(chunk))
    socket.on('error', (err) => {
      if (!this.destroyed) this.destroy(err)
    })
    socket.on('close', () => {
      this.destroyedSocket = true
      if (!this.destroyed) {
        this.push(null)
        this.destroy()
      }
    })
    socket.on('end', () => {
      if (!this.destroyed) this.push(null)
    })
  }

  override _read(_size: number): void {
    // pull-based via socket 'data' → push
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      let offset = 0
      const parts: Buffer[] = []
      while (offset < chunk.length) {
        const slice = chunk.subarray(offset, offset + MAX_CHUNK)
        offset += slice.length
        parts.push(this.enc.sealChunk(slice))
      }
      if (parts.length === 0) {
        callback()
        return
      }
      const out = Buffer.concat(parts)
      if (this.socket.destroyed || this.destroyedSocket) {
        callback(new Error('SS tunnel socket closed'))
        return
      }
      this.socket.write(out, callback)
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)))
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(() => callback())
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.socket.destroyed) this.socket.destroy(error || undefined)
    callback(error)
  }

  private onSocketData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk])
    try {
      this.consumeRecv()
    } catch (err) {
      this.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private consumeRecv(): void {
    // Server salt first
    if (this.serverSaltPending) {
      if (this.recvBuf.length < this.spec.saltSize) return
      const salt = this.recvBuf.subarray(0, this.spec.saltSize)
      this.recvBuf = this.recvBuf.subarray(this.spec.saltSize)
      const subkey = deriveSubkey(this.masterKey, salt, this.spec.keySize)
      this.dec = new AeadDecryptor(subkey, this.spec)
      this.serverSaltPending = false
    }

    const dec = this.dec!
    const tag = this.spec.tagSize

    for (;;) {
      if (this.readLen < 0) {
        const need = 2 + tag
        if (this.recvBuf.length < need) return
        const lenPlain = dec.decrypt(this.recvBuf.subarray(0, need))
        this.recvBuf = this.recvBuf.subarray(need)
        this.readLen = lenPlain.readUInt16BE(0)
        if (this.readLen > MAX_CHUNK) {
          throw new Error(`SS peer chunk length too large: ${this.readLen}`)
        }
      }

      const need = this.readLen + tag
      if (this.recvBuf.length < need) return
      const payload = dec.decrypt(this.recvBuf.subarray(0, need))
      this.recvBuf = this.recvBuf.subarray(need)
      this.readLen = -1
      if (payload.length > 0) {
        if (!this.push(payload)) {
          this.socket.pause()
          this.once('drain', () => {
            this.socket.resume()
            try {
              this.consumeRecv()
            } catch (err) {
              this.destroy(err instanceof Error ? err : new Error(String(err)))
            }
          })
          return
        }
      }
    }
  }
}

export async function openSsTunnel(opts: OpenSsTunnelOptions): Promise<Duplex> {
  const spec = getCipherSpec(opts.method)
  const masterKey = deriveMasterKey(opts.password, opts.method)
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: opts.server, port: opts.port })
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error(`SS connect timeout ${opts.server}:${opts.port}`))
    }, connectTimeoutMs)
    s.once('connect', () => {
      clearTimeout(timer)
      resolve(s)
    })
    s.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  const clientSalt = randomSalt(spec.saltSize)
  const encSubkey = deriveSubkey(masterKey, clientSalt, spec.keySize)
  const enc = new AeadEncryptor(encSubkey, spec)

  const addr = encodeAddressHeader(opts.targetHost, opts.targetPort)
  const firstChunk = enc.sealChunk(addr)

  await new Promise<void>((resolve, reject) => {
    socket.write(Buffer.concat([clientSalt, firstChunk]), (err) => {
      if (err) reject(err)
      else resolve()
    })
  })

  return new SsAeadDuplex(socket, masterKey, spec, enc)
}
