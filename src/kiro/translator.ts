/**
 * OpenAI ↔ Kiro payload translation.
 * Algorithms adapted from chaogei/Kiro-account-manager translator (AGPL-3.0).
 */
import { randomUUID } from 'node:crypto'

// ---- OpenAI types (subset) ----

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  tools?: Array<{
    type: 'function'
    function: { name: string; description?: string; parameters?: unknown }
  }>
  tool_choice?: unknown
  conversation_id?: string
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ---- Kiro types (subset) ----

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface KiroToolResult {
  content: { text: string }[]
  status: 'success' | 'error'
  toolUseId: string
}

export type KiroToolWrapper = {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: unknown }
  }
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroUserInputMessage {
  content: string
  modelId?: string
  origin: string
  images?: KiroImage[]
  userInputMessageContext?: {
    toolResults?: KiroToolResult[]
    tools?: KiroToolWrapper[]
  }
}

export interface KiroHistoryMessage {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: {
    content: string
    toolUses?: KiroToolUse[]
  }
}

export interface KiroPayload {
  conversationState: {
    agentContinuationId?: string
    agentTaskType?: string
    chatTriggerType: 'MANUAL'
    conversationId: string
    currentMessage: { userInputMessage: KiroUserInputMessage }
    history?: KiroHistoryMessage[]
  }
  profileArn?: string
  inferenceConfig?: {
    maxTokens?: number
    temperature?: number
    topP?: number
  }
}

export interface KiroUsage {
  inputTokens: number
  outputTokens: number
  credits: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Runtime overrides from data/model-map.json (OpenAI name → upstream). */
let customModelMap: Record<string, string> = {}

export function setCustomModelMap(map: Record<string, string>): void {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(map || {})) {
    const key = String(k).trim().toLowerCase()
    const val = String(v).trim()
    if (key && val) next[key] = val
  }
  customModelMap = next
}

export function getCustomModelMap(): Record<string, string> {
  return { ...customModelMap }
}

const MODEL_ID_MAP: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4.5': 'claude-sonnet-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4.5': 'claude-haiku-4.5',
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4.5': 'claude-opus-4.5',
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-sonnet-4-20250514': 'claude-sonnet-4',
  'claude-3-5-sonnet': 'claude-sonnet-4.5',
  'claude-3-opus': 'claude-sonnet-4.5',
  'claude-3-sonnet': 'claude-sonnet-4',
  'claude-3-haiku': 'claude-haiku-4.5',
  'gpt-4': 'claude-sonnet-4.5',
  'gpt-4o': 'claude-sonnet-4.5',
  'gpt-4-turbo': 'claude-sonnet-4.5',
  'gpt-3.5-turbo': 'claude-sonnet-4.5',
  default: 'claude-sonnet-4.5',
}

const CODEWHISPERER_DEFAULT = 'CLAUDE_SONNET_4_20250514_V1_0'

function normalizeClaudeVersion(modelId: string): string {
  return modelId.replace(
    /^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/i,
    '$1-$2.$3',
  )
}

export function mapModelId(model: string): string {
  let modelId = model.trim()
  if (!modelId) return MODEL_ID_MAP.default!
  if (/^[A-Z0-9_]+$/.test(modelId) && modelId.includes('CLAUDE')) return modelId
  modelId = normalizeClaudeVersion(modelId)
  const lower = modelId.toLowerCase()
  if (customModelMap[lower]) return customModelMap[lower]!
  if (MODEL_ID_MAP[lower]) return MODEL_ID_MAP[lower]!
  if (/^claude-(sonnet|haiku|opus)-/.test(lower)) return modelId
  return MODEL_ID_MAP.default!
}

export function toCodeWhispererModelId(modelId: string): string {
  if (/^[A-Z0-9_]+$/.test(modelId) && modelId.includes('CLAUDE')) return modelId
  const map: Record<string, string> = {
    'claude-sonnet-4.5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
    'claude-haiku-4.5': 'CLAUDE_HAIKU_4_5_20251001_V1_0',
    'claude-opus-4.5': 'CLAUDE_OPUS_4_5_20251101_V1_0',
    'claude-sonnet-4': 'CLAUDE_SONNET_4_20250514_V1_0',
  }
  return map[modelId] || CODEWHISPERER_DEFAULT
}

export const PUBLIC_MODELS = [
  { id: 'claude-sonnet-4.5', object: 'model', owned_by: 'kiro' },
  { id: 'claude-sonnet-4', object: 'model', owned_by: 'kiro' },
  { id: 'claude-haiku-4.5', object: 'model', owned_by: 'kiro' },
  { id: 'claude-opus-4.5', object: 'model', owned_by: 'kiro' },
  { id: 'gpt-4o', object: 'model', owned_by: 'kiro' },
]

function extractText(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('')
}

function extractImages(content: OpenAIMessage['content']): KiroImage[] {
  if (!Array.isArray(content)) return []
  const images: KiroImage[] = []
  for (const part of content) {
    if (part.type === 'image_url' && part.image_url?.url) {
      const m = part.image_url.url.match(/^data:image\/(\w+);base64,(.+)$/)
      if (m) {
        images.push({ format: m[1] === 'jpg' ? 'jpeg' : m[1]!, source: { bytes: m[2]! } })
      }
    }
  }
  return images
}

function convertTools(
  tools: OpenAIChatRequest['tools'],
): KiroToolWrapper[] {
  if (!tools?.length) return []
  return tools.map((t) => ({
    toolSpecification: {
      name: t.function.name.slice(0, 64),
      description: t.function.description || t.function.name,
      inputSchema: { json: t.function.parameters ?? { type: 'object', properties: {} } },
    },
  }))
}

export function openaiToKiro(request: OpenAIChatRequest, profileArn?: string): KiroPayload {
  const modelId = mapModelId(request.model)
  const origin = 'AI_EDITOR'

  let systemPrompt = ''
  const nonSystem: OpenAIMessage[] = []
  for (const msg of request.messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + extractText(msg.content)
    } else {
      nonSystem.push(msg)
    }
  }

  if (systemPrompt) {
    systemPrompt = `[Context: Current time is ${new Date().toISOString()}]\n\n${systemPrompt}`
  }

  const history: KiroHistoryMessage[] = []
  const pendingToolResults: KiroToolResult[] = []
  let currentContent = ''
  const images: KiroImage[] = []

  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i]!
    const isLast = i === nonSystem.length - 1

    if (msg.role === 'user') {
      const text = extractText(msg.content) || 'Continue'
      const imgs = extractImages(msg.content)
      if (isLast) {
        currentContent = text
        images.push(...imgs)
      } else {
        history.push({
          userInputMessage: {
            content: text,
            modelId,
            origin,
            images: imgs.length ? imgs : undefined,
          },
        })
      }
    } else if (msg.role === 'assistant') {
      let content = typeof msg.content === 'string' ? msg.content : extractText(msg.content)
      if (!content.trim() && msg.tool_calls?.length) content = ' '
      else if (!content.trim()) content = 'I understand.'

      const toolUses: KiroToolUse[] = []
      for (const tc of msg.tool_calls || []) {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          /* ignore */
        }
        toolUses.push({ toolUseId: tc.id, name: tc.function.name, input })
      }
      history.push({
        assistantResponseMessage: {
          content,
          toolUses: toolUses.length ? toolUses : undefined,
        },
      })
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      pendingToolResults.push({
        toolUseId: msg.tool_call_id,
        content: [{ text: extractText(msg.content) || '(no output)' }],
        status: 'success',
      })
      const next = nonSystem[i + 1]
      if ((!next || next.role !== 'tool') && !isLast && pendingToolResults.length) {
        history.push({
          userInputMessage: {
            content: 'Tool results provided.',
            modelId,
            origin,
            userInputMessageContext: { toolResults: [...pendingToolResults] },
          },
        })
        pendingToolResults.length = 0
      }
    }
  }

  if (history.length > 0 && history[history.length - 1]?.assistantResponseMessage && !currentContent) {
    currentContent = 'Continue.'
  }
  if (!currentContent && pendingToolResults.length) {
    currentContent = 'Tool results provided.'
  }

  if (systemPrompt) {
    history.unshift(
      {
        userInputMessage: {
          content: systemPrompt,
          origin,
          userInputMessageContext: {},
        },
      },
      { assistantResponseMessage: { content: 'I will follow these instructions.' } },
    )
  }

  const kiroTools = convertTools(request.tools)
  const finalContent = currentContent || 'Continue.'

  const currentUserInputMessage: KiroUserInputMessage = {
    content: finalContent,
    modelId,
    origin,
  }
  if (images.length) currentUserInputMessage.images = images
  if (kiroTools.length || pendingToolResults.length) {
    currentUserInputMessage.userInputMessageContext = {
      ...(kiroTools.length ? { tools: kiroTools } : {}),
      ...(pendingToolResults.length ? { toolResults: pendingToolResults } : {}),
    }
  }

  const payload: KiroPayload = {
    conversationState: {
      agentContinuationId: randomUUID(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      conversationId: request.conversation_id || randomUUID(),
      currentMessage: { userInputMessage: currentUserInputMessage },
      history: history.length ? history : undefined,
    },
  }

  if (profileArn) payload.profileArn = profileArn

  if (
    request.max_tokens ||
    request.temperature !== undefined ||
    request.top_p !== undefined
  ) {
    payload.inferenceConfig = {}
    if (request.max_tokens) payload.inferenceConfig.maxTokens = request.max_tokens
    if (request.temperature !== undefined) payload.inferenceConfig.temperature = request.temperature
    if (request.top_p !== undefined) payload.inferenceConfig.topP = request.top_p
  }

  return payload
}

export function kiroToOpenaiResponse(
  content: string,
  toolUses: KiroToolUse[],
  usage: KiroUsage,
  model: string,
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolUses.length > 0 || !content?.trim() ? null : content,
          tool_calls: toolUses.length
            ? toolUses.map((tu) => ({
                id: tu.toolUseId,
                type: 'function' as const,
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              }))
            : undefined,
        },
        finish_reason: toolUses.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  }
}

export function createOpenaiStreamChunk(
  id: string,
  model: string,
  delta: {
    role?: 'assistant'
    content?: string
    tool_calls?: Array<{
      index: number
      id?: string
      type?: 'function'
      function?: { name?: string; arguments?: string }
    }>
  },
  finishReason: 'stop' | 'tool_calls' | null = null,
  usage?: OpenAIChatResponse['usage'],
): OpenAIStreamChunk {
  const chunk: OpenAIStreamChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (usage) chunk.usage = usage
  return chunk
}
