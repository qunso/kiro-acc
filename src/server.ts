import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AccountStore } from './accounts/store.js'
import type { AppConfig } from './config.js'
import { createAdminRoutes } from './admin/routes.js'
import { apiKeyAuth } from './middleware/auth.js'
import { chatCompletionsHandler, listModelsHandler } from './proxy/openaiHandler.js'

export function createServer(store: AccountStore, config: AppConfig): Hono {
  const app = new Hono()

  app.use('*', cors())
  app.use('*', logger())

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      accounts: store.pool.size,
      available: store.pool.availableCount,
      strategy: store.pool.getStrategy(),
      uptime: process.uptime(),
    }),
  )

  // Public OpenAI-compatible API
  const v1 = new Hono()
  v1.use('*', apiKeyAuth(config))
  v1.get('/models', listModelsHandler())
  v1.post('/chat/completions', chatCompletionsHandler(store, config))
  app.route('/v1', v1)

  // Also protect top-level duplicate if clients omit /v1 — not required

  // Admin API
  app.route('/admin', createAdminRoutes(store, config))

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
