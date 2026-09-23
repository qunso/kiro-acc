import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AccountStore } from './accounts/store.js'
import type { AppConfig } from './config.js'
import type { ExitsStore } from './exits/store.js'
import type { PoolsStore } from './pools/store.js'
import { createAdminRoutes } from './admin/routes.js'
import { loadAdminUiHtml } from './admin/uiHtml.js'
import { apiKeyAuth } from './middleware/auth.js'
import { chatCompletionsHandler, listModelsHandler } from './proxy/openaiHandler.js'
import { countTokensHandler, messagesHandler } from './proxy/messagesHandler.js'

export function createServer(
  store: AccountStore,
  config: AppConfig,
  exits?: ExitsStore,
  pools?: PoolsStore,
): Hono {
  const app = new Hono()

  app.use('*', cors())
  app.use('*', logger())

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      accounts: store.pool.size,
      available: store.pool.availableCount,
      strategy: store.pool.getStrategy(),
      exits: exits?.listIds().length ?? 0,
      pools: pools?.list().length ?? 0,
      uptime: process.uptime(),
    }),
  )

  const v1 = new Hono()
  v1.use('*', apiKeyAuth(config))
  v1.get('/models', listModelsHandler())
  v1.post('/chat/completions', chatCompletionsHandler(store, config, { exits, pools }))
  v1.post('/messages/count_tokens', countTokensHandler())
  v1.post('/messages', messagesHandler(store, config, { exits, pools }))
  app.route('/v1', v1)

  // Same handlers under the path the original desktop proxy also accepted.
  const anthropic = new Hono()
  anthropic.use('*', apiKeyAuth(config))
  anthropic.post('/messages/count_tokens', countTokensHandler())
  anthropic.post('/messages', messagesHandler(store, config, { exits, pools }))
  app.route('/anthropic/v1', anthropic)

  // Visual admin (token entered in-page; API still requires x-admin-token)
  app.get('/admin/ui', (c) => c.html(loadAdminUiHtml()))
  app.get('/admin/ui/', (c) => c.html(loadAdminUiHtml()))

  app.route('/admin', createAdminRoutes(store, config, exits, pools))

  app.notFound((c) =>
    c.json({ error: { message: `Not found: ${c.req.method} ${c.req.path}`, type: 'not_found' } }, 404),
  )

  app.onError((err, c) => {
    console.error('[server]', err)
    return c.json(
      { error: { message: err.message || 'Internal error', type: 'server_error' } },
      500,
    )
  })

  return app
}
