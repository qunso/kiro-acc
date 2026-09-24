import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getKiroIdeVersionMeta } from '../kiro/ideVersion.js'

const here = dirname(fileURLToPath(import.meta.url))

export function readPackageVersion(): string {
  const candidates = [
    join(here, '../../package.json'),
    join(process.cwd(), 'package.json'),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string; name?: string }
      if (pkg.version) return pkg.version
    } catch {
      /* try next */
    }
  }
  return '0.0.0'
}

export function tryGitCommit(): string | null {
  if (process.env.GIT_COMMIT?.trim()) return process.env.GIT_COMMIT.trim().slice(0, 40)
  if (process.env.SOURCE_COMMIT?.trim()) return process.env.SOURCE_COMMIT.trim().slice(0, 40)
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
    return sha || null
  } catch {
    return null
  }
}

export function aboutInfo() {
  const ide = getKiroIdeVersionMeta()
  return {
    name: 'kiro-acc',
    version: readPackageVersion(),
    gitCommit: tryGitCommit(),
    node: process.version,
    platform: process.platform,
    uptimeSec: Math.floor(process.uptime()),
    /** Version string used in upstream `KiroIDE-{ver}-…` User-Agent */
    kiroIdeVersion: ide.version,
    kiroIdeVersionSource: ide.source,
    kiroIdeVersionFetchedAt: ide.fetchedAt,
    kiroIdeVersionOverride: ide.override,
  }
}
