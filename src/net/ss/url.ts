/**
 * Parse / build Shadowsocks URLs.
 * Preferred canonical form: ss://method:password@host:port
 * (password URL-encoded so `#` becomes `%23`).
 */
import { normalizeMethod } from './crypto.js'

export interface SsEndpoint {
  method: string
  password: string
  server: string
  port: number
  /** Optional tag / remark from SIP002 fragment */
  tag?: string
}

function decodeUserinfoPassword(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function tryDecodeBase64(s: string): string | null {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  try {
    return Buffer.from(normalized + pad, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Parse ss:// URLs:
 * - ss://method:password@host:port
 * - ss://BASE64(method:password)@host:port   (SIP002)
 * - ss://BASE64(method:password@host:port)   (legacy)
 */
export function parseSsUrl(raw: string): SsEndpoint {
  const trimmed = raw.trim()
  if (!trimmed.toLowerCase().startsWith('ss://')) {
    throw new Error(`Not an ss:// URL: ${raw}`)
  }

  let rest = trimmed.slice('ss://'.length)
  let tag: string | undefined
  const hashIdx = rest.indexOf('#')
  if (hashIdx >= 0) {
    tag = decodeURIComponent(rest.slice(hashIdx + 1))
    rest = rest.slice(0, hashIdx)
  }
  // strip query if any
  const qIdx = rest.indexOf('?')
  if (qIdx >= 0) rest = rest.slice(0, qIdx)

  // Form: method:password@host:port  OR  base64userinfo@host:port
  const atIdx = rest.lastIndexOf('@')
  if (atIdx >= 0) {
    const userinfo = rest.slice(0, atIdx)
    const hostport = rest.slice(atIdx + 1)
    const { server, port } = splitHostPort(hostport)

    if (userinfo.includes(':') && !looksLikeBase64Only(userinfo)) {
      const colon = userinfo.indexOf(':')
      const method = normalizeMethod(decodeUserinfoPassword(userinfo.slice(0, colon)))
      const password = decodeUserinfoPassword(userinfo.slice(colon + 1))
      return { method, password, server, port, tag }
    }

    const decoded = tryDecodeBase64(userinfo)
    if (!decoded || !decoded.includes(':')) {
      throw new Error(`Invalid ss:// userinfo in ${raw}`)
    }
    const colon = decoded.indexOf(':')
    return {
      method: normalizeMethod(decoded.slice(0, colon)),
      password: decoded.slice(colon + 1),
      server,
      port,
      tag,
    }
  }

  // Legacy: entire blob base64(method:password@host:port)
  const decoded = tryDecodeBase64(rest)
  if (!decoded) throw new Error(`Invalid ss:// URL (not base64): ${raw}`)
  const legacyAt = decoded.lastIndexOf('@')
  if (legacyAt < 0) throw new Error(`Invalid legacy ss:// payload: ${raw}`)
  const userinfo = decoded.slice(0, legacyAt)
  const hostport = decoded.slice(legacyAt + 1)
  const colon = userinfo.indexOf(':')
  if (colon < 0) throw new Error(`Invalid legacy ss:// userinfo: ${raw}`)
  const { server, port } = splitHostPort(hostport)
  return {
    method: normalizeMethod(userinfo.slice(0, colon)),
    password: userinfo.slice(colon + 1),
    server,
    port,
    tag,
  }
}

function looksLikeBase64Only(s: string): boolean {
  // If it has unencoded method:password with recognizable method names, prefer that.
  const lower = s.toLowerCase()
  if (
    lower.startsWith('aes-') ||
    lower.startsWith('aes_') ||
    lower.startsWith('chacha') ||
    lower.startsWith('aead_')
  ) {
    return false
  }
  return /^[A-Za-z0-9+/=_-]+$/.test(s) && !s.includes('%')
}

function splitHostPort(hostport: string): { server: string; port: number } {
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']')
    if (end < 0) throw new Error(`Invalid IPv6 host in ss://: ${hostport}`)
    const server = hostport.slice(1, end)
    const portPart = hostport.slice(end + 1)
    if (!portPart.startsWith(':')) throw new Error(`Missing port in ss://: ${hostport}`)
    const port = Number(portPart.slice(1))
    if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid port in ss://: ${hostport}`)
    return { server, port }
  }
  const colon = hostport.lastIndexOf(':')
  if (colon < 0) throw new Error(`Missing port in ss://: ${hostport}`)
  const server = hostport.slice(0, colon)
  const port = Number(hostport.slice(colon + 1))
  if (!server || !Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid host:port in ss://: ${hostport}`)
  }
  return { server, port }
}

/** Canonical ss://method:password@host:port (password percent-encoded). */
export function buildSsUrl(ep: SsEndpoint): string {
  const method = normalizeMethod(ep.method)
  const password = encodeURIComponent(ep.password)
  const host = ep.server.includes(':') ? `[${ep.server}]` : ep.server
  let url = `ss://${method}:${password}@${host}:${ep.port}`
  if (ep.tag) url += `#${encodeURIComponent(ep.tag)}`
  return url
}

export function buildSsUrlFromFields(fields: {
  server: string
  port: number
  method: string
  password: string
  id?: string
}): string {
  return buildSsUrl({
    method: fields.method,
    password: fields.password,
    server: fields.server,
    port: fields.port,
    tag: fields.id,
  })
}
