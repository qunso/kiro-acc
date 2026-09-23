export type WebhookChannel = 'dingtalk' | 'telegram' | 'discord' | 'slack' | 'generic'

export type WebhookEvent =
  | 'account_suspended'
  | 'all_quota_exhausted'
  | 'refresh_failed'
  | 'exit_consecutive_failures'
  | 'diagnose_failed'

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'account_suspended',
  'all_quota_exhausted',
  'refresh_failed',
  'exit_consecutive_failures',
  'diagnose_failed',
]

export interface WebhookRecord {
  id: string
  label: string
  channel: WebhookChannel
  /** Destination URL (DingTalk/Discord/Slack/generic webhook, or Telegram bot API sendMessage URL base). */
  url: string
  enabled: boolean
  events: WebhookEvent[]
  /** DingTalk secret for HMAC sign (optional). */
  secret?: string
  /** Telegram chat_id when channel=telegram (url may be https://api.telegram.org/bot<token>). */
  telegramChatId?: string
  /** Max send attempts including the first try. Default 3. */
  maxRetries?: number
  createdAt: number
  updatedAt?: number
  lastSuccessAt?: number
  lastErrorAt?: number
  lastError?: string
}

export interface WebhooksFile {
  webhooks: WebhookRecord[]
  /** Exit consecutive failure threshold before firing exit_consecutive_failures. */
  exitFailThreshold?: number
}

export interface WebhookPayload {
  event: WebhookEvent
  title: string
  text: string
  ts: number
  data?: Record<string, unknown>
}
