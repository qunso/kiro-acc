/**
 * undici Agent whose connect() opens a native Shadowsocks AEAD tunnel
 * (no sslocal / ss-local process).
 */
import { once } from 'node:events'
import tls, { type ConnectionOptions } from 'node:tls'
import { Agent, type Dispatcher } from 'undici'
import { openSsTunnel } from './tunnel.js'
import { parseSsUrl, type SsEndpoint } from './url.js'
import { TlsSessionCache } from './tlsSessionCache.js'

/**
 * ALPN list undici's built-in connector would pass to `tls.connect`.
 *
 * undici@7 (`lib/core/connect.js`) does not put `ALPNProtocols` on the custom
 * connect callback. It sets the list from `allowH2`, which defaults to false
 * (`['http/1.1']`). `allowH2: true` offers `['http/1.1', 'h2']`. Client copies
 * `allowH2` onto the callback options only when the dispatcher was constructed
 * with that option. An explicit `ALPNProtocols` on the callback is forwarded.
 */
export function alpnProtocolsForUndiciConnect(opts: {
  ALPNProtocols?: ConnectionOptions['ALPNProtocols']
  allowH2?: boolean
}): NonNullable<ConnectionOptions['ALPNProtocols']> {
  if (opts.ALPNProtocols != null) return opts.ALPNProtocols
  return opts.allowH2 ? ['http/1.1', 'h2'] : ['http/1.1']
}

export { TlsSessionCache } from './tlsSessionCache.js'

export function createSsDispatcher(ssUrl: string): Dispatcher {
  const endpoint: SsEndpoint = parseSsUrl(ssUrl)
  // Per-dispatcher cache: sticky SS HTTPS warm connects can reuse tickets /
  // PSKs (ClientHello extension 0x0029) like direct undici. Performance /
  // undici-parity session reuse, not fingerprint mimicry.
  const sessionCache = new TlsSessionCache(64)

  return new Agent({
    connect: (opts, callback) => {
      void (async () => {
        try {
          const targetHost = opts.hostname
          const targetPort =
            Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80)

          const tunnel = await openSsTunnel({
            ...endpoint,
            targetHost,
            targetPort,
          })

          if (opts.protocol === 'https:') {
            const connectOpts = opts as typeof opts & {
              ALPNProtocols?: ConnectionOptions['ALPNProtocols']
              allowH2?: boolean
            }
            const servername = opts.servername || targetHost
            const cachedSession = sessionCache.get(servername, targetPort)
            const socket = tls.connect({
              socket: tunnel as never,
              servername,
              ALPNProtocols: alpnProtocolsForUndiciConnect(connectOpts),
              ...(cachedSession ? { session: cachedSession } : {}),
            })

            const cacheSession = (session: Buffer) => {
              sessionCache.set(servername, targetPort, session)
            }
            socket.on('session', cacheSession)

            try {
              await once(socket, 'secureConnect')
              const fromSocket = socket.getSession()
              if (fromSocket) cacheSession(fromSocket)
              callback(null, socket)
            } catch (err) {
              sessionCache.invalidate(servername, targetPort)
              throw err
            }
            return
          }

          callback(null, tunnel as never)
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)), null)
        }
      })()
    },
  })
}
