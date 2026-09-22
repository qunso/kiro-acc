import { Hono } from 'hono'
import type { AccountStore } from '../accounts/store.js'
import type { AccountCreateInput, PersistedConfig } from '../accounts/types.js'
import { refreshAccountToken } from '../kiro/auth.js'
import { adminAuth } from '../middleware/auth.js'
import type { AppConfig } from '../config.js'
import type { ExitsStore } from '../exits/store.js'
import { pickExitId, type ExitAssignStrategy } from '../exits/assign.js'
import type { PoolsStore, ProxyPool } from '../pools/store.js'
import { assignAccountToPool, rebindAccountExitAfterBan } from '../pools/rebind.js'
import { probeMany } from '../exits/probe.js'

export function createAdminRoutes(
  store: AccountStore,
  config: AppConfig,
  exitsStore?: ExitsStore,
  poolsStore?: PoolsStore,
): Hono {
  const app = new Hono()
  app.use('*', adminAuth(config))

  app.get('/accounts', (c) => c.json({ accounts: store.list() }))

  app.get('/accounts/:id', (c) => {
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    return c.json(acc)
  })

  app.post('/accounts', async (c) => {
    const body = (await c.req.json()) as AccountCreateInput
    if (!body.accessToken) {
      return c.json({ error: 'accessToken is required' }, 400)
    }
    try {
      const created = await store.create(body)
      return c.json(created, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.patch('/accounts/:id', async (c) => {
    try {
      const updated = await store.update(c.req.param('id'), await c.req.json())
      return c.json(updated)
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
    return c.json({ ok: true, account: store.get(acc.id) })
  })

  app.post('/accounts/:id/unsuspend', async (c) => {
    store.pool.clearSuspended(c.req.param('id'))
    await store.flush()
    const acc = store.get(c.req.param('id'))
    if (!acc) return c.json({ error: 'Not found' }, 404)
    return c.json(acc)
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
    return c.json({ ...result, account: store.get(acc.id) })
  })

  app.post('/accounts/import', async (c) => {
    const body = (await c.req.json()) as {
      accounts?: AccountCreateInput[]
      mode?: 'merge' | 'replace'
    }
    const items = body.accounts || (Array.isArray(body) ? (body as AccountCreateInput[]) : null)
    if (!items) return c.json({ error: 'accounts array required' }, 400)
    const result = await store.importAccounts(items, body.mode || 'merge')
    return c.json(result)
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

  app.get('/usage', async (c) => c.json(await store.getUsage()))

  return app
}
