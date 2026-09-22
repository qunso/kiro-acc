import { Hono } from 'hono'
import type { AccountStore } from '../accounts/store.js'
import type { AccountCreateInput, PersistedConfig } from '../accounts/types.js'
import { refreshAccountToken } from '../kiro/auth.js'
import { adminAuth } from '../middleware/auth.js'
import type { AppConfig } from '../config.js'

export function createAdminRoutes(store: AccountStore, config: AppConfig): Hono {
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

  app.get('/usage', async (c) => c.json(await store.getUsage()))

  return app
}
