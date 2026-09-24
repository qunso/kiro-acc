/**
 * Resolve the Kiro IDE version string used in upstream User-Agent
 * (`KiroIDE-{version}-{machineId}`).
 *
 * Prefer a live fetch of the official latest; fall back to an in-memory /
 * on-disk cache, then DEFAULT_KIRO_VERSION. Env `KIRO_IDE_VERSION` pins.
 *
 * Sources (tried in order, ~5s timeout each attempt budget shared):
 *  1. Chocolatey OData (structured `<d:Version>`)
 *  2. https://kiro.dev/downloads/ HTML (`kiro-ide-x.y.z-stable` / "IDE x.y.z Latest")
 *  3. electron-updater latest.yml on the official CDN (often 403 — ignore)
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** Current official latest as of 2026-09 (kiro.dev/downloads). */
export const DEFAULT_KIRO_VERSION = '1.1.14'

export const CACHE_FILENAME = 'kiro-ide-version.json'
export const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000 // 12h
export const FETCH_TIMEOUT_MS = 5_000

const VERSION_RE = /^\d+\.\d+\.\d+$/

const CHOCOLATEY_URL =
  "https://community.chocolatey.org/api/v2/Packages()?$filter=Id%20eq%20'kiro'&$orderby=Version%20desc&$top=1"

const DOWNLOADS_URL = 'https://kiro.dev/downloads/'

/** Known CDN latest.yml paths — may 403; try and ignore failures. */
const LATEST_YML_URLS = [
  'https://prod.download.desktop.kiro.dev/stable/latest-linux.yml',
  'https://prod.download.desktop.kiro.dev/stable/latest.yml',
  'https://prod.download.desktop.kiro.dev/stable/latest-mac.yml',
]

export type IdeVersionSource =
  | 'env'
  | 'memory'
  | 'file'
  | 'chocolatey'
  | 'downloads'
  | 'latest.yml'
  | 'default'

export interface IdeVersionCache {
  version: string
  fetchedAt: number
  source?: IdeVersionSource
}

export interface IdeVersionMeta {
  version: string
  source: IdeVersionSource
  fetchedAt: number | null
  override: boolean
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

let dataDir: string | null = null
let memory: IdeVersionCache | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loggedFailure = false
let inFlight: Promise<string> | null = null
let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis)

/** Test / DI hook. */
export function setIdeVersionFetch(fn: FetchFn | null): void {
  fetchImpl = fn || globalThis.fetch.bind(globalThis)
}

export function configureKiroIdeVersion(opts: { dataDir?: string }): void {
  if (opts.dataDir) dataDir = opts.dataDir
}

export function resetKiroIdeVersionForTests(): void {
  memory = null
  dataDir = null
  loggedFailure = false
  inFlight = null
  fetchImpl = globalThis.fetch.bind(globalThis)
  stopKiroIdeVersionRefreshLoop()
}

function envOverride(): string | undefined {
  const v = process.env.KIRO_IDE_VERSION?.trim()
  if (v && VERSION_RE.test(v)) return v
  return undefined
}

function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().replace(/^v/i, '')
  return VERSION_RE.test(v) ? v : null
}

/** Parse Chocolatey OData Atom feed for `<d:Version>x.y.z</d:Version>`. */
export function parseVersionFromChocolateyXml(xml: string): string | null {
  const m = xml.match(/<d:Version>([^<]+)<\/d:Version>/i)
  return normalizeVersion(m?.[1])
}

/**
 * Parse kiro.dev/downloads HTML.
 * Prefer explicit "IDE x.y.z Latest", then first `kiro-ide-x.y.z-stable` href.
 */
export function parseVersionFromDownloadsHtml(html: string): string | null {
  const latest = html.match(/IDE\s+(\d+\.\d+\.\d+)\s+Latest/i)
  if (latest) return normalizeVersion(latest[1])
  // Markdown / split markup fallback from WebFetch-style text
  const latestLoose = html.match(/IDE\s+(\d+\.\d+\.\d+)[\s\S]{0,40}?Latest/i)
  if (latestLoose) return normalizeVersion(latestLoose[1])
  const fromHref = html.match(/kiro-ide-(\d+\.\d+\.\d+)-stable/i)
  return normalizeVersion(fromHref?.[1])
}

/** electron-updater latest.yml: `version: x.y.z` */
export function parseVersionFromLatestYml(text: string): string | null {
  const m = text.match(/^\s*version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m)
  return normalizeVersion(m?.[1])
}

function cachePath(): string | null {
  if (!dataDir) return null
  return path.join(dataDir, CACHE_FILENAME)
}

async function readFileCache(): Promise<IdeVersionCache | null> {
  const p = cachePath()
  if (!p) return null
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as IdeVersionCache
    const version = normalizeVersion(parsed.version)
    if (!version || !Number.isFinite(parsed.fetchedAt)) return null
    return { version, fetchedAt: parsed.fetchedAt, source: parsed.source || 'file' }
  } catch {
    return null
  }
}

async function writeFileCache(entry: IdeVersionCache): Promise<void> {
  const p = cachePath()
  if (!p) return
  try {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8')
    await fs.rename(tmp, p)
  } catch (err) {
    console.warn(
      `[kiro-ide-version] failed to write cache: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Sync accessor for UA builders.
 * Priority: env pin → memory cache → DEFAULT.
 * Call `refreshKiroIdeVersion` / `loadKiroIdeVersionCache` on startup so
 * memory is warm; until then returns default (or env).
 */
export function getKiroIdeVersion(): string {
  const pinned = envOverride()
  if (pinned) return pinned
  if (memory?.version) return memory.version
  return DEFAULT_KIRO_VERSION
}

export function getKiroIdeVersionMeta(): IdeVersionMeta {
  const pinned = envOverride()
  if (pinned) {
    return {
      version: pinned,
      source: 'env',
      fetchedAt: memory?.fetchedAt ?? null,
      override: true,
    }
  }
  if (memory?.version) {
    return {
      version: memory.version,
      source: memory.source || 'memory',
      fetchedAt: memory.fetchedAt,
      override: false,
    }
  }
  return {
    version: DEFAULT_KIRO_VERSION,
    source: 'default',
    fetchedAt: null,
    override: false,
  }
}

/** Load on-disk cache into memory (no network). */
export async function loadKiroIdeVersionCache(): Promise<string> {
  const pinned = envOverride()
  if (pinned) {
    memory = { version: pinned, fetchedAt: Date.now(), source: 'env' }
    return pinned
  }
  const file = await readFileCache()
  if (file) {
    memory = { ...file, source: file.source || 'file' }
    return file.version
  }
  if (!memory) {
    memory = { version: DEFAULT_KIRO_VERSION, fetchedAt: 0, source: 'default' }
  }
  return memory.version
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        Accept: '*/*',
        'User-Agent': 'kiro-acc-ide-version-check/1.0',
      },
      redirect: 'follow',
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function tryFetchLatest(budgetMs: number): Promise<{
  version: string
  source: IdeVersionSource
} | null> {
  const started = Date.now()
  const remaining = () => Math.max(500, budgetMs - (Date.now() - started))

  const choco = await fetchText(CHOCOLATEY_URL, remaining())
  if (choco) {
    const v = parseVersionFromChocolateyXml(choco)
    if (v) return { version: v, source: 'chocolatey' }
  }

  const downloads = await fetchText(DOWNLOADS_URL, remaining())
  if (downloads) {
    const v = parseVersionFromDownloadsHtml(downloads)
    if (v) return { version: v, source: 'downloads' }
  }

  for (const url of LATEST_YML_URLS) {
    if (Date.now() - started >= budgetMs) break
    const yml = await fetchText(url, Math.min(2_000, remaining()))
    if (!yml) continue
    const v = parseVersionFromLatestYml(yml)
    if (v) return { version: v, source: 'latest.yml' }
  }

  return null
}

function logFailureOnce(reason: string): void {
  if (loggedFailure) return
  loggedFailure = true
  console.warn(
    `[kiro-ide-version] refresh failed (${reason}); using ${getKiroIdeVersion()}. Will retry later.`,
  )
}

/**
 * Fetch latest IDE version. On failure keeps previous cache/default.
 * Dedupes concurrent calls. Honors `KIRO_IDE_VERSION` pin (no network).
 */
export async function refreshKiroIdeVersion(opts?: {
  force?: boolean
  timeoutMs?: number
}): Promise<string> {
  const pinned = envOverride()
  if (pinned) {
    memory = { version: pinned, fetchedAt: Date.now(), source: 'env' }
    return pinned
  }

  if (!opts?.force && memory?.fetchedAt) {
    const age = Date.now() - memory.fetchedAt
    if (age >= 0 && age < REFRESH_INTERVAL_MS && memory.source !== 'default') {
      return memory.version
    }
  }

  if (inFlight) return inFlight

  inFlight = (async () => {
    // Ensure memory has at least file/default before network
    if (!memory) await loadKiroIdeVersionCache()

    const previous = memory
    try {
      const found = await tryFetchLatest(opts?.timeoutMs ?? FETCH_TIMEOUT_MS)
      if (found) {
        const entry: IdeVersionCache = {
          version: found.version,
          fetchedAt: Date.now(),
          source: found.source,
        }
        memory = entry
        loggedFailure = false
        await writeFileCache(entry)
        return entry.version
      }
      logFailureOnce('no source returned a version')
      return previous?.version || DEFAULT_KIRO_VERSION
    } catch (err) {
      logFailureOnce(err instanceof Error ? err.message : String(err))
      return previous?.version || DEFAULT_KIRO_VERSION
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

export function startKiroIdeVersionRefreshLoop(intervalMs = REFRESH_INTERVAL_MS): void {
  stopKiroIdeVersionRefreshLoop()
  refreshTimer = setInterval(() => {
    void refreshKiroIdeVersion({ force: true }).catch(() => {
      /* logged inside */
    })
  }, intervalMs)
  // Don't keep the process alive solely for the refresh timer
  if (typeof refreshTimer === 'object' && refreshTimer && 'unref' in refreshTimer) {
    refreshTimer.unref()
  }
}

export function stopKiroIdeVersionRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
