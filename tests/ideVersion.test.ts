import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KIRO_VERSION,
  configureKiroIdeVersion,
  getKiroIdeVersion,
  getKiroIdeVersionMeta,
  loadKiroIdeVersionCache,
  parseVersionFromChocolateyXml,
  parseVersionFromDownloadsHtml,
  parseVersionFromLatestYml,
  refreshKiroIdeVersion,
  resetKiroIdeVersionForTests,
  setIdeVersionFetch,
} from '../src/kiro/ideVersion.js'
import { buildKiroUserAgent } from '../src/accounts/machineId.js'

const dirs: string[] = []

afterEach(async () => {
  resetKiroIdeVersionForTests()
  delete process.env.KIRO_IDE_VERSION
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

beforeEach(() => {
  resetKiroIdeVersionForTests()
  delete process.env.KIRO_IDE_VERSION
})

function mockFetch(handler: (url: string) => { status?: number; body: string } | null) {
  setIdeVersionFetch(async (url) => {
    const hit = handler(url)
    if (!hit) {
      return new Response('not found', { status: 404 })
    }
    return new Response(hit.body, { status: hit.status ?? 200 })
  })
}

describe('ideVersion parsers', () => {
  it('parses Chocolatey OData Version', () => {
    const xml = `<?xml version="1.0"?><feed><entry><m:properties><d:Version>1.1.14</d:Version></m:properties></entry></feed>`
    expect(parseVersionFromChocolateyXml(xml)).toBe('1.1.14')
    expect(parseVersionFromChocolateyXml('<d:Version>bad</d:Version>')).toBeNull()
  })

  it('parses downloads HTML Latest label and href fallback', () => {
    expect(
      parseVersionFromDownloadsHtml('<div>IDE 1.1.14 Latest</div><a href="other">'),
    ).toBe('1.1.14')
    expect(
      parseVersionFromDownloadsHtml(
        'https://prod.download.desktop.kiro.dev/releases/stable/linux-x64/signed/1.2.3/kiro-ide-1.2.3-stable-linux-x64.deb',
      ),
    ).toBe('1.2.3')
  })

  it('parses electron-updater latest.yml', () => {
    expect(parseVersionFromLatestYml('version: 1.1.14\nfiles:\n  - url: x\n')).toBe('1.1.14')
    expect(parseVersionFromLatestYml('name: foo\n')).toBeNull()
  })
})

describe('ideVersion cache / refresh', () => {
  it('uses DEFAULT when offline / all fetches fail', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idever-'))
    dirs.push(dir)
    configureKiroIdeVersion({ dataDir: dir })
    mockFetch(() => null)
    const v = await refreshKiroIdeVersion({ force: true })
    expect(v).toBe(DEFAULT_KIRO_VERSION)
    expect(getKiroIdeVersion()).toBe(DEFAULT_KIRO_VERSION)
    expect(getKiroIdeVersionMeta().source).toBe('default')
  })

  it('fetch success from chocolatey updates memory + file cache', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idever-'))
    dirs.push(dir)
    configureKiroIdeVersion({ dataDir: dir })
    mockFetch((url) => {
      if (url.includes('chocolatey.org')) {
        return {
          body: `<feed><entry><d:Version>9.9.9</d:Version></entry></feed>`,
        }
      }
      return null
    })
    const v = await refreshKiroIdeVersion({ force: true })
    expect(v).toBe('9.9.9')
    expect(getKiroIdeVersion()).toBe('9.9.9')
    expect(getKiroIdeVersionMeta().source).toBe('chocolatey')

    const raw = JSON.parse(
      await fs.readFile(path.join(dir, 'kiro-ide-version.json'), 'utf8'),
    )
    expect(raw.version).toBe('9.9.9')
    expect(raw.source).toBe('chocolatey')
  })

  it('falls back to downloads HTML when chocolatey fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idever-'))
    dirs.push(dir)
    configureKiroIdeVersion({ dataDir: dir })
    mockFetch((url) => {
      if (url.includes('chocolatey.org')) return { status: 500, body: 'err' }
      if (url.includes('kiro.dev/downloads')) {
        return { body: '<html>IDE 2.0.1 Latest</html>' }
      }
      return null
    })
    expect(await refreshKiroIdeVersion({ force: true })).toBe('2.0.1')
    expect(getKiroIdeVersionMeta().source).toBe('downloads')
  })

  it('keeps previous cache when refresh fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idever-'))
    dirs.push(dir)
    configureKiroIdeVersion({ dataDir: dir })
    mockFetch((url) => {
      if (url.includes('chocolatey.org')) {
        return { body: `<d:Version>3.3.3</d:Version>` }
      }
      return null
    })
    expect(await refreshKiroIdeVersion({ force: true })).toBe('3.3.3')

    mockFetch(() => null)
    expect(await refreshKiroIdeVersion({ force: true })).toBe('3.3.3')
    expect(getKiroIdeVersion()).toBe('3.3.3')
  })

  it('loads file cache without network', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idever-'))
    dirs.push(dir)
    await fs.writeFile(
      path.join(dir, 'kiro-ide-version.json'),
      JSON.stringify({ version: '4.4.4', fetchedAt: Date.now(), source: 'downloads' }),
    )
    configureKiroIdeVersion({ dataDir: dir })
    mockFetch(() => {
      throw new Error('network should not be called')
    })
    expect(await loadKiroIdeVersionCache()).toBe('4.4.4')
    expect(getKiroIdeVersion()).toBe('4.4.4')
  })

  it('env KIRO_IDE_VERSION override wins and skips network', async () => {
    process.env.KIRO_IDE_VERSION = '8.8.8'
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idever-'))
    dirs.push(dir)
    configureKiroIdeVersion({ dataDir: dir })
    const spy = vi.fn(async () => new Response('nope', { status: 500 }))
    setIdeVersionFetch(spy)
    expect(getKiroIdeVersion()).toBe('8.8.8')
    expect(await refreshKiroIdeVersion({ force: true })).toBe('8.8.8')
    expect(spy).not.toHaveBeenCalled()
    expect(getKiroIdeVersionMeta()).toMatchObject({
      version: '8.8.8',
      source: 'env',
      override: true,
    })
  })

  it('UA builder uses getKiroIdeVersion()', async () => {
    process.env.KIRO_IDE_VERSION = '7.7.7'
    const ua = buildKiroUserAgent({
      kiroVersion: getKiroIdeVersion(),
      awsSdkVersion: '1.0.34',
      machineId: 'mid-1',
      platform: 'linux',
      osRelease: 'v1',
      nodeVersion: '22.0.0',
    })
    expect(ua).toContain('KiroIDE-7.7.7-mid-1')
  })
})
