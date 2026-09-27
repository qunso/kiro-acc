import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig, type AppConfig } from '../src/config.js'
import {
  buildKiroModelsEndpoints,
  parseKiroAvailableModels,
  resolveKiroModelsRegion,
} from '../src/kiro/availableModels.js'

vi.mock('../src/kiro/availableModels.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kiro/availableModels.js')>()
  return {
    ...actual,
    fetchKiroAvailableModels: vi.fn(),
  }
})

import { fetchKiroAvailableModels } from '../src/kiro/availableModels.js'
import { createAdminRoutes } from '../src/admin/routes.js'

describe('parseKiroAvailableModels', () => {
  it('reads modelId rows and dedupes', () => {
    const rows = parseKiroAvailableModels({
      models: [
        { modelId: 'claude-opus-5', modelName: 'Claude Opus 5' },
        { modelId: 'claude-opus-5.5', modelName: 'Claude Opus 5.5' },
        { modelId: 'claude-opus-5' },
        { id: 'auto' },
        'deepseek-3.2',
        { modelId: '  ' },
        null,
      ],
    })
    expect(rows.map((r) => r.id)).toEqual([
      'claude-opus-5',
      'claude-opus-5.5',
      'auto',
      'deepseek-3.2',
    ])
    expect(rows[0]?.name).toBe('Claude Opus 5')
  })

  it('falls back to availableModels key', () => {
    const rows = parseKiroAvailableModels({
      availableModels: [{ modelId: 'claude-sonnet-5' }],
    })
    expect(rows.map((r) => r.id)).toEqual(['claude-sonnet-5'])
  })
})

describe('resolveKiroModelsRegion / buildKiroModelsEndpoints', () => {
  it('prefers account.region then profileArn region', () => {
    expect(resolveKiroModelsRegion({ region: 'eu-central-1' })).toBe('eu-central-1')
    expect(
      resolveKiroModelsRegion({
        profileArn: 'arn:aws:codewhisperer:eu-central-1:123:profile/X',
      }),
    ).toBe('eu-central-1')
    expect(resolveKiroModelsRegion({})).toBe('us-east-1')
  })

  it('builds region then us-east-1 then codewhisperer fallbacks', () => {
    expect(buildKiroModelsEndpoints('eu-central-1')).toEqual([
      'https://q.eu-central-1.amazonaws.com/ListAvailableModels',
      'https://q.us-east-1.amazonaws.com/ListAvailableModels',
      'https://codewhisperer.us-east-1.amazonaws.com/ListAvailableModels',
    ])
    expect(buildKiroModelsEndpoints('us-east-1')).toEqual([
      'https://q.us-east-1.amazonaws.com/ListAvailableModels',
      'https://codewhisperer.us-east-1.amazonaws.com/ListAvailableModels',
    ])
  })
})

describe('POST /admin/accounts/:id/refresh-models (kiro)', () => {
  let dir: string | undefined

  afterEach(async () => {
    vi.mocked(fetchKiroAvailableModels).mockReset()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('caches ListAvailableModels ids onto the kiro account', async () => {
    vi.mocked(fetchKiroAvailableModels).mockResolvedValue({
      models: ['claude-opus-5.5', 'claude-opus-5', 'auto'],
      details: [
        { id: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
        { id: 'claude-opus-5' },
        { id: 'auto' },
      ],
      url: 'https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR',
      source: 'api',
    })

    dir = await mkdtemp(path.join(os.tmpdir(), 'kiro-models-'))
    const config: AppConfig = {
      ...loadConfig(),
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const store = new AccountStore(dir, config)
    await store.init()
    const created = await store.create({
      label: 'kiro-a',
      email: 'a@example.com',
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3600_000,
      provider: 'Google',
      authMethod: 'social',
      region: 'us-east-1',
    })
    const app = createAdminRoutes(store, config)

    const res = await app.request(`/accounts/${created.id}/refresh-models`, {
      method: 'POST',
      headers: { 'x-admin-token': 'test-admin' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      source: string
      models: string[]
      account: { upstreamModels?: string[]; upstreamModelsFetchedAt?: number }
    }
    expect(body.ok).toBe(true)
    expect(body.source).toBe('kiro')
    expect(body.models).toEqual(['claude-opus-5.5', 'claude-opus-5', 'auto'])
    expect(body.account.upstreamModels).toEqual(['claude-opus-5.5', 'claude-opus-5', 'auto'])
    expect(body.account.upstreamModelsFetchedAt).toBeTypeOf('number')
    expect(fetchKiroAvailableModels).toHaveBeenCalledOnce()
  })
})
