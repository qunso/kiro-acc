/**
 * Accept the headless account JSON plus the original manager's OIDC /
 * credentials export and card-key lines
 * (`email----password----RefreshToken----ClientId----ClientSecret----idp`).
 * Account passwords from card keys are not stored.
 */
import type { AccountCreateInput, AccountRecord } from './types.js'

export interface ImportWarning {
  index: number
  message: string
}

export interface NormalizedImport {
  mode: 'merge' | 'replace'
  accounts: AccountCreateInput[]
  warnings: ImportWarning[]
}

const TOKEN_KEYS = {
  accessToken: ['accessToken', 'access_token', 'AccessToken'],
  refreshToken: ['refreshToken', 'refresh_token', 'RefreshToken'],
  clientId: ['clientId', 'client_id', 'ClientId'],
  clientSecret: ['clientSecret', 'client_secret', 'ClientSecret'],
  region: ['region', 'Region'],
  profileArn: ['profileArn', 'profile_arn', 'profileARN'],
  email: ['email', 'Email', '_email'],
  label: ['label', 'nickname', 'name'],
  provider: ['provider', 'idp', 'loginMethod'],
  authMethod: ['authMethod', 'auth_method'],
  id: ['id'],
  expiresAt: ['expiresAt', 'expires_at', 'ExpiresAt'],
  machineId: ['machineId', 'machine_id', 'MachineId', 'machineCode', 'machine_code', '机器码', 'deviceId', 'device_id', 'DeviceId', 'clientDeviceId', 'client_device_id'],
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = obj[key]
    if (value != null && value !== '') return value
  }
  return undefined
}

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t || undefined
}

export function splitCredentialLine(line: string): string[] {
  if (line.includes('----')) return line.split('----')
  if (line.includes('\t')) return line.split('\t')
  return line.split(/\s{2,}/)
}

function parseCardText(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const out: Record<string, unknown>[] = []
  for (const line of lines) {
    const parts = splitCredentialLine(line)
    if (parts.length < 3) continue
    const clientId = parts[3]?.trim() || undefined
    const clientSecret = parts[4]?.trim() || undefined
    const rawIdp = parts[5]?.trim()
    const provider = rawIdp || (!clientId && !clientSecret ? 'Google' : 'BuilderId')
    const email = parts[0]?.trim() || undefined
    const refreshToken = parts[2]?.trim() || undefined
    if (!refreshToken) continue
    out.push({ email, refreshToken, clientId, clientSecret, provider })
  }
  return out
}

function flattenAccount(item: Record<string, unknown>): Record<string, unknown> {
  const cred = isRecord(item.credentials) ? item.credentials : {}
  const out: Record<string, unknown> = { ...item }
  for (const [key, value] of Object.entries(cred)) {
    if (out[key] == null || out[key] === '') out[key] = value
  }
  delete out.credentials
  delete out.password
  return out
}

function parseExpiry(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.round(value * 1000)
    return value
  }
  if (typeof value === 'string') {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && value.trim() !== '') return parseExpiry(asNum)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function mapAuth(
  providerRaw: string | undefined,
  authRaw: string | undefined,
  hasClient: boolean,
  hasRefresh: boolean,
): { authMethod?: AccountRecord['authMethod']; provider?: string } {
  const provider = providerRaw?.trim()
  const method = (authRaw || '').trim().toLowerCase()
  const pl = (provider || '').toLowerCase()
  if (method === 'social' || pl === 'github' || pl === 'google') {
    const name = pl === 'github' ? 'Github' : pl === 'google' ? 'Google' : provider || 'Google'
    return { authMethod: 'social', provider: name }
  }
  if (method === 'external_idp' || pl === 'enterprise') {
    return { authMethod: 'external_idp', provider: provider || 'Enterprise' }
  }
  if (method === 'idc' || method === 'builder_id' || pl === 'builderid' || pl === 'builder_id') {
    return { authMethod: 'IdC', provider: provider || 'BuilderId' }
  }
  if (authRaw?.trim()) {
    return { authMethod: authRaw.trim() as AccountRecord['authMethod'], provider }
  }
  if (hasClient) return { authMethod: 'IdC', provider: provider || 'BuilderId' }
  if (hasRefresh) return { authMethod: 'social', provider: provider || 'Google' }
  return { provider }
}

function toCreateInput(raw: Record<string, unknown>, index: number): {
  account?: AccountCreateInput
  warning?: ImportWarning
} {
  const flat = flattenAccount(raw)
  const accessToken = asString(pick(flat, TOKEN_KEYS.accessToken))
  const refreshToken = asString(pick(flat, TOKEN_KEYS.refreshToken))
  if (!accessToken && !refreshToken) {
    return { warning: { index, message: 'missing accessToken and refreshToken' } }
  }
  const email = asString(pick(flat, TOKEN_KEYS.email))
  const explicitId = asString(pick(flat, TOKEN_KEYS.id))
  const clientId = asString(pick(flat, TOKEN_KEYS.clientId))
  const clientSecret = asString(pick(flat, TOKEN_KEYS.clientSecret))
  const auth = mapAuth(
    asString(pick(flat, TOKEN_KEYS.provider)),
    asString(pick(flat, TOKEN_KEYS.authMethod)),
    !!(clientId && clientSecret),
    !!refreshToken,
  )
  const label = asString(pick(flat, TOKEN_KEYS.label)) || email
  const group = asString(flat.group)
  const tags = Array.isArray(flat.tags) ? flat.tags.map((t) => String(t)) : undefined
  const input: AccountCreateInput = {
    id: explicitId || (email ? `acct:${email.toLowerCase()}` : undefined),
    label: label || explicitId || 'account',
    email,
    accessToken: accessToken || '',
    refreshToken,
    clientId,
    clientSecret,
    region: asString(pick(flat, TOKEN_KEYS.region)),
    profileArn: asString(pick(flat, TOKEN_KEYS.profileArn)),
    authMethod: auth.authMethod,
    provider: auth.provider,
    expiresAt: parseExpiry(pick(flat, TOKEN_KEYS.expiresAt)),
    enabled: flat.enabled === false ? false : true,
    group,
    tags,
    outboundProxyUrl: asString(flat.outboundProxyUrl),
    outboundExitId: asString(flat.outboundExitId),
    outboundPoolId: asString(flat.outboundPoolId),
    machineId: asString(pick(flat, TOKEN_KEYS.machineId)),
    // Keep deviceId mirrored for older clients that only read that key.
    deviceId: asString(pick(flat, TOKEN_KEYS.machineId)),
  }
  return { account: input }
}

function collectItems(body: unknown): { mode: 'merge' | 'replace'; items: unknown[]; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = []
  if (Array.isArray(body)) return { mode: 'merge', items: body, warnings }
  if (!isRecord(body)) return { mode: 'merge', items: [], warnings }
  const mode = body.mode === 'replace' ? 'replace' : 'merge'
  if (typeof body.text === 'string' && body.text.trim()) {
    const cards = parseCardText(body.text)
    if (!cards.length) warnings.push({ index: -1, message: 'no card-key lines recognized' })
    return { mode, items: cards, warnings }
  }
  if (Array.isArray(body.accounts)) return { mode, items: body.accounts, warnings }
  if (
    pick(body, TOKEN_KEYS.accessToken) ||
    pick(body, TOKEN_KEYS.refreshToken) ||
    isRecord(body.credentials)
  ) {
    return { mode, items: [body], warnings }
  }
  return { mode, items: [], warnings }
}

export function normalizeAccountImport(body: unknown): NormalizedImport {
  const { mode, items, warnings } = collectItems(body)
  const accounts: AccountCreateInput[] = []
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      warnings.push({ index, message: 'account entry is not an object' })
      return
    }
    const result = toCreateInput(item, index)
    if (result.warning) warnings.push(result.warning)
    if (result.account) accounts.push(result.account)
  })
  return { mode, accounts, warnings }
}
