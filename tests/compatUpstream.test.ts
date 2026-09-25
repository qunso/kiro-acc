import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountSupportsApiStyle,
  accountSupportsModel,
  applyModelPrefix,
  effectiveModelAllowlist,
  isCompatUpstream,
  joinCompatUrl,
  resolveUpstreamType,
  validateAccountCredentials,
} from '../src/accounts/upstream.js'
import { normalizeAccountImport } from '../src/accounts/importNormalize.js'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { PoolsStore } from '../src/pools/store.js'
import { createServer } from '../src/server.js'
import type { AppConfig } from '../src/config.js'


describe('accountSupportsModel / effectiveModelAllowlist', () => {
  it('unrestricted when both allowlist and cache empty', () => {
    expect(effectiveModelAllowlist({})).toBeNull()
    expect(accountSupportsModel({}, 'gpt-4')).toBe(true)
    expect(accountSupportsModel({ supportedModels: [], upstreamModels: [] }, 'any')).toBe(true)
  })

  it('manual supportedModels wins over cache', () => {
    const acc = {
      supportedModels: ['gpt-4o'],
      upstreamModels: ['claude-3', 'gpt-4o'],
    }
    expect(effectiveModelAllowlist(acc)).toEqual(['gpt-4o'])
    expect(accountSupportsModel(acc, 'gpt-4o')).toBe(true)
    expect(accountSupportsModel(acc, 'claude-3')).toBe(false)
  })

  it('falls back to upstreamModels cache when allowlist empty', () => {
    const acc = { upstreamModels: ['openai/gpt-4', 'openai/gpt-4o'] }
    expect(accountSupportsModel(acc, 'openai/gpt-4')).toBe(true)
    expect(accountSupportsModel(acc, 'gpt-3.5')).toBe(false)
  })

  it('matches with modelPrefix apply/strip', () => {
    const acc = {
      modelPrefix: 'openai/',
      supportedModels: ['gpt-4o'],
    }
    expect(accountSupportsModel(acc, 'gpt-4o')).toBe(true)
    expect(accountSupportsModel(acc, 'openai/gpt-4o')).toBe(true)
    expect(
      accountSupportsModel({ modelPrefix: 'openai/', supportedModels: ['openai/gpt-4o'] }, 'gpt-4o'),
    ).toBe(true)
    expect(accountSupportsModel(acc, 'gpt-4')).toBe(false)
  })

  it('rejects missing model when filter active', () => {
    expect(accountSupportsModel({ supportedModels: ['a'] }, '')).toBe(false)
    expect(accountSupportsModel({ supportedModels: ['a'] }, undefined)).toBe(false)
  })
})

describe('joinCompatUrl', () => {
  it('joins origin + /v1 path', () => {
    expect(joinCompatUrl('https://api.openai.com', '/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('strips trailing slash on base', () => {
    expect(joinCompatUrl('https://api.openai.com/', '/v1/messages')).toBe(
      'https://api.openai.com/v1/messages',
    )
  })

  it('avoids doubling /v1 when base already ends with /v1', () => {
    expect(joinCompatUrl('https://api.openai.com/v1', '/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(joinCompatUrl('https://api.openai.com/v1/', '/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('supports path-only append when base includes /v1', () => {
    expect(joinCompatUrl('https://relay.example/openai/v1', 'chat/completions')).toBe(
      'https://relay.example/openai/v1/chat/completions',
    )
  })
})

describe('upstream type helpers', () => {
  it('defaults to kiro', () => {
    expect(resolveUpstreamType({})).toBe('kiro')
    expect(isCompatUpstream({})).toBe(false)
  })

  it('resolves aliases', () => {
    expect(resolveUpstreamType({ upstreamType: 'openai' as never })).toBe('openai_compat')
    expect(resolveUpstreamType({ upstreamType: 'anthropic' as never })).toBe('anthropic_compat')
    expect(resolveUpstreamType({ upstreamType: 'claude' as never })).toBe('anthropic_compat')
  })

  it('gates api style by upstream type', () => {
    expect(accountSupportsApiStyle({ upstreamType: 'kiro' }, 'openai')).toBe(true)
    expect(accountSupportsApiStyle({ upstreamType: 'kiro' }, 'anthropic')).toBe(true)
    expect(accountSupportsApiStyle({ upstreamType: 'openai_compat' }, 'openai')).toBe(true)
    expect(accountSupportsApiStyle({ upstreamType: 'openai_compat' }, 'anthropic')).toBe(false)
    expect(accountSupportsApiStyle({ upstreamType: 'anthropic_compat' }, 'anthropic')).toBe(true)
    expect(accountSupportsApiStyle({ upstreamType: 'anthropic_compat' }, 'openai')).toBe(false)
  })

  it('applies model prefix once', () => {
    expect(applyModelPrefix('gpt-4o', 'openai/')).toBe('openai/gpt-4o')
    expect(applyModelPrefix('openai/gpt-4o', 'openai/')).toBe('openai/gpt-4o')
    expect(applyModelPrefix('gpt-4o', undefined)).toBe('gpt-4o')
  })

  it('validates compat credentials', () => {
    expect(
      validateAccountCredentials({
        upstreamType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
        upstreamApiKey: 'sk-test',
      }).ok,
    ).toBe(true)
    expect(
      validateAccountCredentials({
        upstreamType: 'openai_compat',
        baseUrl: 'https://api.openai.com/v1',
      }).ok,
    ).toBe(false)
    expect(validateAccountCredentials({ accessToken: 'tok' }).ok).toBe(true)
    expect(validateAccountCredentials({}).ok).toBe(false)
  })
})

describe('import openai/anthropic compat accounts', () => {
  it('imports openai_compat with baseUrl + apiKey', () => {
    const result = normalizeAccountImport({
      accounts: [
        {
          label: 'OpenRouter',
          upstreamType: 'openai_compat',
          baseUrl: 'https://openrouter.ai/api/v1',
          upstreamApiKey: 'sk-or-v1-xxx',
          modelPrefix: 'openai/',
          enabled: true,
        },
      ],
    })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      upstreamType: 'openai_compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      upstreamApiKey: 'sk-or-v1-xxx',
      modelPrefix: 'openai/',
    })
  })

  it('imports anthropic_compat and infers type from baseUrl+key', () => {
    const explicit = normalizeAccountImport({
      upstreamType: 'anthropic_compat',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-xxx',
      label: 'Official Anthropic',
    })
    expect(explicit.accounts[0]).toMatchObject({
      upstreamType: 'anthropic_compat',
      baseUrl: 'https://api.anthropic.com',
      upstreamApiKey: 'sk-ant-xxx',
    })

    const inferred = normalizeAccountImport({
      baseUrl: 'https://relay.example/v1',
      upstreamApiKey: 'sk-xxx',
    })
    expect(inferred.accounts[0]?.upstreamType).toBe('openai_compat')
  })
})

describe('compat relay routing through pool', () => {
  let dir: string | undefined
  let upstream: ReturnType<typeof createHttpServer> | undefined
  let upstreamUrl = ''

  afterEach(async () => {
    if (upstream) {
      await new Promise<void>((resolve, reject) =>
        upstream!.close((err) => (err ? reject(err) : resolve())),
      )
      upstream = undefined
    }
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  async function startUpstream() {
    upstream = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const url = req.url || ''
        if (url.includes('chat/completions')) {
          expect(req.headers.authorization).toBe('Bearer sk-test-openai')
          const parsed = JSON.parse(body || '{}') as { model?: string }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              model: parsed.model || 'gpt-4o-mini',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'hello from openai compat' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            }),
          )
          return
        }
        if (url.includes('/messages')) {
          expect(req.headers['x-api-key']).toBe('sk-test-anthropic')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-4.5',
              content: [{ type: 'text', text: 'hello from anthropic compat' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 9, output_tokens: 5 },
            }),
          )
          return
        }
        res.writeHead(404)
        res.end(`nope ${url}`)
      })
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', () => resolve()))
    const addr = upstream.address() as AddressInfo
    upstreamUrl = `http://127.0.0.1:${addr.port}`
  }

  async function boot(accounts: Record<string, unknown>[]) {
    await startUpstream()
    const resolved = accounts.map((a) => ({
      ...a,
      baseUrl: typeof a.baseUrl === 'string' && a.baseUrl ? a.baseUrl : upstreamUrl,
    }))
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-compat-'))
    const base = loadConfig()
    const config: AppConfig = {
      ...base,
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const accountsStore = new AccountStore(dir, config)
    await accountsStore.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    const app = createServer(accountsStore, config, exits, pools)
    const headers = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' }
    const imported = await app.request('/admin/accounts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'replace', accounts: resolved }),
    })
    expect(imported.status).toBe(200)
    return { app, accountsStore, config }
  }

  it('routes /v1/chat/completions to openai_compat account', async () => {
    const { app } = await boot([
      {
        id: 'oai-1',
        label: 'OpenAI relay',
        upstreamType: 'openai_compat',
        upstreamApiKey: 'sk-test-openai',
        enabled: true,
      },
    ])
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(json.choices[0]?.message?.content).toBe('hello from openai compat')
    expect(json.usage.prompt_tokens).toBe(11)
    expect(json.usage.completion_tokens).toBe(7)
  })

  it('routes /v1/messages to anthropic_compat account', async () => {
    const { app } = await boot([
      {
        id: 'ant-1',
        label: 'Anthropic relay',
        upstreamType: 'anthropic_compat',
        upstreamApiKey: 'sk-test-anthropic',
        enabled: true,
      },
    ])
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      content: { type: string; text: string }[]
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(json.content[0]?.text).toBe('hello from anthropic compat')
    expect(json.usage.input_tokens).toBe(9)
    expect(json.usage.output_tokens).toBe(5)
  })

  it('skips mismatched compat type and returns 503 when none remain', async () => {
    const { app } = await boot([
      {
        id: 'ant-only',
        label: 'Anthropic only',
        upstreamType: 'anthropic_compat',
        upstreamApiKey: 'sk-test-anthropic',
        enabled: true,
      },
    ])
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(503)
  })

  it('creates compat account via admin POST /accounts', async () => {
    await startUpstream()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-compat-'))
    const config: AppConfig = {
      ...loadConfig(),
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const accountsStore = new AccountStore(dir, config)
    await accountsStore.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    const app = createServer(accountsStore, config, exits, pools)
    const created = await app.request('/admin/accounts', {
      method: 'POST',
      headers: { 'x-admin-token': 'test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'relay-create',
        upstreamType: 'openai_compat',
        baseUrl: upstreamUrl,
        upstreamApiKey: 'sk-test-openai',
        enabled: true,
      }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { upstreamType: string; baseUrl: string }
    expect(body.upstreamType).toBe('openai_compat')
    expect(body.baseUrl).toBe(upstreamUrl)
  })

  it('PATCHes compat fields including clearing modelPrefix', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-compat-patch-'))
    const config: AppConfig = {
      ...loadConfig(),
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const accountsStore = new AccountStore(dir, config)
    await accountsStore.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    const app = createServer(accountsStore, config, exits, pools)

    const created = await app.request('/admin/accounts', {
      method: 'POST',
      headers: { 'x-admin-token': 'test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'relay-edit',
        upstreamType: 'openai_compat',
        baseUrl: 'https://relay.example/v1',
        upstreamApiKey: 'sk-original',
        modelPrefix: 'openai/',
        defaultHeaders: { 'x-custom': '1' },
        enabled: true,
      }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { id: string; modelPrefix?: string }
    expect(createdBody.modelPrefix).toBe('openai/')

    const patched = await app.request(`/admin/accounts/${createdBody.id}`, {
      method: 'PATCH',
      headers: { 'x-admin-token': 'test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'relay-edited',
        baseUrl: 'https://relay.example/openai/v1',
        modelPrefix: '',
        defaultHeaders: { 'x-custom': '2' },
        upstreamApiKey: '', // blank keeps existing
        upstreamType: 'anthropic_compat',
      }),
    })
    expect(patched.status).toBe(200)
    const body = (await patched.json()) as {
      label: string
      baseUrl: string
      modelPrefix?: string
      upstreamApiKey?: string
      upstreamType: string
      defaultHeaders?: Record<string, string>
    }
    expect(body.label).toBe('relay-edited')
    expect(body.baseUrl).toBe('https://relay.example/openai/v1')
    expect(body.modelPrefix).toBeUndefined()
    expect(body.upstreamApiKey).toBe('sk-original')
    expect(body.upstreamType).toBe('anthropic_compat')
    expect(body.defaultHeaders).toEqual({ 'x-custom': '2' })

    // Direct store check: empty string clears prefix
    const cleared = await accountsStore.update(createdBody.id, { modelPrefix: 'tmp/' })
    expect(cleared.modelPrefix).toBe('tmp/')
    const empty = await accountsStore.update(createdBody.id, { modelPrefix: '' })
    expect(empty.modelPrefix).toBeUndefined()
  })

  it('skips accounts whose supportedModels do not match request model', async () => {
    await startUpstream()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-compat-model-'))
    const config: AppConfig = {
      ...loadConfig(),
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const accountsStore = new AccountStore(dir, config)
    await accountsStore.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    const app = createServer(accountsStore, config, exits, pools)

    // Allowlist uses post-rewrite ids (builtin gpt-4* → claude-sonnet-4.5).
    await accountsStore.create({
      label: 'only-sonnet',
      upstreamType: 'openai_compat',
      baseUrl: upstreamUrl,
      upstreamApiKey: 'sk-test-openai',
      supportedModels: ['claude-sonnet-4.5'],
      enabled: true,
      accessToken: '',
    })

    const denied = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(denied.status).toBe(503)

    // Client alias gpt-4 rewrites to claude-sonnet-4.5 before pool filter.
    const ok = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(ok.status).toBe(200)
  })

  it('uses upstreamModels cache when supportedModels empty', async () => {
    await startUpstream()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-compat-cache-'))
    const config: AppConfig = {
      ...loadConfig(),
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const accountsStore = new AccountStore(dir, config)
    await accountsStore.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    const app = createServer(accountsStore, config, exits, pools)

    await accountsStore.create({
      label: 'cached',
      upstreamType: 'openai_compat',
      baseUrl: upstreamUrl,
      upstreamApiKey: 'sk-test-openai',
      upstreamModels: ['claude-haiku-4.5'],
      enabled: true,
      accessToken: '',
    })

    const denied = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(denied.status).toBe(503)

    const ok = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(ok.status).toBe(200)
  })

  it('refresh-models caches OpenAI-style /v1/models list', async () => {
    const modelsServer = createHttpServer((req, res) => {
      if (req.url === '/v1/models' || req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4' }] }))
        return
      }
      res.writeHead(404)
      res.end('no')
    })
    await new Promise<void>((resolve) => modelsServer.listen(0, '127.0.0.1', resolve))
    const addr = modelsServer.address() as AddressInfo
    const modelsUrl = `http://127.0.0.1:${addr.port}/v1`

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-compat-refresh-'))
    const config: AppConfig = {
      ...loadConfig(),
      dataDir: dir,
      apiKey: 'test-key',
      adminToken: 'test-admin',
    }
    const accountsStore = new AccountStore(dir, config)
    await accountsStore.init()
    const exits = new ExitsStore(dir)
    await exits.init()
    const pools = new PoolsStore(dir)
    await pools.init()
    const app = createServer(accountsStore, config, exits, pools)

    const created = await accountsStore.create({
      label: 'refresh-me',
      upstreamType: 'openai_compat',
      baseUrl: modelsUrl,
      upstreamApiKey: 'sk-test',
      enabled: true,
      accessToken: '',
    })

    const res = await app.request(`/admin/accounts/${created.id}/refresh-models`, {
      method: 'POST',
      headers: { 'x-admin-token': 'test-admin' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      models: string[]
      account: { upstreamModels?: string[]; upstreamModelsFetchedAt?: number }
    }
    expect(body.models).toEqual(['gpt-4o', 'gpt-4'])
    expect(body.account.upstreamModels).toEqual(['gpt-4o', 'gpt-4'])
    expect(body.account.upstreamModelsFetchedAt).toBeTypeOf('number')

    await new Promise<void>((resolve, reject) => {
      modelsServer.close((err) => (err ? reject(err) : resolve()))
    })
  })
})
