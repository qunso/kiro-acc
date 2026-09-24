import type { Context, Next } from 'hono'
import type { AppConfig } from '../config.js'
import type { ApiKeyStore, ResolvedApiKey } from '../apiKeys/store.js'
import { ENV_API_KEY_ID, ENV_API_KEY_LABEL } from '../apiKeys/store.js'

function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || null
}

export type ApiKeyValidator = {
  isValidKey(key: string): boolean
  resolveKey?(key: string): ResolvedApiKey | null
}

export function apiKeyAuth(config: AppConfig, keys?: ApiKeyStore | ApiKeyValidator) {
  return async (c: Context, next: Next) => {
    // /health is public
    if (c.req.path === '/health') return next()

    const key =
      extractBearer(c.req.header('authorization')) ||
      c.req.header('x-api-key') ||
      ''

    const ok = keys
      ? keys.isValidKey(key)
      : Boolean(config.apiKey && key === config.apiKey)

    if (!ok) {
      return c.json(
        {
          error: {
            message: 'Invalid or missing API key',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        },
        401,
      )
    }

    // Attach resolved key identity for usage / request-log attribution.
    let resolved: ResolvedApiKey | null = null
    if (keys && typeof keys.resolveKey === 'function') {
      resolved = keys.resolveKey(key)
    } else if (config.apiKey && key === config.apiKey) {
      resolved = { id: ENV_API_KEY_ID, label: ENV_API_KEY_LABEL, source: 'env' }
    }
    if (resolved) {
      c.set('apiKeyId', resolved.id)
      c.set('apiKeyLabel', resolved.label)
    }

    await next()
  }
}

export function adminAuth(config: AppConfig) {
  return async (c: Context, next: Next) => {
    const token =
      c.req.header('x-admin-token') ||
      extractBearer(c.req.header('authorization')) ||
      ''

    if (!config.adminToken || token !== config.adminToken) {
      return c.json({ error: 'Unauthorized: invalid admin token' }, 401)
    }
    await next()
  }
}

/** Read API key attribution set by apiKeyAuth (safe if middleware skipped). */
export function apiKeyFromContext(c: Context): { apiKeyId?: string; apiKeyLabel?: string } {
  const apiKeyId = c.get('apiKeyId') as string | undefined
  const apiKeyLabel = c.get('apiKeyLabel') as string | undefined
  return {
    ...(apiKeyId ? { apiKeyId } : {}),
    ...(apiKeyLabel ? { apiKeyLabel } : {}),
  }
}
