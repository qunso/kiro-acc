/**
 * Observe-only TLS / JA4 probe.
 * Fetches a public fingerprint echo (default https://tls.peet.ws/api/all)
 * through the account's existing outbound dispatcher, and optionally once
 * with no proxy. Reports JA3 / JA4 / ALPN / egress IP.
 * Does not set custom ciphers, ALPN lists, or ClientHello templates.
 */
import { fetch as undiciFetch, type Dispatcher } from 'undici'
import { getOutboundDispatcher, normalizeProxyUrl } from '../net/outboundDispatcher.js'

export const DEFAULT_TLS_OBSERVE_URL = 'https://tls.peet.ws/api/all'

export const TLS_PROBE_NOTE =
  'observe-only: reports JA3/JA4/ALPN/egress seen on this process TLS stack via the sticky outbound path and an optional direct baseline. Does not impersonate client fingerprints.'

export interface TlsObservation {
  ok: boolean
  path: 'sticky' | 'direct'
  error?: string
  /** Echo service "ip" field, often ip:port */
  egress?: string
  egressIp?: string
  httpVersion?: string
  ja3?: string
  ja3Hash?: string
  ja4?: string
  ja4R?: string
  alpn?: string[]
  userAgent?: string
}

export interface TlsProbeReport {
  note: string
  url: string
  proxyKind?: 'http' | 'socks5' | 'ss' | 'direct'
  sticky?: TlsObservation
  direct?: TlsObservation
}

type FetchImpl = (
  url: string,
  dispatcher: Dispatcher | undefined,
  timeoutMs: number,
) => Promise<{ status: number; text: string }>

function splitEgress(raw: string | undefined): { egress?: string; egressIp?: string } {
  if (!raw) return {}
  const v4 = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (v4) return { egress: raw, egressIp: v4[1] }
  return { egress: raw, egressIp: raw }
}

function alpnFromExtensions(extensions: unknown): string[] | undefined {
  if (!Array.isArray(extensions)) return undefined
  for (const ext of extensions) {
    if (!ext || typeof ext !== 'object') continue
    const rec = ext as { name?: unknown; protocols?: unknown }
    const name = typeof rec.name === 'string' ? rec.name : ''
    if (!/application_layer_protocol_negotiation/i.test(name)) continue
    if (Array.isArray(rec.protocols)) {
      return rec.protocols.map((p) => String(p))
    }
  }
  return undefined
}

export function parseTlsObservation(body: unknown, path: 'sticky' | 'direct'): TlsObservation {
  if (!body || typeof body !== 'object') {
    return { ok: false, path, error: 'probe body was not JSON' }
  }
  const rec = body as Record<string, unknown>
  const tls = rec.tls && typeof rec.tls === 'object' ? (rec.tls as Record<string, unknown>) : {}
  const egress = splitEgress(typeof rec.ip === 'string' ? rec.ip : undefined)
  const alpn = alpnFromExtensions(tls.extensions)
  const ja4 = typeof tls.ja4 === 'string' ? tls.ja4 : undefined
  const observation: TlsObservation = {
    ok: Boolean(ja4 || tls.ja3 || egress.egressIp),
    path,
    ...egress,
    httpVersion: typeof rec.http_version === 'string' ? rec.http_version : undefined,
    ja3: typeof tls.ja3 === 'string' ? tls.ja3 : undefined,
    ja3Hash: typeof tls.ja3_hash === 'string' ? tls.ja3_hash : undefined,
    ja4,
    ja4R: typeof tls.ja4_r === 'string' ? tls.ja4_r : undefined,
    alpn,
    userAgent: typeof rec.user_agent === 'string' ? rec.user_agent : undefined,
  }
  if (!observation.ok) observation.error = 'echo payload had no JA4/JA3/egress fields'
  return observation
}

export function assertObserveUrl(raw: string | undefined): string {
  const url = (raw || DEFAULT_TLS_OBSERVE_URL).trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('probe url is not a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('probe url must be https')
  return parsed.toString()
}

async function defaultFetch(
  url: string,
  dispatcher: Dispatcher | undefined,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const res = await undiciFetch(url, {
    method: 'GET',
    dispatcher,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function observe(
  path: 'sticky' | 'direct',
  url: string,
  dispatcher: Dispatcher | undefined,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<TlsObservation> {
  try {
    const res = await fetchImpl(url, dispatcher, timeoutMs)
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, path, error: `probe HTTP ${res.status}` }
    }
    let json: unknown
    try {
      json = JSON.parse(res.text)
    } catch {
      return { ok: false, path, error: 'probe response was not JSON' }
    }
    return parseTlsObservation(json, path)
  } catch (err) {
    return {
      ok: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function probeTlsFingerprint(opts: {
  proxyUrl?: string | null
  compareDirect?: boolean
  url?: string
  timeoutMs?: number
  fetchImpl?: FetchImpl
}): Promise<TlsProbeReport> {
  const url = assertObserveUrl(opts.url)
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 20_000
  const fetchImpl = opts.fetchImpl ?? defaultFetch
  const compareDirect = opts.compareDirect !== false
  const proxyUrl = opts.proxyUrl?.trim() || ''

  let proxyKind: TlsProbeReport['proxyKind'] = 'direct'
  let dispatcher: Dispatcher | undefined
  if (proxyUrl) {
    const normalized = normalizeProxyUrl(proxyUrl)
    proxyKind = normalized.kind
    dispatcher = getOutboundDispatcher(proxyUrl)
    if (!dispatcher) {
      return {
        note: TLS_PROBE_NOTE,
        url,
        proxyKind,
        sticky: { ok: false, path: 'sticky', error: 'could not build outbound dispatcher' },
        ...(compareDirect
          ? { direct: await observe('direct', url, undefined, timeoutMs, fetchImpl) }
          : {}),
      }
    }
  }

  const report: TlsProbeReport = { note: TLS_PROBE_NOTE, url, proxyKind }
  if (proxyUrl) {
    report.sticky = await observe('sticky', url, dispatcher, timeoutMs, fetchImpl)
    if (compareDirect) report.direct = await observe('direct', url, undefined, timeoutMs, fetchImpl)
  } else {
    report.sticky = {
      ok: false,
      path: 'sticky',
      error: '账号未配置出站代理，没有可对比的 sticky 路径',
    }
    if (compareDirect) report.direct = await observe('direct', url, undefined, timeoutMs, fetchImpl)
  }
  return report
}
