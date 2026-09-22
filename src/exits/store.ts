import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'
import { buildSsUrlFromFields } from '../net/ss/url.js'

export interface ExitEntry {
  id: string
  /** SS server hostname / IP */
  server?: string
  port?: number
  method?: string
  /**
   * iqun password forms (all first-class; pools may mix):
   * - `SS_PASS#<index>` — index % len(IP_LIST)
   * - `SS_PASS#<exitIp>` — sticky bindto that IP (must be in host IP_LIST)
   * - `SS_PASS#<tag>` — if suffix is neither decimal index nor IP in IP_LIST,
   *   iqun uses hash(suffix)%N (shared normalize-before-KDF with kiro-acc)
   */
  password?: string
  index?: number
  /** Catalog / expected egress IP (IP-keyed exits; unused by selection) */
  exitIp?: string
  /** Optional expected IP from catalog; probe may compare (optional) */
  expectedExitIp?: string
  /** Last probed egress IP (optional; probe is not primary) */
  exitIpProbedAt?: number
  exitIpMismatch?: boolean
  useCount?: number
  banCount?: number
  disabled?: boolean
  /** Epoch ms — exit ineligible while in the future */
  cooldownUntil?: number
  /** socks/http OR generated ss:// URL */
  outboundProxyUrl?: string
}

export interface ExitsFile {
  /** @deprecated Prefer native ss:// fields; kept for legacy broker ensure */
  brokerBase?: string
  exits: ExitEntry[]
  updatedAt?: number
}

/** Build `base#index` if password does not already contain `#`. */
export function normalizePassIndex(basePass: string, index: number): string {
  const base = String(basePass)
  if (base.includes('#')) return base
  return `${base}#${index}`
}

/** Build `base#exitIp` if password does not already contain `#`. */
export function normalizePassExitIp(basePass: string, exitIp: string): string {
  const base = String(basePass)
  if (base.includes('#')) return base
  return `${base}#${exitIp}`
}

/**
 * Build `base#tag` for sticky hash(suffix)%N selection on iqun.
 * Does not resolve the index here — iqun + shared normalize-before-KDF do.
 */
export function normalizePassTag(basePass: string, tag: string): string {
  const base = String(basePass)
  if (base.includes('#')) return base
  const cleaned = String(tag).trim()
  if (!cleaned) throw new Error('tag is required')
  return `${base}#${cleaned}`
}

function hasSsFields(e: ExitEntry): boolean {
  return !!(e.server && e.port && e.method && e.password)
}

function toSsUrl(e: ExitEntry): string {
  return buildSsUrlFromFields({
    server: e.server!,
    port: Number(e.port),
    method: e.method!,
    password: e.password!,
  })
}

function normalizeEntry(e: ExitEntry): ExitEntry {
  const id = String(e.id)
  let password = e.password != null ? String(e.password) : undefined
  const index = e.index != null ? Number(e.index) : undefined
  const exitIp = e.exitIp?.trim() || undefined
  const expectedExitIp = e.expectedExitIp?.trim() || exitIp

  // Auto-append selector when importer supplies bare SS_PASS + index or exitIp
  if (password && !password.includes('#')) {
    if (exitIp) password = normalizePassExitIp(password, exitIp)
    else if (index != null && Number.isFinite(index)) password = normalizePassIndex(password, index)
  }

  const entry: ExitEntry = {
    id,
    server: e.server?.trim() || undefined,
    port: e.port != null ? Number(e.port) : undefined,
    method: e.method?.trim() || undefined,
    password,
    index,
    exitIp,
    expectedExitIp,
    exitIpProbedAt: e.exitIpProbedAt != null ? Number(e.exitIpProbedAt) : undefined,
    exitIpMismatch: e.exitIpMismatch ? true : undefined,
    useCount: e.useCount != null ? Number(e.useCount) : 0,
    banCount: e.banCount != null ? Number(e.banCount) : 0,
    disabled: e.disabled ? true : undefined,
    cooldownUntil: e.cooldownUntil != null ? Number(e.cooldownUntil) : undefined,
    outboundProxyUrl: e.outboundProxyUrl?.trim() || undefined,
  }
  if (hasSsFields(entry) && !entry.outboundProxyUrl) {
    entry.outboundProxyUrl = toSsUrl(entry)
  }
  return entry
}

export const DEFAULT_BAN_COOLDOWN_MS = 10 * 60 * 1000

export class ExitsStore {
  private file: JsonStore<ExitsFile>
  private data: ExitsFile = { exits: [] }

  constructor(dataDir: string) {
    this.file = new JsonStore(path.join(dataDir, 'exits.json'), { exits: [] })
  }

  async init(): Promise<void> {
    this.data = await this.file.read()
    if (!Array.isArray(this.data.exits)) this.data.exits = []
  }

  get(): ExitsFile {
    return {
      brokerBase: this.data.brokerBase,
      exits: this.data.exits.map((e) => ({ ...e })),
      updatedAt: this.data.updatedAt,
    }
  }

  listIds(): string[] {
    return this.data.exits.map((e) => e.id)
  }

  listByIds(ids: readonly string[]): ExitEntry[] {
    const want = new Set(ids)
    return this.data.exits.filter((e) => want.has(e.id)).map((e) => ({ ...e }))
  }

  getEntry(id: string): ExitEntry | undefined {
    const e = this.data.exits.find((x) => x.id === id)
    return e ? { ...e } : undefined
  }

  private findMutable(id: string): ExitEntry {
    const e = this.data.exits.find((x) => x.id === id)
    if (!e) throw new Error(`Unknown exit id: ${id}`)
    return e
  }

  async updateExitStats(
    id: string,
    patch: Partial<
      Pick<
        ExitEntry,
        | 'useCount'
        | 'banCount'
        | 'disabled'
        | 'cooldownUntil'
        | 'exitIp'
        | 'expectedExitIp'
        | 'exitIpProbedAt'
        | 'exitIpMismatch'
        | 'outboundProxyUrl'
      >
    >,
  ): Promise<ExitEntry> {
    const e = this.findMutable(id)
    if (patch.useCount != null) e.useCount = Number(patch.useCount)
    if (patch.banCount != null) e.banCount = Number(patch.banCount)
    if (patch.disabled != null) e.disabled = patch.disabled ? true : undefined
    if (patch.cooldownUntil !== undefined) {
      e.cooldownUntil =
        patch.cooldownUntil == null ? undefined : Number(patch.cooldownUntil)
    }
    if (patch.exitIp !== undefined) e.exitIp = patch.exitIp?.trim() || undefined
    if (patch.expectedExitIp !== undefined) {
      e.expectedExitIp = patch.expectedExitIp?.trim() || undefined
    }
    if (patch.exitIpProbedAt !== undefined) {
      e.exitIpProbedAt =
        patch.exitIpProbedAt == null ? undefined : Number(patch.exitIpProbedAt)
    }
    if (patch.exitIpMismatch !== undefined) {
      e.exitIpMismatch = patch.exitIpMismatch ? true : undefined
    }
    if (patch.outboundProxyUrl !== undefined) {
      e.outboundProxyUrl = patch.outboundProxyUrl?.trim() || undefined
    }
    this.data.updatedAt = Date.now()
    await this.file.write(this.data)
    return { ...e }
  }

  async bumpUse(id: string): Promise<ExitEntry> {
    const e = this.findMutable(id)
    e.useCount = (e.useCount ?? 0) + 1
    this.data.updatedAt = Date.now()
    await this.file.write(this.data)
    return { ...e }
  }

  async bumpBan(
    id: string,
    opts?: { cooldownMs?: number; now?: number },
  ): Promise<ExitEntry> {
    const e = this.findMutable(id)
    e.banCount = (e.banCount ?? 0) + 1
    const cooldownMs = opts?.cooldownMs ?? DEFAULT_BAN_COOLDOWN_MS
    if (cooldownMs > 0) {
      const now = opts?.now ?? Date.now()
      e.cooldownUntil = now + cooldownMs
    }
    this.data.updatedAt = Date.now()
    await this.file.write(this.data)
    return { ...e }
  }

  async setDisabled(id: string, disabled: boolean): Promise<ExitEntry> {
    return this.updateExitStats(id, { disabled })
  }

  async importExits(input: {
    brokerBase?: string
    exits?: ExitEntry[]
    exitIds?: string[]
  }): Promise<ExitsFile> {
    let exits: ExitEntry[] = []
    if (Array.isArray(input.exits) && input.exits.length > 0) {
      exits = input.exits.map((e) => normalizeEntry(e))
    } else if (Array.isArray(input.exitIds) && input.exitIds.length > 0) {
      exits = input.exitIds.map((id) => ({ id: String(id), useCount: 0, banCount: 0 }))
    } else if (input.brokerBase) {
      const base = input.brokerBase.replace(/\/$/, '')
      const res = await fetch(`${base}/exits`)
      if (!res.ok) {
        throw new Error(`broker GET /exits failed: HTTP ${res.status}`)
      }
      const body = (await res.json()) as {
        exits?: Array<{ id: string; outboundProxyUrl?: string | null }>
      }
      const list = body.exits || []
      exits = list.map((e) =>
        normalizeEntry({
          id: e.id,
          outboundProxyUrl: e.outboundProxyUrl || undefined,
        }),
      )
    } else {
      throw new Error('Provide exits[] (with SS fields or outboundProxyUrl), exitIds[], or brokerBase')
    }

    this.data = {
      brokerBase:
        input.brokerBase !== undefined
          ? input.brokerBase?.replace(/\/$/, '') || undefined
          : this.data.brokerBase,
      exits,
      updatedAt: Date.now(),
    }
    await this.file.write(this.data)
    return this.get()
  }

  /**
   * Ensure exit has a usable outboundProxyUrl.
   * Preferred: build ss:// from SS fields (no broker).
   * Fallback: existing outboundProxyUrl, then legacy broker /ensure.
   */
  async ensureProxyUrl(exitId: string): Promise<string> {
    const entry = this.findMutable(exitId)

    if (hasSsFields(entry)) {
      const url = toSsUrl(entry)
      if (entry.outboundProxyUrl !== url) {
        entry.outboundProxyUrl = url
        await this.file.write(this.data)
      }
      return url
    }

    if (entry.outboundProxyUrl) return entry.outboundProxyUrl

    if (this.data.brokerBase) {
      const res = await fetch(
        `${this.data.brokerBase}/exits/${encodeURIComponent(exitId)}/ensure`,
        { method: 'POST' },
      )
      const body = (await res.json()) as { outboundProxyUrl?: string; error?: string }
      if (!res.ok || !body.outboundProxyUrl) {
        throw new Error(body.error || `broker ensure failed: HTTP ${res.status}`)
      }
      entry.outboundProxyUrl = body.outboundProxyUrl
      await this.file.write(this.data)
      return body.outboundProxyUrl
    }

    throw new Error(
      `Exit ${exitId} has no SS fields (server/port/method/password), no outboundProxyUrl, and brokerBase is not configured`,
    )
  }
}
