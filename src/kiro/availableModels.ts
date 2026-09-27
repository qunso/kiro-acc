/**
 * Live Kiro model discovery via ListAvailableModels (same op as Kiro IDE/CLI picker).
 *
 * GET https://q.{region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR
 * Authorization: Bearer <accessToken>
 * → { models: [{ modelId, modelName?, tokenLimits? }, ...] }
 *
 * Catalog is per-account / per-tier; do not invent ids — only cache what upstream returns.
 * Sticky outbound via getDispatcherForAccount (same SS/undici path as chat). No JA4/MITM.
 */
import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { AccountRecord } from '../accounts/types.js'
import { normalizeModelIdList } from '../accounts/upstream.js'
import {
  buildKiroAmzUserAgent,
  buildKiroUserAgent,
  resolveMachineIdForRequest,
} from '../accounts/machineId.js'
import { getDispatcherForAccount } from '../net/outboundDispatcher.js'
import { isPlaceholderProfileArn } from './auth.js'
import { getKiroIdeVersion } from './ideVersion.js'
import { profileArnForUsageLimits } from './usageLimits.js'

const AWS_SDK_VERSION_CHAT = '1.0.34'

export class AvailableModelsError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'AvailableModelsError'
  }
}

export interface KiroAvailableModel {
  id: string
  name?: string
}

export interface FetchKiroAvailableModelsResult {
  models: string[]
  /** Raw rows with optional display names when upstream provided them. */
  details: KiroAvailableModel[]
  url: string
  source: 'api'
}

/** Parse ListAvailableModels JSON → ordered unique model ids (+ optional names). */
export function parseKiroAvailableModels(data: unknown): KiroAvailableModel[] {
  if (!data || typeof data !== 'object') return []
  const payload = data as Record<string, unknown>
  const items = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.availableModels)
      ? payload.availableModels
      : []
  const out: KiroAvailableModel[] = []
  const seen = new Set<string>()
  for (const value of items) {
    if (typeof value === 'string') {
      const id = value.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({ id })
      continue
    }
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const idRaw = row.modelId ?? row.id
    const id = typeof idRaw === 'string' ? idRaw.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const nameRaw = row.modelName ?? row.name
    const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : undefined
    out.push(name ? { id, name } : { id })
  }
  return out
}

/**
 * Region for ListAvailableModels: account.region, else region embedded in profileArn,
 * else us-east-1. Matches OmniRoute / Kiro IDE behavior for IdC region-bound tokens.
 */
export function resolveKiroModelsRegion(account: Pick<AccountRecord, 'region' | 'profileArn'>): string {
  const explicit = (account.region || '').trim().toLowerCase()
  if (explicit) return explicit
  const arn = (account.profileArn || '').trim()
  const m = arn.match(/^arn:aws:codewhisperer:([a-z0-9-]+):/i)
  if (m?.[1]) return m[1]!.toLowerCase()
  return 'us-east-1'
}

/** Ordered ListAvailableModels base URLs: region-matched Q host, then us-east-1 fallback. */
export function buildKiroModelsEndpoints(region: string): string[] {
  const normalized = (region || 'us-east-1').trim().toLowerCase() || 'us-east-1'
  const urls = [`https://q.${normalized}.amazonaws.com/ListAvailableModels`]
  if (normalized !== 'us-east-1') {
    urls.push('https://q.us-east-1.amazonaws.com/ListAvailableModels')
  }
  // Last-resort CodeWhisperer home (same host family as getUsageLimits fallback).
  urls.push('https://codewhisperer.us-east-1.amazonaws.com/ListAvailableModels')
  return [...new Set(urls)]
}

function authHeaders(account: AccountRecord): Record<string, string> {
  const machineId = resolveMachineIdForRequest(account)
  const kiroVersion = getKiroIdeVersion()
  const awsSdkVersion = AWS_SDK_VERSION_CHAT
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${account.accessToken}`,
    'user-agent': buildKiroUserAgent({ kiroVersion, awsSdkVersion, machineId }),
    'x-amz-user-agent': buildKiroAmzUserAgent({ kiroVersion, awsSdkVersion, machineId }),
    'amz-sdk-invocation-id': randomUUID(),
    'amz-sdk-request': 'attempt=1; max=3',
  }
  if (account.authMethod === 'external_idp' || account.provider === 'ExternalIdp') {
    headers.TokenType = 'EXTERNAL_IDP'
  }
  return headers
}

async function accountGet(
  account: AccountRecord,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12_000,
): Promise<Response> {
  const dispatcher = getDispatcherForAccount(account.outboundProxyUrl)
  const signal = AbortSignal.timeout(timeoutMs)
  const init: RequestInit = { method: 'GET', headers, signal }
  if (dispatcher) {
    return (await undiciFetch(url, {
      ...init,
      dispatcher,
    } as UndiciRequestInit)) as unknown as Response
  }
  return fetch(url, init)
}

async function tryList(
  account: AccountRecord,
  url: string,
  headers: Record<string, string>,
): Promise<{ details: KiroAvailableModel[]; url: string } | null> {
  const res = await accountGet(account, url, headers)
  const text = await res.text()
  if (!res.ok) {
    // 404/405 → try next endpoint; auth/forbidden may still warrant profileArn retry.
    if (res.status === 404 || res.status === 405) return null
    throw new AvailableModelsError(
      `ListAvailableModels HTTP ${res.status}: ${text.slice(0, 400)}`,
      res.status,
      text,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new AvailableModelsError('ListAvailableModels returned non-JSON', res.status, text)
  }
  const details = parseKiroAvailableModels(json)
  if (!details.length) return null
  return { details, url }
}

/**
 * Fetch the live model list for a Kiro account.
 *
 * Attempt order (stops at first non-empty success):
 * 1. origin=AI_EDITOR on each regional endpoint (Builder ID / social / IdC)
 * 2. origin=AI_EDITOR&profileArn=… on primary endpoint when a real profileArn exists
 *    (desktop-style; omitted by default because Builder ID can 403 with profileArn)
 */
export async function fetchKiroAvailableModels(
  account: AccountRecord,
): Promise<FetchKiroAvailableModelsResult> {
  if (!account.accessToken?.trim()) {
    throw new AvailableModelsError('accessToken is required to list Kiro models', 401)
  }
  const region = resolveKiroModelsRegion(account)
  const endpoints = buildKiroModelsEndpoints(region)
  const headers = authHeaders(account)
  let lastErr: Error | null = null

  for (const base of endpoints) {
    const url = `${base}?origin=AI_EDITOR`
    try {
      const hit = await tryList(account, url, headers)
      if (hit) {
        const models = normalizeModelIdList(hit.details.map((d) => d.id))
        return { models, details: hit.details, url: hit.url, source: 'api' }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      // On 403 with origin-only, continue to next host / profileArn retry.
      if (err instanceof AvailableModelsError && err.statusCode && err.statusCode < 500) {
        continue
      }
      if (err instanceof AvailableModelsError) continue
      throw err
    }
  }

  const profileArn = profileArnForUsageLimits(account)
  if (profileArn && !isPlaceholderProfileArn(profileArn)) {
    const primary = endpoints[0]!
    const url = `${primary}?origin=AI_EDITOR&profileArn=${encodeURIComponent(profileArn)}`
    try {
      const hit = await tryList(account, url, headers)
      if (hit) {
        const models = normalizeModelIdList(hit.details.map((d) => d.id))
        return { models, details: hit.details, url: hit.url, source: 'api' }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw (
    lastErr ||
    new AvailableModelsError('ListAvailableModels returned no models for this account', 502)
  )
}
