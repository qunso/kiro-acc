import { createServer as createHttpServer, type AddressInfo } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore } from '../src/accounts/store.js'
import { loadConfig, type AppConfig } from '../src/config.js'
import { ExitsStore } from '../src/exits/store.js'
import { setCustomModelMap } from '../src/kiro/translator.js'
import { openaiToKiro } from '../src/kiro/translator.js'
import { claudeToKiro } from '../src/kiro/anthropic.js'
import { PoolsStore } from '../src/pools/store.js'
import { ModelMapStore } from '../src/proxy/modelMapStore.js'
import { resolveRequestModel } from '../src/proxy/resolveModel.js'
import { createServer } from '../src/server.js'

describe('resolveRequestModel', () => {
  afterEach(() => setCustomModelMap({}))

  it('applies custom map then builtin aliases', () => {
    setCustomModelMap({ cc: 'claude-opus-5' })
    expect(resolveRequestModel('cc')).toBe('claude-opus-5')
    expect(resolveRequestModel('gpt-4o')).toBe('claude-sonnet-4.5')
    expect(resolveRequestModel('claude-sonnet-4-5')).toBe('claude-sonnet-4.5')
  })

  it('is idempotent on its own outputs (no chain on re-apply of result)', () => {
    setCustomModelMap({ cc: 'claude-opus-5' })
    const once = resolveRequestModel('cc')
    expect(once).toBe('claude-opus-5')
    expect(resolveRequestModel(once)).toBe('claude-opus-5')
  })
})

describe('Kiro translate does not double-apply mapModelId', () => {
  afterEach(() => setCustomModelMap({}))

  it('openaiToKiro uses request.model as-is (caller already resolved)', () => {
    // If translators re-applied mapModelId, a→b then b→c would become c.
    setCustomModelMap({ a: 'b', b: 'c' })
    const resolved = resolveRequestModel('a') // → b
    expect(resolved).toBe('b')
    const payload = openaiToKiro(
      { model: resolved, messages: [{ role: 'user', content: 'hi' }] },
      'arn:aws:codewhisperer:us-east-1:1:profile/p',
    )
    const mid =
      payload.conversationState.currentMessage.userInputMessage.modelId
    expect(mid).toBe('b') // not 'c'
  })

  it('claudeToKiro uses request.model as-is', () => {
    setCustomModelMap({ a: 'b', b: 'c' })
    const resolved = resolveRequestModel('a')
    const payload = claudeToKiro(
      {
        model: resolved,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
      'arn:aws:codewhisperer:us-east-1:1:profile/p',
    )
    const mid =
      payload.conversationState.currentMessage.userInputMessage.modelId
    expect(mid).toBe('b')
  })
})

describe('unified rewrite on compat + pool filter', () => {
  let dir: string | undefined
  let upstream: ReturnType<typeof createHttpServer> | undefined
  let upstreamUrl = ''
  let lastForwardedModel: string | undefined

  afterEach(async () => {
    setCustomModelMap({})
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
    lastForwardedModel = undefined
  })

  async function startUpstream() {
    upstream = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const url = req.url || ''
        let parsed: { model?: string } = {}
        try {
          parsed = JSON.parse(body || '{}') as { model?: string }
        } catch {
          /* ignore */
        }
        lastForwardedModel = parsed.model
        if (url.includes('chat/completions')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              model: parsed.model || 'unknown',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          )
          return
        }
        if (url.includes('/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: parsed.model || 'unknown',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          )
          return
        }
        res.writeHead(404)
        res.end('nope')
      })
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', () => resolve()))
    const addr = upstream.address() as AddressInfo
    upstreamUrl = `http://127.0.0.1:${addr.port}`
  }

  async function boot(opts: {
    accounts: Record<string, unknown>[]
    modelMap?: Record<string, string>
  }) {
    await startUpstream()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-unify-rewrite-'))
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
    const modelMap = new ModelMapStore(dir)
    await modelMap.init()
    if (opts.modelMap) await modelMap.set(opts.modelMap)
    const app = createServer(accountsStore, config, exits, pools, { modelMap })
    for (const a of opts.accounts) {
      await accountsStore.create({
        enabled: true,
        accessToken: '',
        baseUrl: upstreamUrl,
        ...(a as object),
      } as Parameters<AccountStore['create']>[0])
    }
    return { app, accountsStore, modelMap }
  }

  it('cc→claude-opus-5: pool filter + openai_compat forward use rewritten id', async () => {
    const { app } = await boot({
      modelMap: { cc: 'claude-opus-5' },
      accounts: [
        {
          label: 'compat-opus',
          upstreamType: 'openai_compat',
          upstreamApiKey: 'sk-test',
          supportedModels: ['claude-opus-5'],
        },
      ],
    })

    const denied = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(denied.status).toBe(503)

    const ok = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cc',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(ok.status).toBe(200)
    expect(lastForwardedModel).toBe('claude-opus-5')
  })

  it('rewrite then modelPrefix on openai_compat forward', async () => {
    const { app } = await boot({
      modelMap: { cc: 'claude-opus-5' },
      accounts: [
        {
          label: 'compat-prefixed',
          upstreamType: 'openai_compat',
          upstreamApiKey: 'sk-test',
          modelPrefix: 'vendor/',
          supportedModels: ['claude-opus-5'],
        },
      ],
    })

    const ok = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cc',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(ok.status).toBe(200)
    // rewrite first → claude-opus-5, then prefix → vendor/claude-opus-5
    expect(lastForwardedModel).toBe('vendor/claude-opus-5')
  })

  it('cc→claude-opus-5 on anthropic_compat /v1/messages', async () => {
    const { app } = await boot({
      modelMap: { cc: 'claude-opus-5' },
      accounts: [
        {
          label: 'ant-compat',
          upstreamType: 'anthropic_compat',
          upstreamApiKey: 'sk-test',
          supportedModels: ['claude-opus-5'],
        },
      ],
    })

    const ok = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'cc',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(ok.status).toBe(200)
    expect(lastForwardedModel).toBe('claude-opus-5')
  })
})
