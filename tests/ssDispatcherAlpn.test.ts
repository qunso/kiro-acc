import net from 'node:net'
import { Agent, request } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import * as tunnel from '../src/net/ss/tunnel.js'
import {
  alpnProtocolsForUndiciConnect,
  createSsDispatcher,
} from '../src/net/ss/dispatcher.js'

/** TLS extension type for ALPN (RFC 7301). JA4 counts this as extension 16. */
const ALPN_EXTENSION = 16

describe('alpnProtocolsForUndiciConnect', () => {
  it('matches undici 7 default connector (allowH2 unset → http/1.1)', () => {
    expect(alpnProtocolsForUndiciConnect({})).toEqual(['http/1.1'])
    expect(alpnProtocolsForUndiciConnect({ allowH2: false })).toEqual(['http/1.1'])
  })

  it('matches undici allowH2 order: http/1.1 then h2', () => {
    expect(alpnProtocolsForUndiciConnect({ allowH2: true })).toEqual(['http/1.1', 'h2'])
  })

  it('forwards an explicit ALPNProtocols list from connect opts', () => {
    expect(
      alpnProtocolsForUndiciConnect({
        allowH2: true,
        ALPNProtocols: ['h2', 'http/1.1'],
      }),
    ).toEqual(['h2', 'http/1.1'])
  })
})

describe('SS https ClientHello ALPN', () => {
  it('includes ALPN extension 16 with the same protocols as a direct undici Agent', async () => {
    const direct = await captureDirectAgentClientHello()
    const viaSs = await captureSsClientHello()

    const directAlpn = clientHelloExtension(direct, ALPN_EXTENSION)
    const ssAlpn = clientHelloExtension(viaSs, ALPN_EXTENSION)

    // JA4's trailing token is the first ALPN id (`http/1.1` → `h1`). Missing
    // extension 16 drops that token (t13d…h1 vs t13d… with one fewer extension).
    expect(decodeAlpn(directAlpn)).toEqual(['http/1.1'])
    expect(ssAlpn).toEqual(directAlpn)
    expect(ja4AlpnToken(decodeAlpn(ssAlpn))).toBe('h1')
  })
})

function ja4AlpnToken(protocols: string[] | null): string {
  const first = protocols?.[0]
  if (!first) return '00'
  if (first === 'http/1.1') return 'h1'
  if (first.startsWith('h')) return first.slice(0, 2)
  return first.slice(0, 2)
}

async function captureDirectAgentClientHello(): Promise<Buffer> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as net.AddressInfo).port
  const agent = new Agent()
  const hello = new Promise<Buffer>((resolve, reject) => {
    server.once('connection', (sock) => {
      readTlsRecord(sock).then(
        (record) => {
          sock.destroy()
          resolve(record)
        },
        reject,
      )
    })
  })
  const pending = request(`https://127.0.0.1:${port}/`, { dispatcher: agent }).then(
    () => {},
    () => {},
  )
  try {
    return await hello
  } finally {
    server.close()
    await pending
    await agent.close()
  }
}

async function captureSsClientHello(): Promise<Buffer> {
  const [local, remote] = await connectedPair()
  const spy = vi.spyOn(tunnel, 'openSsTunnel').mockResolvedValue(local)
  const dispatcher = createSsDispatcher('ss://aes-256-gcm:secret@127.0.0.1:8388')
  const hello = readTlsRecord(remote).finally(() => {
    remote.destroy()
    local.destroy()
  })
  const pending = request('https://example.com/', { dispatcher }).then(
    () => {},
    () => {},
  )
  try {
    return await hello
  } finally {
    spy.mockRestore()
    await pending
    await dispatcher.close()
  }
}

function connectedPair(): Promise<[net.Socket, net.Socket]> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      const client = net.connect(port, '127.0.0.1')
      client.once('error', reject)
      server.once('connection', (peer) => {
        server.close()
        resolve([client, peer])
      })
    })
  })
}

function readTlsRecord(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for TLS record'))
    }, 3000)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 5) return
      const len = buf.readUInt16BE(3)
      if (buf.length >= 5 + len) {
        cleanup()
        resolve(Buffer.from(buf.subarray(0, 5 + len)))
      }
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    function cleanup() {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

/** Payload of one ClientHello extension, or null when that extension is absent. */
function clientHelloExtension(record: Buffer, extensionType: number): Buffer | null {
  if (record.length < 5 || record[0] !== 0x16) {
    throw new Error(`expected TLS handshake record, got ${record.subarray(0, 5).toString('hex')}`)
  }
  const recLen = record.readUInt16BE(3)
  const hs = record.subarray(5, 5 + recLen)
  if (hs.length < 4 || hs[0] !== 0x01) throw new Error('expected ClientHello')

  let o = 4 + 2 + 32
  if (o >= hs.length) throw new Error('truncated ClientHello')
  const sidLen = hs[o]!
  o += 1 + sidLen
  if (o + 2 > hs.length) throw new Error('truncated ClientHello')
  const csLen = hs.readUInt16BE(o)
  o += 2 + csLen
  if (o >= hs.length) throw new Error('truncated ClientHello')
  const compLen = hs[o]!
  o += 1 + compLen
  if (o + 2 > hs.length) return null
  const extLen = hs.readUInt16BE(o)
  o += 2
  const extEnd = o + extLen
  if (extEnd > hs.length) throw new Error('truncated ClientHello extensions')

  while (o + 4 <= extEnd) {
    const type = hs.readUInt16BE(o)
    const len = hs.readUInt16BE(o + 2)
    o += 4
    if (o + len > extEnd) throw new Error('truncated ClientHello extension')
    if (type === extensionType) return Buffer.from(hs.subarray(o, o + len))
    o += len
  }
  return null
}

function decodeAlpn(ext: Buffer | null): string[] | null {
  if (!ext) return null
  if (ext.length < 2) return []
  const listEnd = Math.min(ext.length, 2 + ext.readUInt16BE(0))
  const out: string[] = []
  let p = 2
  while (p < listEnd) {
    const n = ext[p]!
    p += 1
    if (p + n > listEnd) break
    out.push(ext.subarray(p, p + n).toString('ascii'))
    p += n
  }
  return out
}
