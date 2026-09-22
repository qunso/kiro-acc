/**
 * Outbound proxy dispatcher for HTTP(S) and SOCKS5 / SOCKS5h.
 * Uses undici ProxyAgent + Socks5ProxyAgent (experimental SOCKS5 in undici 7).
 */
import {
  ProxyAgent,
  Socks5ProxyAgent,
  type Dispatcher,
} from 'undici'

const dispatcherCache = new Map<string, Dispatcher>()

/** Resolve proxy URL: per-account override, then ALL_PROXY / HTTPS_PROXY / HTTP_PROXY. */
export function resolveOutboundProxyUrl(accountProxyUrl?: string | null): string | undefined {
  const raw =
    accountProxyUrl?.trim() ||
    process.env.ALL_PROXY?.trim() ||
    process.env.all_proxy?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    ''
  return raw || undefined
}

export type ProxyKind = 'http' | 'socks5'

/**
 * Normalize user-facing proxy URLs for undici constructors.
 * - http:// / https:// → ProxyAgent
 * - socks5:// / socks:// / socks5h:// → Socks5ProxyAgent (socks5h rewritten to socks5://;
 *   undici sends DOMAIN ATYP so DNS is resolved by the proxy — i.e. socks5h semantics)
 */
export function normalizeProxyUrl(raw: string): { kind: ProxyKind; url: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid proxy URL: ${raw}`)
  }

  const protocol = parsed.protocol.toLowerCase()

  if (protocol === 'http:' || protocol === 'https:') {
    return { kind: 'http', url: raw }
  }

  if (protocol === 'socks5:' || protocol === 'socks:' || protocol === 'socks5h:') {
    // undici Socks5ProxyAgent only accepts socks5:// or socks://
    parsed.protocol = 'socks5:'
    return { kind: 'socks5', url: parsed.toString() }
  }

  if (protocol === 'socks4:' || protocol === 'socks4a:') {
    throw new Error(
      `SOCKS4 is not supported; use socks5:// or socks5h:// (got ${protocol} in ${raw})`,
    )
  }

  throw new Error(
    `Unsupported proxy protocol "${protocol}". Use http://, https://, socks5://, or socks5h://`,
  )
}

/** Create (and cache) an undici Dispatcher for the given proxy URL. */
export function getOutboundDispatcher(proxyUrl?: string | null): Dispatcher | undefined {
  if (!proxyUrl) return undefined

  const cached = dispatcherCache.get(proxyUrl)
  if (cached) return cached

  const { kind, url } = normalizeProxyUrl(proxyUrl)
  const dispatcher: Dispatcher =
    kind === 'socks5' ? new Socks5ProxyAgent(url) : new ProxyAgent(url)

  dispatcherCache.set(proxyUrl, dispatcher)
  return dispatcher
}

/** Convenience: resolve from account + env, then return dispatcher. */
export function getDispatcherForAccount(accountProxyUrl?: string | null): Dispatcher | undefined {
  return getOutboundDispatcher(resolveOutboundProxyUrl(accountProxyUrl))
}

/** Test helper / shutdown: close and clear cached dispatchers. */
export async function closeOutboundDispatchers(): Promise<void> {
  const agents = [...dispatcherCache.values()]
  dispatcherCache.clear()
  await Promise.all(
    agents.map(
      (d) =>
        new Promise<void>((resolve) => {
          d.close(() => resolve())
        }),
    ),
  )
}
