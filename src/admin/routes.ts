import { Hono } from 'hono'
import type { AccountStore } from '../accounts/store.js'
import type { AccountCreateInput, AccountRecord, PersistedConfig } from '../accounts/types.js'
import { normalizeAccountImport } from '../accounts/importNormalize.js'
import { refreshAccountToken } from '../kiro/auth.js'
import { adminAuth } from '../middleware/auth.js'
import type { AppConfig } from '../config.js'
import type { ExitsStore } from '../exits/store.js'
import { pickExitId, type ExitAssignStrategy } from '../exits/assign.js'
import type { PoolsStore, ProxyPool } from '../pools/store.js'
import { assignAccountToPool, rebindAccountExitAfterBan } from '../pools/rebind.js'
import { probeMany } from '../exits/probe.js'
import { probeTlsFingerprint } from './tlsProbe.js'
import type { ApiKeyStore } from '../apiKeys/store.js'
import type { ModelMapStore } from '../proxy/modelMapStore.js'
import { globalRequestLog } from '../proxy/requestLog.js'
import { mapModelId, PUBLIC_MODELS } from '../kiro/translator.js'

export interface AdminRouteExtras {
  apiKeys?: ApiKeyStore
  modelMap?: ModelMapStore
}

export function createAdminRoutes(
  store: AccountStore,
  config: AppConfig,
  exitsStore?: ExitsStore,
  poolsStore?: PoolsStore,
  extras?: AdminRouteExtras,
): Hono {
  const app = new Hono()
  app.use('*', adminAuth(config))
  const apiKeys = extras?.apiKeys
  const modelMap = extras?.modelMap

  function assignedExit(acc: AccountRecord) {
    if (!acc.outboundPoolId && !acc.outboundExitId) return null
    const exit = acc.outboundExitId ? exitsStore?.getEntry(acc.outboundExitId) : undefined
    return {
      poolId: acc.outboundPoolId ?? null,
      exitId: acc.outboundExitId ?? null,
      exitIp: exit?.exitIp || exit?.expectedExitIp || null,
    }
  }

  function withExit(acc: AccountRecord) {
    return { ...acc, assignedExit: assignedExit(acc) }
  }

  app.get('/accounts', (c) => {
    const q = (c.req.query('q') || '').trim().toLowerCase()
    const group = (c.req.query('group') || '').trim().toLowerCase()
    const tag = (c.req.query('tag') || '').trim().toLowerCase()
    let accounts = store.list().map(withExit)
    if (group) {
      accounts = accounts.filter((a) => (a.group || '').toLowerCase() === group)
    }
    if (tag) {
      accounts = accounts.filter((a) => (a.tags || []).some((t) => t.toLowerCase() === tag))
    }
    if (q) {
      accounts = accounts.filter((a) =>
        JSON.stringify({
          label: a.label,
          email: a.email,
          group: a.group,
          tags: a.tags,
          pool: a.outboundPoolId,
          exit: a.outboundExitId,
          ip: a.assignedExit?.exitIp,
        })
          .toLowerCase()
          .includes(q),
      )
    }
    const groups = [...new Set(store.list().map((a) => a.group).filter(Boolean) as string[])].sort()
    const tags = [...new Set(store.list().flatMap((a) => a.tags || []))].sort()
    return c.json({ accounts, groups, tags })
  })

  app.get('/accounts/:id', (c) => {
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    return c.json(withExit(acc))
  })

  app.post('/accounts', async (c) => {
    const body = (await c.req.json()) as AccountCreateInput
    if (!body.accessToken && !body.refreshToken) {
      return c.json({ error: 'accessToken or refreshToken is required' }, 400)
    }
    try {
      const created = await store.create(body)
      return c.json(withExit(created), 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.patch('/accounts/:id', async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>
      if (body.group === null) body.group = undefined
      if (Array.isArray(body.tags)) {
        body.tags = [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))]
      }
      const updated = await store.update(c.req.param('id'), body as never)
      return c.json(withExit(updated))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.delete('/accounts/:id', async (c) => {
    const ok = await store.remove(c.req.param('id'))
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  app.post('/accounts/:id/enable', async (c) => {
    try {
      return c.json(await store.setEnabled(c.req.param('id'), true))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/accounts/:id/disable', async (c) => {
    try {
      return c.json(await store.setEnabled(c.req.param('id'), false))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/accounts/:id/refresh', async (c) => {
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    const result = await refreshAccountToken(acc)
    if (!result.success || !result.accessToken) {
      return c.json({ error: result.error || 'Refresh failed' }, 502)
    }
    await store.applyTokenRefresh(acc.id, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    })
    store.pool.updateAccount(acc.id, { isAvailable: true })
    return c.json({ ok: true, account: withExit(store.get(acc.id)!) })
  })

  app.post('/accounts/:id/unsuspend', async (c) => {
    store.pool.clearSuspended(c.req.param('id'))
    await store.flush()
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    return c.json(withExit(acc))
  })

  /**
   * Batch account ops for admin UI.
   * action: refresh | enable | disable | unsuspend | delete | bind-pool | set-meta
   */
  app.post('/accounts/batch', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: string
      ids?: string[]
      poolId?: string
      group?: string | null
      tags?: string[]
    }
    const action = (body.action || '').trim()
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : []
    if (!action) return c.json({ error: 'action is required' }, 400)
    if (!ids.length) return c.json({ error: 'ids array required' }, 400)

    const results: Array<{ id: string; ok: boolean; error?: string }> = []

    for (const id of ids) {
      try {
        const acc = store.get(id)
        if (!acc && action !== 'delete') {
          results.push({ id, ok: false, error: 'Not found' })
          continue
        }
        switch (action) {
          case 'enable':
            await store.setEnabled(id, true)
            results.push({ id, ok: true })
            break
          case 'disable':
            await store.setEnabled(id, false)
            results.push({ id, ok: true })
            break
          case 'unsuspend':
            store.pool.clearSuspended(id)
            await store.flush()
            results.push({ id, ok: true })
            break
          case 'delete': {
            const ok = await store.remove(id)
            results.push({ id, ok, error: ok ? undefined : 'Not found' })
            break
          }
          case 'refresh': {
            if (!acc) {
              results.push({ id, ok: false, error: 'Not found' })
              break
            }
            const result = await refreshAccountToken(acc)
            if (!result.success || !result.accessToken) {
              results.push({ id, ok: false, error: result.error || 'Refresh failed' })
              break
            }
            await store.applyTokenRefresh(acc.id, {
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              expiresAt: result.expiresAt,
            })
            store.pool.updateAccount(acc.id, { isAvailable: true })
            results.push({ id, ok: true })
            break
          }
          case 'bind-pool': {
            if (!exitsStore || !poolsStore) {
              results.push({ id, ok: false, error: 'exits/pools store not initialized' })
              break
            }
            if (!acc) {
              results.push({ id, ok: false, error: 'Not found' })
              break
            }
            const poolId = body.poolId?.trim()
            if (!poolId) {
              results.push({ id, ok: false, error: 'poolId is required' })
              break
            }
            const result = await assignAccountToPool(acc, poolId, {
              accounts: store,
              exits: exitsStore,
              pools: poolsStore,
            })
            results.push({
              id,
              ok: result.ok,
              error: result.ok ? undefined : result.error || 'bind failed',
            })
            break
          }
          case 'set-meta': {
            const patch: { group?: string; tags?: string[] } = {}
            if (body.group !== undefined) {
              patch.group = body.group === null || body.group === '' ? undefined : String(body.group)
            }
            if (body.tags !== undefined) {
              patch.tags = Array.isArray(body.tags)
                ? [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))]
                : []
            }
            await store.update(id, patch)
            results.push({ id, ok: true })
            break
          }
          default:
            return c.json({ error: `unknown action: ${action}` }, 400)
        }
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const ok = results.filter((r) => r.ok).length
    return c.json({ action, ok, failed: results.length - ok, results })
  })

  app.post('/accounts/:id/bind-pool', async (c) => {
    if (!exitsStore || !poolsStore) {
      return c.json({ error: 'exits/pools store not initialized' }, 500)
    }
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { poolId?: string }
    const poolId = body.poolId?.trim()
    if (!poolId) return c.json({ error: 'poolId is required' }, 400)
    const result = await assignAccountToPool(acc, poolId, {
      accounts: store,
      exits: exitsStore,
      pools: poolsStore,
    })
    if (!result.ok) return c.json({ error: result.error || 'bind failed', ...result }, 400)
    const account = store.get(acc.id)
    return c.json({
      ...result,
      account: account ? withExit(account) : account,
      assignedExit: account ? assignedExit(account) : null,
    })
  })

  app.post('/accounts/:id/unbind-pool', async (c) => {
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    const updated = await store.update(acc.id, {
      outboundPoolId: undefined,
      outboundExitId: undefined,
      outboundProxyUrl: undefined,
    })
    return c.json({ ok: true, account: withExit(updated), assignedExit: null })
  })

  app.post('/accounts/:id/rebind-exit', async (c) => {
    if (!exitsStore || !poolsStore) {
      return c.json({ error: 'exits/pools store not initialized' }, 500)
    }
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as {
      bumpBan?: boolean
      cooldownMs?: number
    }
    const result = await rebindAccountExitAfterBan(acc, {
      accounts: store,
      exits: exitsStore,
      pools: poolsStore,
      bumpBan: body.bumpBan !== false,
      cooldownMs: body.cooldownMs,
    })
    if (!result.ok) {
      return c.json({ error: result.error || 'rebind failed', ...result }, 400)
    }
    const account = store.get(acc.id)
    return c.json({ ...result, account: account ? withExit(account) : account, assignedExit: account ? assignedExit(account) : null })
  })

  app.post('/accounts/import', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const normalized = normalizeAccountImport(body)
    if (!normalized.accounts.length) {
      return c.json(
        { error: 'no accounts recognized', warnings: normalized.warnings },
        400,
      )
    }
    const result = await store.importAccounts(normalized.accounts, normalized.mode)
    return c.json({ ...result, mode: normalized.mode, warnings: normalized.warnings })
  })

  app.get('/accounts/export', (c) => {
    return c.json({ accounts: store.exportAccounts() })
  })

  app.get('/pool/stats', (c) => {
    const quota = store.pool.getQuotaStatus()
    const stats = store.pool.getStats()
    const accounts: Record<string, unknown> = {}
    for (const [id, s] of stats.accounts) {
      accounts[id] = s
    }
    return c.json({
      strategy: store.pool.getStrategy(),
      quota,
      total: stats.total,
      availableCount: store.pool.availableCount,
      size: store.pool.size,
      accounts,
      config: store.getPersistedConfig(),
    })
  })

  app.patch('/pool/config', async (c) => {
    const patch = (await c.req.json()) as PersistedConfig
    const next = await store.patchConfig(patch)
    return c.json(next)
  })

  app.post('/pool/reset', async (c) => {
    store.pool.reset()
    await store.flush()
    return c.json({ ok: true, quota: store.pool.getQuotaStatus() })
  })

  // --- Exits ---

  app.get('/exits', (c) => {
    if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
    return c.json(exitsStore.get())
  })

  app.post('/exits/import', async (c) => {
    if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
    try {
      const body = (await c.req.json()) as {
        exits?: Array<{
          id: string
          server?: string
          port?: number
          method?: string
          password?: string
          index?: number
          exitIp?: string
          expectedExitIp?: string
          useCount?: number
          banCount?: number
          disabled?: boolean
          outboundProxyUrl?: string
        }>
        exitIds?: string[]
        /** @deprecated Prefer native SS fields on exits[] */
        brokerBase?: string
      }
      const result = await exitsStore.importExits(body)
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/exits/assign', async (c) => {
    if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
    try {
      const body = (await c.req.json()) as {
        strategy?: ExitAssignStrategy | 'rr'
        accountIds?: string[]
      }
      let strategy: ExitAssignStrategy = 'sticky'
      if (body.strategy === 'round-robin' || body.strategy === 'rr') strategy = 'round-robin'
      else if (body.strategy === 'sticky' || body.strategy === undefined) strategy = 'sticky'
      else return c.json({ error: 'strategy must be sticky | round-robin' }, 400)

      const exitIds = exitsStore.listIds()
      if (exitIds.length === 0) {
        return c.json({ error: 'No exits imported; POST /admin/exits/import first' }, 400)
      }

      const targets =
        body.accountIds && body.accountIds.length > 0
          ? body.accountIds
              .map((id) => store.get(id))
              .filter((a): a is NonNullable<typeof a> => !!a)
          : store.list()

      const assigned: Array<{
        accountId: string
        exitId: string
        outboundProxyUrl: string
      }> = []
      const errors: Array<{ accountId: string; error: string }> = []
      let rr = 0

      for (const acc of targets) {
        if (!acc) continue
        try {
          const exitId = pickExitId(acc.id, exitIds, strategy, rr++)
          const outboundProxyUrl = await exitsStore.ensureProxyUrl(exitId)
          await store.update(acc.id, { outboundExitId: exitId, outboundProxyUrl })
          assigned.push({ accountId: acc.id, exitId, outboundProxyUrl })
        } catch (err) {
          errors.push({
            accountId: acc.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return c.json({
        strategy,
        assigned,
        errors,
        exitCount: exitIds.length,
        brokerBase: exitsStore.get().brokerBase || null,
      })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  /** Optional ops probe — not used by pool assign. */
  app.post('/exits/probe', async (c) => {
    if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        exitIds?: string[]
        poolId?: string
        concurrency?: number
        timeoutMs?: number
        url?: string
      }
      let ids = body.exitIds
      if ((!ids || ids.length === 0) && body.poolId) {
        if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
        ids = poolsStore.getExitIds(body.poolId)
      }
      if (!ids || ids.length === 0) ids = exitsStore.listIds()
      const results = await probeMany(exitsStore, ids, {
        concurrency: body.concurrency,
        timeoutMs: body.timeoutMs,
        url: body.url,
      })
      return c.json({ results, note: 'probe is optional; pools assign does not require it' })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/exits/:id/disable', async (c) => {
    if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
    try {
      return c.json(await exitsStore.setDisabled(c.req.param('id'), true))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/exits/:id/enable', async (c) => {
    if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
    try {
      return c.json(
        await exitsStore.updateExitStats(c.req.param('id'), {
          disabled: false,
          cooldownUntil: undefined,
        }),
      )
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  // --- Proxy pools ---

  app.get('/pools', (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    return c.json({ pools: poolsStore.list() })
  })

  app.post('/pools', async (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    try {
      const body = (await c.req.json()) as ProxyPool | { pools: ProxyPool[] }
      if ('pools' in body && Array.isArray(body.pools)) {
        const pools = await poolsStore.upsertMany(body.pools)
        return c.json({ pools })
      }
      const pool = await poolsStore.upsert(body as ProxyPool)
      return c.json(pool, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get('/pools/:id', (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    const pool = poolsStore.get(c.req.param('id'))
    if (!pool) return c.json({ error: 'Not found' }, 404)
    return c.json(pool)
  })

  app.post('/pools/:id/disable', async (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    try {
      return c.json(await poolsStore.setDisabled(c.req.param('id'), true))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/pools/:id/enable', async (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    try {
      return c.json(await poolsStore.setDisabled(c.req.param('id'), false))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.delete('/pools/:id', async (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    const ok = await poolsStore.delete(c.req.param('id'))
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  app.put('/pools/:id/exits', async (c) => {
    if (!poolsStore) return c.json({ error: 'pools store not initialized' }, 500)
    try {
      const body = (await c.req.json()) as { exitIds?: string[] }
      if (!Array.isArray(body.exitIds)) {
        return c.json({ error: 'exitIds array required' }, 400)
      }
      const pool = await poolsStore.setExitIds(c.req.param('id'), body.exitIds)
      return c.json(pool)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/pools/:id/assign', async (c) => {
    if (!exitsStore || !poolsStore) {
      return c.json({ error: 'exits/pools store not initialized' }, 500)
    }
    try {
      const poolId = c.req.param('id')
      const pool = poolsStore.get(poolId)
      if (!pool) return c.json({ error: 'Not found' }, 404)
      const body = (await c.req.json().catch(() => ({}))) as { accountIds?: string[] }
      const targets =
        body.accountIds && body.accountIds.length > 0
          ? body.accountIds
              .map((id) => store.get(id))
              .filter((a): a is NonNullable<typeof a> => !!a)
          : store.list()

      const assigned: Array<{
        accountId: string
        exitId: string
        outboundProxyUrl: string
        poolId: string
      }> = []
      const errors: Array<{ accountId: string; error: string }> = []

      for (const acc of targets) {
        const result = await assignAccountToPool(acc, poolId, {
          accounts: store,
          exits: exitsStore,
          pools: poolsStore,
        })
        if (result.ok && result.exitId && result.outboundProxyUrl) {
          assigned.push({
            accountId: result.accountId,
            exitId: result.exitId,
            outboundProxyUrl: result.outboundProxyUrl,
            poolId,
          })
        } else {
          errors.push({ accountId: acc.id, error: result.error || 'assign failed' })
        }
      }

      return c.json({
        strategy: 'stats',
        poolId,
        assigned,
        errors,
        policy: 'useCount asc, banCount asc, hash(accountId+exitId) asc',
      })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  /**
   * Observe-only JA3/JA4/ALPN/egress comparison.
   * Uses the account (or exit) sticky outbound dispatcher as-is.
   */
  app.post('/tls-probe', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        accountId?: string
        exitId?: string
        compareDirect?: boolean
        url?: string
        timeoutMs?: number
      }
      let proxyUrl: string | undefined
      let accountId: string | undefined
      let exitId = body.exitId?.trim() || undefined
      let poolId: string | undefined

      if (body.accountId) {
        const acc = store.get(body.accountId)
        if (!acc) return c.json({ error: 'account not found' }, 404)
        accountId = acc.id
        poolId = acc.outboundPoolId
        exitId = acc.outboundExitId || exitId
        proxyUrl = acc.outboundProxyUrl
        if (!proxyUrl && exitId && exitsStore) {
          proxyUrl = await exitsStore.ensureProxyUrl(exitId)
        }
      } else if (exitId) {
        if (!exitsStore) return c.json({ error: 'exits store not initialized' }, 500)
        proxyUrl = await exitsStore.ensureProxyUrl(exitId)
      }

      const report = await probeTlsFingerprint({
        proxyUrl,
        compareDirect: body.compareDirect,
        url: body.url,
        timeoutMs: body.timeoutMs,
      })
      return c.json({ accountId: accountId ?? null, poolId: poolId ?? null, exitId: exitId ?? null, ...report })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get('/usage', async (c) => c.json(await store.getUsage()))

  // --- API reverse-proxy admin ---

  app.get('/api-meta', (c) => {
    const proto = c.req.header('x-forwarded-proto') || 'http'
    const host = c.req.header('x-forwarded-host') || c.req.header('host') || `${config.host}:${config.port}`
    const base = `${proto}://${host}`.replace(/\/$/, '')
    return c.json({
      publicBaseUrl: base,
      listen: `http://${config.host}:${config.port}`,
      endpoints: {
        openaiChatCompletions: `${base}/v1/chat/completions`,
        openaiModels: `${base}/v1/models`,
        anthropicMessages: `${base}/v1/messages`,
        anthropicMessagesAlias: `${base}/anthropic/v1/messages`,
        anthropicCountTokens: `${base}/v1/messages/count_tokens`,
      },
      auth: {
        headerBearer: 'Authorization: Bearer <API_KEY>',
        headerXApiKey: 'x-api-key: <API_KEY>',
        envKeyConfigured: Boolean(config.apiKey),
        envKeyMasked: apiKeys?.envKeyMasked() || (config.apiKey ? '••••' : ''),
      },
      notes: [
        '账号选择：round-robin / sticky（见池配置）。',
        '出站：账号绑定代理池后，请求走粘性 SS 出口；未绑池则直连或全局代理。',
        'Messages 与 Chat Completions 共用账号池与出站绑定。',
      ],
    })
  })

  app.get('/api-keys', (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    return c.json({
      keys: apiKeys.listPublic(),
      envKey: { configured: apiKeys.hasEnvKey(), masked: apiKeys.envKeyMasked() },
    })
  })

  app.post('/api-keys', async (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    const body = (await c.req.json().catch(() => ({}))) as { label?: string }
    const created = await apiKeys.create(body.label || '')
    // Return full key once
    return c.json({ key: created, warning: 'Copy the key now; it will be masked in subsequent listings.' }, 201)
  })

  app.patch('/api-keys/:id', async (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    const body = (await c.req.json().catch(() => ({}))) as { label?: string }
    if (body.label === undefined) return c.json({ error: 'label required' }, 400)
    const updated = await apiKeys.updateLabel(c.req.param('id'), body.label)
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true, id: updated.id, label: updated.label })
  })

  app.post('/api-keys/:id/revoke', async (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    const updated = await apiKeys.revoke(c.req.param('id'))
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true, id: updated.id, revokedAt: updated.revokedAt })
  })

  app.delete('/api-keys/:id', async (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    const ok = await apiKeys.remove(c.req.param('id'))
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/model-map', (c) => {
    const custom = modelMap?.get() || {}
    const resolvedSamples = Object.keys(custom).slice(0, 20).map((k) => ({
      from: k,
      to: custom[k],
      via: 'custom' as const,
    }))
    return c.json({
      map: custom,
      builtinPublicModels: PUBLIC_MODELS,
      samples: resolvedSamples,
      note: 'Custom entries override builtin OpenAI→upstream mapping used by chat completions / messages.',
    })
  })

  app.put('/model-map', async (c) => {
    if (!modelMap) return c.json({ error: 'model map store not initialized' }, 500)
    const body = (await c.req.json().catch(() => ({}))) as { map?: Record<string, string> }
    if (!body.map || typeof body.map !== 'object') {
      return c.json({ error: 'map object required' }, 400)
    }
    const next = await modelMap.set(body.map)
    return c.json({ map: next })
  })

  app.post('/model-map', async (c) => {
    if (!modelMap) return c.json({ error: 'model map store not initialized' }, 500)
    const body = (await c.req.json().catch(() => ({}))) as { openaiName?: string; upstream?: string }
    try {
      const next = await modelMap.upsert(body.openaiName || '', body.upstream || '')
      return c.json({ map: next, resolved: mapModelId(body.openaiName || '') })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete('/model-map/:name', async (c) => {
    if (!modelMap) return c.json({ error: 'model map store not initialized' }, 500)
    const next = await modelMap.remove(decodeURIComponent(c.req.param('name')))
    return c.json({ map: next })
  })

  app.get('/request-log', (c) => {
    const q = c.req.query('q') || undefined
    const pathQ = c.req.query('path') || undefined
    const apiStyle = c.req.query('apiStyle') || undefined
    const limit = Number(c.req.query('limit') || 100)
    return c.json({
      size: globalRequestLog.size,
      capacity: globalRequestLog.capacity,
      entries: globalRequestLog.list({ q, path: pathQ, apiStyle, limit }),
    })
  })

  app.delete('/request-log', (c) => {
    globalRequestLog.clear()
    return c.json({ ok: true })
  })

  return app
}
