import { Hono } from 'hono'
import type { AccountStore } from '../accounts/store.js'
import type { AccountCreateInput, AccountRecord, PersistedConfig } from '../accounts/types.js'
import { normalizeAccountImport } from '../accounts/importNormalize.js'
import {
  isTokenExpiringSoon,
  refreshAccountToken,
  resolveProfileArn,
} from '../kiro/auth.js'
import { getUsageLimits, quotaDetailFromCredit, UsageLimitsError } from '../kiro/usageLimits.js'
import { callKiroApi, KiroApiError } from '../kiro/client.js'
import { mapModelId, toCodeWhispererModelId, openaiToKiro, PUBLIC_MODELS } from '../kiro/translator.js'
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
import { recordProxyUsage } from '../proxy/logUsage.js'
import type { WebhookStore } from '../webhooks/store.js'
import { WEBHOOK_EVENTS, type WebhookChannel, type WebhookEvent } from '../webhooks/types.js'
import { sendWebhookWithRetry } from '../webhooks/dispatch.js'
import { signalDiagnoseFailed, signalRefreshFailed } from '../webhooks/signals.js'
import { buildSubscriptionSummary, usageByAccount, usageByApiKey } from './subscription.js'
import { diagnoseAccount } from './diagnose.js'
import {
  assertNoSecretsInBundle,
  buildConfigSyncBundle,
  parseConfigSyncBundle,
} from './configSync.js'
import { aboutInfo } from './about.js'
import type { OpsSettingsStore } from './opsSettings.js'

export interface AdminRouteExtras {
  apiKeys?: ApiKeyStore
  modelMap?: ModelMapStore
  webhooks?: WebhookStore
  opsSettings?: OpsSettingsStore
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
  const webhooks = extras?.webhooks
  const opsSettings = extras?.opsSettings

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
      // Empty machineId/deviceId → store regenerates; non-empty replaces.
      if ('machineId' in body && (body.machineId === null || body.machineId === '')) {
        body.machineId = ''
      }
      if ('deviceId' in body && (body.deviceId === null || body.deviceId === '')) {
        body.deviceId = ''
      }
      const updated = await store.update(c.req.param('id'), body as never)
      return c.json(withExit(updated))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/accounts/:id/regenerate-machine-id', async (c) => {
    try {
      const id = c.req.param('id')
      const machineId = await store.regenerateMachineId(id)
      const acc = store.get(id)
      if (!acc) return c.json({ error: 'Not found' }, 404)
      return c.json({ ok: true, machineId, account: withExit(acc) })
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
      void signalRefreshFailed(acc.id, result.error || 'Refresh failed')
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

  app.get('/api-keys', async (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    const usage = await store.getUsage()
    const byKey = usageByApiKey(usage)
    const emptyStats = () => ({
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastUsedAt: null as number | null,
    })
    const withStats = apiKeys.listPublic().map((k) => {
      const u = byKey[k.id]
      return {
        ...k,
        requestCount: u?.requestCount || 0,
        inputTokens: u?.inputTokens || 0,
        outputTokens: u?.outputTokens || 0,
        lastUsedAt: u?.lastUsedAt || null,
      }
    })
    const envConfigured = apiKeys.hasEnvKey()
    const envUsage = byKey['env']
    return c.json({
      keys: withStats,
      envKey: {
        configured: envConfigured,
        masked: apiKeys.envKeyMasked(),
        id: 'env',
        label: 'ENV API_KEY',
        ...(envConfigured || envUsage
          ? {
              requestCount: envUsage?.requestCount || 0,
              inputTokens: envUsage?.inputTokens || 0,
              outputTokens: envUsage?.outputTokens || 0,
              lastUsedAt: envUsage?.lastUsedAt || null,
            }
          : emptyStats()),
      },
    })
  })

  app.get('/api-keys/usage', async (c) => {
    if (!apiKeys) return c.json({ error: 'api keys store not initialized' }, 500)
    const usage = await store.getUsage()
    const byKey = usageByApiKey(usage)
    type KeyUsageRow = {
      id: string
      label: string
      active: boolean
      masked: string
      requestCount: number
      inputTokens: number
      outputTokens: number
      lastUsedAt: number | null
      source: 'managed' | 'env'
    }
    const rows: KeyUsageRow[] = apiKeys.listPublic().map((k) => {
      const u = byKey[k.id]
      return {
        id: k.id,
        label: k.label,
        active: k.active,
        masked: k.masked,
        requestCount: u?.requestCount || 0,
        inputTokens: u?.inputTokens || 0,
        outputTokens: u?.outputTokens || 0,
        lastUsedAt: u?.lastUsedAt || null,
        source: 'managed',
      }
    })
    if (apiKeys.hasEnvKey() || byKey['env']) {
      const u = byKey['env']
      rows.unshift({
        id: 'env',
        label: 'ENV API_KEY',
        active: apiKeys.hasEnvKey(),
        masked: apiKeys.envKeyMasked(),
        requestCount: u?.requestCount || 0,
        inputTokens: u?.inputTokens || 0,
        outputTokens: u?.outputTokens || 0,
        lastUsedAt: u?.lastUsedAt || null,
        source: 'env',
      })
    }
    return c.json({ keys: rows, byKey })
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
    const apiKey = c.req.query('apiKey') || undefined
    const limit = Number(c.req.query('limit') || 100)
    return c.json({
      size: globalRequestLog.size,
      capacity: globalRequestLog.capacity,
      entries: globalRequestLog.list({ q, path: pathQ, apiStyle, apiKey, limit }),
    })
  })

  app.delete('/request-log', (c) => {
    globalRequestLog.clear()
    return c.json({ ok: true })
  })

  // --- Subscription / usage (derived from local pool + auth metadata) ---

  app.get('/subscriptions', async (c) => {
    const summary = buildSubscriptionSummary(store.list())
    const usage = await store.getUsage()
    const byAccount = usageByAccount(usage)
    const rows = summary.rows.map((r) => ({
      ...r,
      persistedUsage: byAccount[r.id] || null,
    }))
    return c.json({
      ...summary,
      rows,
      note: 'subscriptionType is derived from provider/authMethod; quota from GetUsageLimits CREDIT breakdown (refresh-subscription); no remote subscription upgrade API.',
      poolQuota: store.pool.getQuotaStatus(),
      usageTotals: usage.totals,
    })
  })

  app.post('/accounts/:id/refresh-subscription', async (c) => {
    const id = c.req.param('id')
    const acc = store.get(id)
    if (!acc) return c.json({ error: 'Not found' }, 404)
    const result = await refreshAccountToken(acc)
    if (!result.success || !result.accessToken) {
      void signalRefreshFailed(id, result.error || 'Refresh failed')
      return c.json({ error: result.error || 'Refresh failed', refreshed: false }, 502)
    }
    await store.applyTokenRefresh(id, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    })
    store.pool.updateAccount(id, { isAvailable: true })
    await store.flush()

    let usageError: string | undefined
    let usageMeta: Record<string, unknown> | undefined
    try {
      const live = store.get(id)!
      const quota = await getUsageLimits(live)
      const detail = quotaDetailFromCredit(quota)
      await store.applyQuota(id, quota.used, quota.limit, quota.resetAt, detail)
      usageMeta = {
        used: quota.used,
        limit: quota.limit,
        resetAt: quota.resetAt ?? null,
        subscriptionTitle: quota.subscriptionTitle ?? null,
        endpoint: quota.endpoint,
        baseUsed: quota.baseUsed,
        baseLimit: quota.baseLimit,
        trialUsed: quota.trialUsed,
        trialLimit: quota.trialLimit,
        bonusUsed: quota.bonusUsed,
        bonusLimit: quota.bonusLimit,
        bonusCount: quota.bonusCount,
        resourceType: quota.resourceType ?? null,
        overageCapability: quota.overageCapability ?? null,
        upgradeCapability: quota.upgradeCapability ?? null,
        overageStatus: quota.overageStatus ?? null,
        userId: quota.userId ?? null,
        userEmail: quota.userEmail ?? null,
        detail,
      }
    } catch (err) {
      usageError =
        err instanceof UsageLimitsError
          ? err.message + (err.body ? `: ${err.body.slice(0, 180)}` : '')
          : err instanceof Error
            ? err.message
            : String(err)
    }

    const updated = store.get(id)!
    const row = buildSubscriptionSummary([updated]).rows[0]
    const usage = await store.getUsage()
    return c.json({
      ok: true,
      refreshed: true,
      usageFetched: !usageError,
      usageError: usageError || null,
      usage: usageMeta || null,
      account: withExit(updated),
      subscription: { ...row, persistedUsage: usageByAccount(usage)[id] || null },
    })
  })

  // --- Webhooks ---

  app.get('/webhooks', (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    return c.json({
      webhooks: webhooks.list(),
      events: WEBHOOK_EVENTS,
      channels: ['dingtalk', 'telegram', 'discord', 'slack', 'generic'],
      exitFailThreshold: webhooks.getExitFailThreshold(),
    })
  })

  app.post('/webhooks', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    try {
      const body = (await c.req.json()) as {
        label?: string
        channel?: WebhookChannel
        url?: string
        enabled?: boolean
        events?: WebhookEvent[]
        secret?: string
        telegramChatId?: string
        maxRetries?: number
      }
      if (!body.url || !body.channel) {
        return c.json({ error: 'channel and url are required' }, 400)
      }
      const created = await webhooks.create({
        label: body.label || '',
        channel: body.channel,
        url: body.url,
        enabled: body.enabled,
        events: body.events,
        secret: body.secret,
        telegramChatId: body.telegramChatId,
        maxRetries: body.maxRetries,
      })
      return c.json(created, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.patch('/webhooks/:id', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    try {
      const updated = await webhooks.update(c.req.param('id'), await c.req.json())
      return c.json(updated)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/webhooks/:id/enable', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    try {
      return c.json(await webhooks.setEnabled(c.req.param('id'), true))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.post('/webhooks/:id/disable', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    try {
      return c.json(await webhooks.setEnabled(c.req.param('id'), false))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404)
    }
  })

  app.delete('/webhooks/:id', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    const ok = await webhooks.remove(c.req.param('id'))
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  app.post('/webhooks/:id/test', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    const hook = webhooks.get(c.req.param('id'))
    if (!hook) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { event?: WebhookEvent }
    const event = (body.event && WEBHOOK_EVENTS.includes(body.event) ? body.event : 'diagnose_failed') as WebhookEvent
    const result = await sendWebhookWithRetry(hook, {
      event,
      title: 'kiro-acc webhook test',
      text: `Test notification from kiro-acc admin (${event})`,
      ts: Date.now(),
      data: { test: true },
    })
    await webhooks.recordDelivery(hook.id, result.ok, result.error)
    return c.json(result, result.ok ? 200 : 502)
  })

  app.patch('/webhooks-settings', async (c) => {
    if (!webhooks) return c.json({ error: 'webhooks store not initialized' }, 500)
    const body = (await c.req.json().catch(() => ({}))) as { exitFailThreshold?: number }
    if (body.exitFailThreshold != null) {
      await webhooks.setExitFailThreshold(Number(body.exitFailThreshold))
    }
    return c.json({ exitFailThreshold: webhooks.getExitFailThreshold() })
  })

  // --- Diagnose ---

  app.post('/diagnose', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        accountId?: string
        doRefresh?: boolean
        doTls?: boolean
        compareDirect?: boolean
      }
      const accountId = body.accountId?.trim()
      if (!accountId) return c.json({ error: 'accountId is required' }, 400)
      const refreshBefore =
        store.getPersistedConfig().tokenRefreshBeforeExpirySec ?? config.tokenRefreshBeforeExpirySec
      const report = await diagnoseAccount(accountId, {
        accounts: store,
        exits: exitsStore,
        doRefresh: body.doRefresh !== false,
        doTls: body.doTls !== false,
        compareDirect: body.compareDirect !== false,
        refreshBeforeSec: refreshBefore,
      })
      if (!report.ok) {
        void signalDiagnoseFailed(accountId, report.token.refreshError || report.exit.error || report.tlsError || 'diagnose failed')
        if (report.exit.exitId && exitsStore && !report.exit.ok) {
          try {
            await exitsStore.recordExitFailure(report.exit.exitId)
          } catch {
            /* ignore */
          }
        }
      } else if (report.exit.exitId && exitsStore) {
        try {
          await exitsStore.resetExitFailures(report.exit.exitId)
        } catch {
          /* ignore */
        }
      }
      return c.json(report, report.ok ? 200 : 200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 400)
    }
  })


  // --- Dashboard / config sync / settings (P2) ---

  app.get('/dashboard', async (c) => {
    const accounts = store.list()
    const enabled = accounts.filter((a) => a.enabled !== false).length
    const disabled = accounts.length - enabled
    const suspended = accounts.filter((a) => a.suspended).length
    const quota = store.pool.getQuotaStatus()
    const pools = poolsStore?.list() || []
    const exits = exitsStore?.get().exits || []
    const now = Date.now()
    const exitActive = exits.filter((e) => !e.disabled).length
    const exitCooldown = exits.filter(
      (e) => !e.disabled && e.cooldownUntil && e.cooldownUntil > now,
    ).length
    const exitDisabled = exits.filter((e) => e.disabled).length
    const totalBan = exits.reduce((s, e) => s + (e.banCount || 0), 0)
    const usage = await store.getUsage()
    const recent = (usage.records || []).slice(-12).reverse()
    return c.json({
      accounts: {
        total: accounts.length,
        enabled,
        disabled,
        suspended,
        available: store.pool.availableCount,
        quota,
      },
      pools: {
        total: pools.length,
        disabled: pools.filter((p) => p.disabled).length,
        boundAccounts: accounts.filter((a) => a.outboundPoolId).length,
      },
      exits: {
        total: exits.length,
        active: exitActive,
        disabled: exitDisabled,
        cooldown: exitCooldown,
        totalBan,
      },
      usage: {
        totals: usage.totals,
        recent,
      },
      requestLog: { size: globalRequestLog.size, capacity: globalRequestLog.capacity },
      health: {
        strategy: store.pool.getStrategy(),
        uptime: process.uptime(),
      },
      shortcuts: [
        { tab: 'accounts', label: '账户管理' },
        { tab: 'pools', label: '代理池' },
        { tab: 'api', label: 'API 反代' },
        { tab: 'subs', label: '订阅用量' },
        { tab: 'webhooks', label: 'Webhook' },
        { tab: 'diagnose', label: '诊断' },
        { tab: 'settings', label: '设置 / 关于' },
      ],
    })
  })

  app.get('/config-sync/export', (c) => {
    const bundle = buildConfigSyncBundle({
      poolConfig: store.getPersistedConfig(),
      pools: poolsStore?.list() || [],
      modelMap: modelMap?.get() || {},
      webhooks: webhooks?.list() || [],
      exitFailThreshold: webhooks?.getExitFailThreshold() ?? 3,
      apiKeys: (apiKeys?.listPublic() || []).map((k) => ({
        id: k.id,
        label: k.label,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
        active: k.active,
      })),
      opsSettings: opsSettings?.get() || { requestLogCapacity: globalRequestLog.capacity, uiPrefs: {} },
    })
    const warnings = assertNoSecretsInBundle(bundle)
    return c.json({ bundle, warnings })
  })

  app.post('/config-sync/import', async (c) => {
    const body = await c.req.json().catch(() => null)
    const raw = body && typeof body === 'object' && 'bundle' in (body as object)
      ? (body as { bundle: unknown; confirm?: boolean }).bundle
      : body
    const confirm = Boolean(
      body && typeof body === 'object' && (body as { confirm?: boolean }).confirm,
    )
    if (!confirm) {
      return c.json({ error: 'confirm:true is required to import (merge)' }, 400)
    }
    const parsed = parseConfigSyncBundle(raw)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const bundle = parsed.bundle
    const result: Record<string, unknown> = { merged: true }

    if (bundle.poolConfig) {
      result.poolConfig = await store.patchConfig(bundle.poolConfig)
    }
    if (bundle.pools && poolsStore) {
      const pools = await poolsStore.upsertMany(bundle.pools)
      result.pools = pools.length
    }
    if (bundle.modelMap && modelMap) {
      result.modelMap = await modelMap.set(bundle.modelMap)
    }
    if (bundle.exitFailThreshold != null && webhooks) {
      result.exitFailThreshold = await webhooks.setExitFailThreshold(bundle.exitFailThreshold)
    }
    if (bundle.webhooks && webhooks) {
      let created = 0
      let updated = 0
      for (const w of bundle.webhooks) {
        const existing = w.id ? webhooks.get(w.id) : undefined
        if (existing) {
          await webhooks.update(existing.id, {
            label: w.label,
            channel: w.channel,
            url: w.url,
            enabled: w.enabled,
            events: w.events,
            telegramChatId: w.telegramChatId,
            maxRetries: w.maxRetries,
            // keep existing secret when redacted / omitted
          })
          updated++
        } else {
          await webhooks.create({
            label: w.label,
            channel: w.channel,
            url: w.url,
            enabled: w.enabled,
            events: w.events,
            telegramChatId: w.telegramChatId,
            maxRetries: w.maxRetries,
          })
          created++
        }
      }
      result.webhooks = { created, updated }
    }
    if (bundle.opsSettings && opsSettings) {
      const next = await opsSettings.patch(bundle.opsSettings)
      if (next.requestLogCapacity) globalRequestLog.setCapacity(next.requestLogCapacity)
      result.opsSettings = next
    }
    result.note = 'API keys metadata is export-only and was not imported. Account tokens and exit passwords are never part of this bundle.'
    return c.json(result)
  })

  app.get('/settings', (c) => {
    return c.json({
      poolConfig: store.getPersistedConfig(),
      opsSettings: opsSettings?.get() || {
        requestLogCapacity: globalRequestLog.capacity,
        uiPrefs: {},
      },
      exitFailThreshold: webhooks?.getExitFailThreshold() ?? 3,
      requestLog: { size: globalRequestLog.size, capacity: globalRequestLog.capacity },
      about: aboutInfo(),
      health: {
        status: 'ok',
        accounts: store.pool.size,
        available: store.pool.availableCount,
        strategy: store.pool.getStrategy(),
        exits: exitsStore?.listIds().length ?? 0,
        pools: poolsStore?.list().length ?? 0,
        uptime: process.uptime(),
      },
      envHints: {
        host: config.host,
        port: config.port,
        dataDir: config.dataDir,
        apiKeyConfigured: Boolean(config.apiKey),
        adminTokenConfigured: Boolean(config.adminToken),
      },
    })
  })

  app.patch('/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      poolConfig?: PersistedConfig
      opsSettings?: { requestLogCapacity?: number; uiPrefs?: { defaultTab?: string } }
      exitFailThreshold?: number
    }
    const out: Record<string, unknown> = {}
    if (body.poolConfig) {
      out.poolConfig = await store.patchConfig(body.poolConfig)
    }
    if (body.opsSettings && opsSettings) {
      const next = await opsSettings.patch(body.opsSettings)
      if (next.requestLogCapacity) globalRequestLog.setCapacity(next.requestLogCapacity)
      out.opsSettings = next
    } else if (body.opsSettings?.requestLogCapacity != null) {
      out.requestLogCapacity = globalRequestLog.setCapacity(body.opsSettings.requestLogCapacity)
    }
    if (body.exitFailThreshold != null && webhooks) {
      out.exitFailThreshold = await webhooks.setExitFailThreshold(body.exitFailThreshold)
    }
    out.requestLog = { size: globalRequestLog.size, capacity: globalRequestLog.capacity }
    return c.json(out)
  })

  app.get('/about', (c) =>
    c.json({
      ...aboutInfo(),
      health: {
        status: 'ok',
        accounts: store.pool.size,
        available: store.pool.availableCount,
        strategy: store.pool.getStrategy(),
        exits: exitsStore?.listIds().length ?? 0,
        pools: poolsStore?.list().length ?? 0,
        uptime: process.uptime(),
      },
    }),
  )


  // --- In-admin chat test (pin account, no proxy API key) ---

  app.get('/chat-models', (c) => {
    const custom = modelMap?.get() || {}
    const models = PUBLIC_MODELS.map((m) => m.id)
    const customAliases = Object.keys(custom)
    const all = [...models]
    for (const a of customAliases) {
      if (a && !all.includes(a)) all.push(a)
    }
    return c.json({
      models,
      customAliases,
      all,
    })
  })

  app.post('/chat-test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      accountId?: string
      model?: string
      message?: string
    }
    const accountId = (body.accountId || '').trim()
    const model = (body.model || '').trim() || 'claude-haiku-4.5'
    const message = (body.message || '').trim()
    if (!accountId) return c.json({ ok: false, error: 'accountId is required' }, 400)
    if (!message) return c.json({ ok: false, error: 'message is required' }, 400)

    let account = store.get(accountId)
    if (!account) return c.json({ ok: false, error: 'account not found', accountId }, 404)

    const refreshBefore =
      store.getPersistedConfig().tokenRefreshBeforeExpirySec ?? config.tokenRefreshBeforeExpirySec
    const preferred =
      store.getPersistedConfig().preferredEndpoint ?? config.preferredEndpoint

    if (isTokenExpiringSoon(account, refreshBefore) && account.refreshToken) {
      const result = await refreshAccountToken(account)
      if (result.success && result.accessToken) {
        await store.applyTokenRefresh(account.id, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        })
        account = store.get(accountId)!
      } else {
        return c.json(
          {
            ok: false,
            accountId,
            model,
            error: result.error || 'Token refresh failed',
            latencyMs: 0,
          },
          400,
        )
      }
    }

    if (!account.accessToken) {
      return c.json(
        { ok: false, accountId, model, error: 'account has no accessToken', latencyMs: 0 },
        400,
      )
    }

    // Ensure stable Machine ID is persisted before upstream call
    await store.ensureMachineId(account.id)
    account = store.get(accountId)!

    const requestModel = model
    const mappedModel = mapModelId(model)
    // CodeWhisperer may rewrite to SCREAMING_SNAKE; Amazon Q keeps mapped id.
    const upstreamModelId =
      preferred === 'amazonq' ? mappedModel : toCodeWhispererModelId(mappedModel)

    const profileArn = resolveProfileArn(account)
    const payload = openaiToKiro(
      {
        model,
        messages: [{ role: 'user', content: message }],
      },
      profileArn,
    )
    const started = Date.now()
    try {
      const result = await callKiroApi(account, payload, {
        preferredEndpoint: preferred,
        signal: c.req.raw.signal,
      })
      const latencyMs = Date.now() - started
      const responseModelId = result.usage.modelId || undefined
      const resolvedModel = responseModelId || mappedModel
      store.pool.recordSuccess(
        account.id,
        result.usage.inputTokens + result.usage.outputTokens,
        result.usage.inputTokens,
        result.usage.outputTokens,
        latencyMs,
      )
      await recordProxyUsage(
        store,
        {
          timestamp: Date.now(),
          accountId: account.id,
          model: resolvedModel,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          success: true,
          responseTimeMs: latencyMs,
        },
        { path: '/admin/chat-test', apiStyle: 'openai', status: 200 },
      )
      // Best-effort: refresh CREDIT quota after a successful smoke chat
      let quotaSnap: Record<string, unknown> | undefined
      try {
        const q = await getUsageLimits(store.get(account.id) || account)
        const detail = quotaDetailFromCredit(q)
        await store.applyQuota(account.id, q.used, q.limit, q.resetAt, detail)
        quotaSnap = {
          used: q.used,
          limit: q.limit,
          resetAt: q.resetAt,
          subscriptionTitle: q.subscriptionTitle,
          detail,
        }
      } catch {
        /* ignore — chat succeeded */
      }
      return c.json({
        ok: true,
        accountId: account.id,
        /** @deprecated prefer requestModel / mappedModel / upstreamModelId / responseModelId */
        model: resolvedModel,
        requestModel,
        mappedModel,
        upstreamModelId,
        responseModelId: responseModelId || null,
        machineId: account.machineId || account.deviceId || null,
        text: result.content || '',
        latencyMs,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          credits: result.usage.credits,
          modelId: responseModelId || null,
        },
        quota: quotaSnap || null,
      })
    } catch (err) {
      const latencyMs = Date.now() - started
      const msg = err instanceof Error ? err.message : String(err)
      const status = err instanceof KiroApiError ? err.statusCode : 502
      await recordProxyUsage(
        store,
        {
          timestamp: Date.now(),
          accountId: account.id,
          model: mapModelId(model),
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: msg,
          responseTimeMs: latencyMs,
        },
        {
          path: '/admin/chat-test',
          apiStyle: 'openai',
          status: status >= 400 && status < 600 ? status : 502,
        },
      )
      return c.json(
        {
          ok: false,
          accountId: account.id,
          model: mappedModel,
          requestModel,
          mappedModel,
          upstreamModelId,
          responseModelId: null,
          machineId: account.machineId || account.deviceId || null,
          text: '',
          latencyMs,
          error: msg,
        },
        200,
      )
    }
  })

  return app
}
