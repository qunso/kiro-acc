/**
 * Anthropic Messages API ↔ Kiro payload translation.
 * Request shape follows the public Messages API used by the upstream
 * Kiro account manager (`POST /v1/messages`). This file does not impersonate
 * TLS or HTTP client fingerprints.
 */
import { randomUUID } from 'node:crypto'
import {
  mapModelId,
  type KiroHistoryMessage,
  type KiroImage,
  type KiroPayload,
  type KiroToolResult,
  type KiroToolUse,
  type KiroToolWrapper,
  type KiroUsage,
  type KiroUserInputMessage,
} from './translator.js'

export interface ClaudeTextBlock {
  type: 'text'
  text?: string
}

export interface ClaudeImageBlock {
  type: 'image'
  source?: { type?: string; media_type?: string; data?: string }
}

export interface ClaudeToolUseBlock {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

export interface ClaudeToolResultBlock {
  type: 'tool_result'
  tool_use_id?: string
  content?: string | Array<{ type?: string; text?: string; source?: ClaudeImageBlock['source'] }>
  is_error?: boolean
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | { type: string; text?: string; [key: string]: unknown }

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
}

export interface ClaudeTool {
  name: string
  description?: string
  input_schema?: unknown
}

export interface ClaudeMessagesRequest {
  model: string
  messages: ClaudeMessage[]
  max_tokens: number
  system?: string | Array<{ type?: string; text?: string }>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: ClaudeTool[]
  tool_choice?: { type?: string; name?: string } | string
  metadata?: { user_id?: string }
}

export interface ClaudeResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<Record<string, unknown>>
  model: string
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

const TOOL_NAME_MAX = 64
const TOOL_DESC_MAX = 4096

function extractSystem(system: ClaudeMessagesRequest['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

function normalizeImageFormat(format: string): string {
  const f = format.toLowerCase()
  if (f === 'jpg') return 'jpeg'
  return f
}

function pushImage(images: KiroImage[], source: ClaudeImageBlock['source'] | undefined): void {
  if (!source || source.type !== 'base64' || !source.data || !source.media_type) return
  const [kind, format] = source.media_type.split('/')
  if (kind !== 'image' || !format) return
  images.push({
    format: normalizeImageFormat(format),
    source: { bytes: source.data },
  })
}

interface ExtractedUser {
  content: string
  images: KiroImage[]
  toolResults: KiroToolResult[]
}

function toolResultText(
  content: ClaudeToolResultBlock['content'],
  images: KiroImage[],
): string {
  if (typeof content === 'string') return content || '(empty)'
  if (!Array.isArray(content)) return content == null ? '(no output)' : String(content)
  const texts: string[] = []
  let imageCount = 0
  for (const part of content) {
    if (part?.type === 'text' && part.text) texts.push(part.text)
    else if (part?.type === 'image') {
      const before = images.length
      pushImage(images, part.source)
      if (images.length > before) imageCount++
    }
  }
  let text = texts.join('')
  if (!text) {
    text =
      imageCount > 0
        ? `(tool returned ${imageCount} image${imageCount > 1 ? 's' : ''})`
        : '(no text output)'
  }
  return text
}

function extractClaudeUser(msg: ClaudeMessage): ExtractedUser {
  const images: KiroImage[] = []
  const toolResults: KiroToolResult[] = []
  if (typeof msg.content === 'string') {
    return { content: msg.content, images, toolResults }
  }
  let content = ''
  if (!Array.isArray(msg.content)) return { content: '', images, toolResults }
  for (const block of msg.content) {
    if (block.type === 'text' && block.text) content += block.text
    else if (block.type === 'image') pushImage(images, (block as ClaudeImageBlock).source)
    else if (block.type === 'tool_result') {
      const tr = block as ClaudeToolResultBlock
      if (!tr.tool_use_id) continue
      toolResults.push({
        toolUseId: tr.tool_use_id,
        content: [{ text: toolResultText(tr.content, images) }],
        status: tr.is_error ? 'error' : 'success',
      })
    }
  }
  return { content, images, toolResults }
}

function extractClaudeAssistant(msg: ClaudeMessage): { content: string; toolUses: KiroToolUse[] } {
  const toolUses: KiroToolUse[] = []
  if (typeof msg.content === 'string') return { content: msg.content, toolUses }
  let content = ''
  if (!Array.isArray(msg.content)) return { content: '', toolUses }
  for (const block of msg.content) {
    if (block.type === 'text' && block.text) content += block.text
    else if (block.type === 'tool_use') {
      const tu = block as ClaudeToolUseBlock
      if (!tu.id || !tu.name) continue
      const input =
        tu.input && typeof tu.input === 'object' && !Array.isArray(tu.input)
          ? (tu.input as Record<string, unknown>)
          : {}
      toolUses.push({
        toolUseId: tu.id,
        name: tu.name.slice(0, TOOL_NAME_MAX),
        input,
      })
    }
  }
  return { content, toolUses }
}

function mergeUser(a: ExtractedUser | null, b: ExtractedUser): ExtractedUser {
  if (!a) return b
  return {
    content: [a.content, b.content].filter(Boolean).join('\n'),
    images: [...a.images, ...b.images],
    toolResults: [...a.toolResults, ...b.toolResults],
  }
}

function toUserInput(
  part: ExtractedUser,
  modelId: string,
  origin: string,
): KiroUserInputMessage {
  const msg: KiroUserInputMessage = {
    content: part.content.trim() || (part.toolResults.length ? 'Tool results provided.' : 'Continue'),
    modelId,
    origin,
  }
  if (part.images.length) msg.images = part.images
  if (part.toolResults.length) {
    msg.userInputMessageContext = { toolResults: part.toolResults }
  }
  return msg
}

function convertClaudeTools(tools: ClaudeTool[] | undefined): KiroToolWrapper[] {
  if (!tools?.length) return []
  return tools.map((tool) => {
    let description = tool.description || `Tool: ${tool.name}`
    if (description.length > TOOL_DESC_MAX) description = description.slice(0, TOOL_DESC_MAX) + '...'
    return {
      toolSpecification: {
        name: tool.name.slice(0, TOOL_NAME_MAX),
        description,
        inputSchema: { json: tool.input_schema ?? { type: 'object', properties: {} } },
      },
    }
  })
}

export function claudeToKiro(request: ClaudeMessagesRequest, profileArn?: string): KiroPayload {
  const modelId = mapModelId(request.model || '')
  const origin = 'AI_EDITOR'
  let systemPrompt = extractSystem(request.system)
  if (systemPrompt) {
    systemPrompt = `[Context: Current time is ${new Date().toISOString()}]\n\n${systemPrompt}`
  }

  const history: KiroHistoryMessage[] = []
  let pending: ExtractedUser | null = null
  const messages = request.messages || []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const isLast = i === messages.length - 1
    if (msg.role === 'user') {
      const merged = mergeUser(pending, extractClaudeUser(msg))
      pending = null
      if (isLast) {
        pending = merged
      } else if (messages[i + 1]?.role === 'assistant') {
        history.push({ userInputMessage: toUserInput(merged, modelId, origin) })
      } else {
        pending = merged
      }
    } else if (msg.role === 'assistant') {
      if (pending) {
        history.push({ userInputMessage: toUserInput(pending, modelId, origin) })
        pending = null
      }
      const { content, toolUses } = extractClaudeAssistant(msg)
      let text = content
      if (!text.trim() && toolUses.length) text = ' '
      else if (!text.trim()) text = 'I understand.'
      history.push({
        assistantResponseMessage: {
          content: text,
          toolUses: toolUses.length ? toolUses : undefined,
        },
      })
    }
  }

  let current = pending ?? { content: 'Continue.', images: [], toolResults: [] }
  if (!current.content.trim() && current.toolResults.length) {
    current = { ...current, content: 'Tool results provided.' }
  }
  if (!current.content.trim()) current = { ...current, content: 'Continue.' }

  if (history.length > 0 && history[0]?.assistantResponseMessage) {
    history.unshift({
      userInputMessage: { content: 'Begin conversation', modelId, origin },
    })
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

  const choice = request.tool_choice
  let tools = convertClaudeTools(request.tools)
  if (choice && typeof choice === 'object' && choice.type === 'none') tools = []
  if (choice && typeof choice === 'object' && choice.type === 'tool' && choice.name) {
    current = {
      ...current,
      content: `${current.content}\n\n[Use the tool named ${choice.name}.]`,
    }
  }

  const currentUser = toUserInput(current, modelId, origin)
  if (tools.length) {
    currentUser.userInputMessageContext = {
      ...currentUser.userInputMessageContext,
      tools,
    }
  }

  const payload: KiroPayload = {
    conversationState: {
      agentContinuationId: randomUUID(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      conversationId: request.metadata?.user_id || randomUUID(),
      currentMessage: { userInputMessage: currentUser },
      history: history.length ? history : undefined,
    },
  }
  if (profileArn) payload.profileArn = profileArn
  if (request.max_tokens || request.temperature !== undefined || request.top_p !== undefined) {
    payload.inferenceConfig = {}
    if (request.max_tokens) payload.inferenceConfig.maxTokens = request.max_tokens
    if (request.temperature !== undefined) payload.inferenceConfig.temperature = request.temperature
    if (request.top_p !== undefined) payload.inferenceConfig.topP = request.top_p
  }
  return payload
}

export function kiroToClaudeResponse(
  content: string,
  toolUses: KiroToolUse[],
  usage: KiroUsage,
  model: string,
): ClaudeResponse {
  const blocks: Array<Record<string, unknown>> = []
  if (content?.trim()) blocks.push({ type: 'text', text: content })
  for (const tu of toolUses) {
    blocks.push({
      type: 'tool_use',
      id: tu.toolUseId,
      name: tu.name,
      input: tu.input,
    })
  }
  if (!blocks.length) blocks.push({ type: 'text', text: content || '' })
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    content: blocks,
    model,
    stop_reason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    },
  }
}

export function estimateClaudeInputTokens(request: Pick<ClaudeMessagesRequest, 'system' | 'messages' | 'tools'>): number {
  const raw = JSON.stringify({
    system: request.system ?? '',
    messages: request.messages ?? [],
    tools: request.tools ?? [],
  })
  return Math.max(1, Math.ceil(raw.length / 4))
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

/** Incremental Anthropic SSE encoder. Observation of model output only. */
export class ClaudeSseSession {
  private index = 0
  private textOpen = false
  private sawTool = false
  readonly id: string

  constructor(
    readonly model: string,
    id?: string,
  ) {
    this.id = id ?? `msg_${randomUUID().replace(/-/g, '')}`
  }

  start(inputTokens: number): string {
    return frame('message_start', {
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
  }

  private closeText(): string {
    if (!this.textOpen) return ''
    const out = frame('content_block_stop', { index: this.index })
    this.textOpen = false
    this.index++
    return out
  }

  text(text: string): string {
    if (!text) return ''
    let out = ''
    if (!this.textOpen) {
      out += frame('content_block_start', {
        index: this.index,
        content_block: { type: 'text', text: '' },
      })
      this.textOpen = true
    }
    out += frame('content_block_delta', {
      index: this.index,
      delta: { type: 'text_delta', text },
    })
    return out
  }

  tool(toolUse: KiroToolUse): string {
    this.sawTool = true
    let out = this.closeText()
    out += frame('content_block_start', {
      index: this.index,
      content_block: {
        type: 'tool_use',
        id: toolUse.toolUseId,
        name: toolUse.name,
        input: {},
      },
    })
    out += frame('content_block_delta', {
      index: this.index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input ?? {}) },
    })
    out += frame('content_block_stop', { index: this.index })
    this.index++
    return out
  }

  finish(usage: { input_tokens?: number; output_tokens: number }): string {
    const stop = this.sawTool ? 'tool_use' : 'end_turn'
    return (
      this.closeText() +
      frame('message_delta', {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      }) +
      frame('message_stop', {})
    )
  }

  fail(message: string): string {
    return frame('error', { error: { type: 'api_error', message } })
  }
}
