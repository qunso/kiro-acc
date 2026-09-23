import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'
import {
  WEBHOOK_EVENTS,
  type WebhookChannel,
  type WebhookEvent,
  type WebhookRecord,
  type WebhooksFile,
} from './types.js'

const CHANNELS: WebhookChannel[] = ['dingtalk', 'telegram', 'discord', 'slack', 'generic']

function normalizeEvents(events: unknown): WebhookEvent[] {
  if (!Array.isArray(events)) return [...WEBHOOK_EVENTS]
  const set = new Set(
    events
      .map((e) => String(e))
      .filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as string[]).includes(e)),
  )
  return [...set]
}

function normalize(rec: Partial<WebhookRecord> & { url?: string; channel?: string }): WebhookRecord {
  const channel = (CHANNELS.includes(rec.channel as WebhookChannel)
    ? rec.channel
    : 'generic') as WebhookChannel
  const url = String(rec.url || '').trim()
  if (!url) throw new Error('url is required')
  const now = Date.now()
  return {
    id: rec.id || randomUUID(),
    label: (rec.label || '').trim() || `${channel}-${String(now).slice(-4)}`,
    channel,
    url,
    enabled: rec.enabled !== false,
    events: normalizeEvents(rec.events),
    secret: rec.secret?.trim() || undefined,
    telegramChatId: rec.telegramChatId?.trim() || undefined,
    maxRetries:
      rec.maxRetries != null && Number.isFinite(Number(rec.maxRetries))
        ? Math.max(1, Math.min(5, Number(rec.maxRetries)))
        : 3,
    createdAt: rec.createdAt ?? now,
    updatedAt: rec.updatedAt,
    lastSuccessAt: rec.lastSuccessAt,
    lastErrorAt: rec.lastErrorAt,
    lastError: rec.lastError,
  }
}

export class WebhookStore {
  private file: JsonStore<WebhooksFile>
  private data: WebhooksFile = { webhooks: [], exitFailThreshold: 3 }

  constructor(dataDir: string) {
    this.file = new JsonStore(path.join(dataDir, 'webhooks.json'), {
      webhooks: [],
      exitFailThreshold: 3,
    })
  }

  async init(): Promise<void> {
    const raw = await this.file.read()
    this.data = {
      webhooks: Array.isArray(raw.webhooks) ? raw.webhooks.map((w) => normalize(w)) : [],
      exitFailThreshold:
        raw.exitFailThreshold != null && Number.isFinite(Number(raw.exitFailThreshold))
          ? Math.max(1, Number(raw.exitFailThreshold))
          : 3,
    }
  }

  private async persist(): Promise<void> {
    await this.file.write(this.data)
  }

  list(): WebhookRecord[] {
    return this.data.webhooks.map((w) => ({ ...w }))
  }

  get(id: string): WebhookRecord | undefined {
    const w = this.data.webhooks.find((x) => x.id === id)
    return w ? { ...w } : undefined
  }

  getExitFailThreshold(): number {
    return this.data.exitFailThreshold ?? 3
  }

  async setExitFailThreshold(n: number): Promise<number> {
    this.data.exitFailThreshold = Math.max(1, Math.min(20, Math.floor(n)))
    await this.persist()
    return this.data.exitFailThreshold
  }

  async create(input: Partial<WebhookRecord> & { url: string; channel: WebhookChannel }): Promise<WebhookRecord> {
    const rec = normalize({ ...input, id: undefined, createdAt: Date.now() })
    this.data.webhooks.push(rec)
    await this.persist()
    return { ...rec }
  }

  async update(id: string, patch: Partial<WebhookRecord>): Promise<WebhookRecord> {
    const idx = this.data.webhooks.findIndex((w) => w.id === id)
    if (idx < 0) throw new Error(`Webhook not found: ${id}`)
    const merged = normalize({
      ...this.data.webhooks[idx],
      ...patch,
      id,
      createdAt: this.data.webhooks[idx]!.createdAt,
      updatedAt: Date.now(),
    })
    this.data.webhooks[idx] = merged
    await this.persist()
    return { ...merged }
  }

  async setEnabled(id: string, enabled: boolean): Promise<WebhookRecord> {
    return this.update(id, { enabled })
  }

  async remove(id: string): Promise<boolean> {
    const before = this.data.webhooks.length
    this.data.webhooks = this.data.webhooks.filter((w) => w.id !== id)
    if (this.data.webhooks.length === before) return false
    await this.persist()
    return true
  }

  async recordDelivery(id: string, ok: boolean, error?: string): Promise<void> {
    const w = this.data.webhooks.find((x) => x.id === id)
    if (!w) return
    if (ok) {
      w.lastSuccessAt = Date.now()
      w.lastError = undefined
    } else {
      w.lastErrorAt = Date.now()
      w.lastError = (error || 'send failed').slice(0, 400)
    }
    await this.persist()
  }

  matching(event: WebhookEvent): WebhookRecord[] {
    return this.data.webhooks.filter((w) => w.enabled && w.events.includes(event))
  }
}
