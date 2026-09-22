/**
 * undici Agent whose connect() opens a native Shadowsocks AEAD tunnel
 * (no sslocal / ss-local process).
 */
import { once } from 'node:events'
import tls from 'node:tls'
import { Agent, type Dispatcher } from 'undici'
import { openSsTunnel } from './tunnel.js'
import { parseSsUrl, type SsEndpoint } from './url.js'

export function createSsDispatcher(ssUrl: string): Dispatcher {
  const endpoint: SsEndpoint = parseSsUrl(ssUrl)

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
            const socket = tls.connect({
              socket: tunnel as never,
              servername: opts.servername || targetHost,
            })
            await once(socket, 'secureConnect')
            callback(null, socket)
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
