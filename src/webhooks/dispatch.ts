import { createHmac } from 'node:crypto'
import type { WebhookPayload, WebhookRecord } from './types.js'
import type { WebhookStore } from './store.js'

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init)
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function buildBody(hook: WebhookRecord, payload: WebhookPayload): { url: string; body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const text = `[${payload.event}] ${payload.title}\n${payload.text}`

  switch (hook.channel) {
    case 'dingtalk': {
      let url = hook.url
      if (hook.secret) {
        const ts = Date.now()
        const stringToSign = `${ts}\n${hook.secret}`
        const sign = createHmac('sha256', hook.secret).update(stringToSign).digest('base64')
        const sep = url.includes('?') ? '&' : '?'
        url = `${url}${sep}timestamp=${ts}&sign=${encodeURIComponent(sign)}`
      }
      return {
        url,
        headers,
        body: {
          msgtype: 'text',
          text: { content: text },
        },
      }
    }
    case 'telegram': {
      const chatId = hook.telegramChatId
      if (!chatId) throw new Error('telegramChatId is required for telegram channel')
      let url = hook.url.replace(/\/$/, '')
      if (!/\/sendMessage$/i.test(url)) url = `${url}/sendMessage`
      return {
        url,
        headers,
        body: { chat_id: chatId, text },
      }
    }
    case 'discord':
      return {
        url: hook.url,
        headers,
        body: { content: text.slice(0, 1900) },
      }
    case 'slack':
      return {
        url: hook.url,
        headers,
        body: { text },
      }
    case 'generic':
    default:
      return {
        url: hook.url,
        headers,
        body: {
          event: payload.event,
          title: payload.title,
          text: payload.text,
          ts: payload.ts,
          data: payload.data || {},
        },
      }
  }
}

export async function sendWebhookOnce(
  hook: WebhookRecord,
  payload: WebhookPayload,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const built = buildBody(hook, payload)
    const res = await fetchImpl(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.body),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${t.slice(0, 200)}` }
    }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function sendWebhookWithRetry(
  hook: WebhookRecord,
  payload: WebhookPayload,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const max = hook.maxRetries ?? 3
  let lastError: string | undefined
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await sendWebhookOnce(hook, payload, fetchImpl)
    if (result.ok) return { ok: true, attempts: attempt }
    lastError = result.error || `status ${result.status}`
    if (attempt < max) await sleep(200 * attempt)
  }
  return { ok: false, attempts: max, error: lastError }
}

/** Fire-and-forget notify to all matching enabled webhooks. */
export async function notifyWebhooks(
  store: WebhookStore | undefined,
  payload: Omit<WebhookPayload, 'ts'> & { ts?: number },
  fetchImpl?: FetchLike,
): Promise<void> {
  if (!store) return
  const full: WebhookPayload = { ...payload, ts: payload.ts ?? Date.now() }
  const hooks = store.matching(full.event)
  await Promise.all(
    hooks.map(async (hook) => {
      const result = await sendWebhookWithRetry(hook, full, fetchImpl)
      await store.recordDelivery(hook.id, result.ok, result.error).catch(() => undefined)
      if (!result.ok) {
        console.warn(`[webhook] ${hook.id} ${full.event} failed:`, result.error)
      }
    }),
  )
}

/** Shared process helper so proxy handlers can notify without circular imports. */
let globalWebhookStore: WebhookStore | undefined

export function setGlobalWebhookStore(store: WebhookStore | undefined): void {
  globalWebhookStore = store
}

export function getGlobalWebhookStore(): WebhookStore | undefined {
  return globalWebhookStore
}

export async function notifyEvent(
  payload: Omit<WebhookPayload, 'ts'> & { ts?: number },
): Promise<void> {
  await notifyWebhooks(globalWebhookStore, payload)
}
