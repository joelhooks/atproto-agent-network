export type ActivityKind =
  | 'memory'
  | 'message'
  | 'identity'
  | 'prompt'
  | 'tool'
  | 'think_aloud'
  | 'goal'
  | 'loop'
  | 'system'
  | 'error'

export interface DashboardActivityEvent {
  type: string
  agent: string
  kind: ActivityKind
  summary: string
  timestamp: string
  text?: string
  tags?: string[]
  details?: Record<string, unknown>
}

type AgentEventPayload = {
  id: string
  agent_did: string
  session_id: string
  event_type: string
  outcome: 'success' | 'error' | 'timeout' | 'skipped'
  timestamp: string
  trace_id?: string
  span_id: string
  parent_span_id?: string
  context: Record<string, unknown>
  error?: { code: string; message: string; stack?: string; retryable: boolean }
}

export function normalizeAgentEvent(
  payload: unknown,
  opts?: { agentNameHint?: string }
): DashboardActivityEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Partial<AgentEventPayload> & Record<string, unknown>

  const type = typeof p.event_type === 'string' ? p.event_type : null
  const timestamp = typeof p.timestamp === 'string' ? p.timestamp : null
  if (!type || !timestamp) return null

  const context = p.context && typeof p.context === 'object' && !Array.isArray(p.context) ? (p.context as Record<string, unknown>) : {}

  const agent = opts?.agentNameHint ?? (typeof p.agent_did === 'string' ? p.agent_did : 'unknown')

  const isToolEvent =
    type.includes('.tool.') ||
    type.includes('tool.') ||
    type.includes('.tool') ||
    type.includes('tool_') ||
    type.includes('toolcall') ||
    type.includes('tool_call')

  const kind: ActivityKind =
    type === 'agent.think_aloud'
      ? 'think_aloud'
      : isToolEvent
        ? 'tool'
      : type === 'loop.error'
        ? 'error'
      : type.startsWith('loop.')
        ? 'loop'
        : type.includes('memory')
          ? 'memory'
        : type.includes('message')
            ? 'message'
            : type.includes('identity')
              ? 'identity'
              : type.includes('prompt')
                ? 'prompt'
                : p.outcome === 'error' || Boolean(p.error)
                  ? 'error'
                  : 'system'

  const summary = (() => {
    if (type === 'agent.think_aloud') {
      return typeof context.message === 'string' ? context.message : type
    }

    if (type === 'loop.sleep') {
      const intervalMs = typeof context.intervalMs === 'number' && Number.isFinite(context.intervalMs) ? context.intervalMs : null
      const nextAlarmAt = typeof context.nextAlarmAt === 'number' && Number.isFinite(context.nextAlarmAt) ? context.nextAlarmAt : null
      const parts: string[] = []
      parts.push('Sleep')
      if (intervalMs !== null) parts.push(`${Math.round(intervalMs / 1000)}s`)
      if (nextAlarmAt !== null) parts.push(`next=${new Date(nextAlarmAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`)
      return parts.join(' ')
    }

    if (type === 'loop.error') {
      const phase = typeof context.phase === 'string' ? context.phase : null
      const msg =
        p.error && typeof (p.error as any).message === 'string'
          ? (p.error as any).message
          : null
      if (phase && msg) return `Loop error (${phase}): ${msg}`
      if (phase) return `Loop error (${phase})`
      if (msg) return `Loop error: ${msg}`
      return 'Loop error'
    }

    if (type.startsWith('loop.')) {
      return `Loop ${type.slice('loop.'.length)}`
    }

    if (kind === 'tool') {
      const toolFromCtx =
        typeof context.tool === 'string'
          ? context.tool
          : context.tool && typeof context.tool === 'object' && !Array.isArray(context.tool)
            ? ((context.tool as Record<string, unknown>).name ?? (context.tool as Record<string, unknown>).tool) // common shapes
            : null
      const toolName =
        typeof context.toolName === 'string'
          ? context.toolName
          : typeof toolFromCtx === 'string'
            ? toolFromCtx
            : null
      return toolName ? `Tool: ${toolName}` : type
    }

    return type
  })()

  const details: Record<string, unknown> = {
    outcome: typeof p.outcome === 'string' ? p.outcome : 'success',
    context,
  }
  if (p.error && typeof p.error === 'object') details.error = p.error
  if (typeof p.trace_id === 'string') details.trace_id = p.trace_id
  if (typeof p.span_id === 'string') details.span_id = p.span_id

  return { type, agent, kind, summary, timestamp, details }
}

function tryParseJson(s: string): Record<string, unknown> | null {
  if (!s.startsWith('{') && !s.startsWith('[')) return null
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

/** Pull the first human-readable string from common JSON keys */
function extractHumanText(obj: Record<string, unknown>): string | undefined {
  const keys = ['note', 'decision', 'message', 'description', 'summary', 'reason', 'text', 'rationale', 'detail', 'comment', 'observation']
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].length > 0) return obj[k]
  }
  return undefined
}

function humanizeMemoryNote(
  rawSummary: string,
  rawText: string | undefined
): { summary: string; text: string | undefined; jsonData: Record<string, unknown> | null } {
  const summaryJson = tryParseJson(rawSummary)
  const textJson = rawText ? tryParseJson(rawText) : null

  // If summary is JSON, build a human-readable summary from its fields
  if (summaryJson) {
    const obj = summaryJson
    const type = typeof obj.type === 'string' ? obj.type : null
    const action = typeof obj.action === 'string' ? obj.action : null
    const result = typeof obj.result === 'string' ? obj.result : null
    const note = typeof obj.note === 'string' ? obj.note : null
    const decision = typeof obj.decision === 'string' ? obj.decision : null
    const gameId = typeof obj.gameId === 'string' ? obj.gameId : null

    // Build a human summary from known fields
    const parts: string[] = []
    if (type) parts.push(type.replace(/_/g, ' '))
    if (action) parts.push(action.replace(/_/g, ' '))
    if (result) parts.push(`(${result})`)
    if (gameId) parts.push(`#${gameId.split('_').pop()}`)
    const summary = parts.length > 0 ? parts.join(' ') : rawSummary

    // Use the first human-readable field as text
    const text = extractHumanText(obj)

    return { summary, text, jsonData: obj }
  }

  // If text is JSON but summary is human-readable, keep summary, extract human text from JSON
  if (textJson && !summaryJson) {
    const humanText = extractHumanText(textJson)
    return { summary: rawSummary, text: humanText, jsonData: textJson }
  }

  // If rawText looks like JSON even if tryParseJson didn't catch it, suppress it
  if (rawText && (rawText.trimStart().startsWith('{') || rawText.trimStart().startsWith('['))) {
    const parsed = tryParseJson(rawText)
    if (parsed) {
      return { summary: rawSummary, text: extractHumanText(parsed), jsonData: parsed }
    }
  }

  return { summary: rawSummary, text: rawText, jsonData: null }
}

export function summarizeLexiconRecord(record: unknown): {
  kind: ActivityKind
  summary: string
  text?: string
  tags?: string[]
  details?: Record<string, unknown>
  timestamp?: string
} {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { kind: 'system', summary: 'Unknown record' }
  }
  const r = record as Record<string, unknown>
  const type = typeof r.$type === 'string' ? r.$type : 'unknown'

  if (type === 'agent.memory.note') {
    const rawSummary = typeof r.summary === 'string' ? r.summary : 'Memory note'
    const rawText = typeof r.text === 'string' ? r.text : undefined
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : undefined
    const timestamp = typeof r.createdAt === 'string' ? r.createdAt : undefined

    // If summary looks like JSON, try to extract something human-readable
    const { summary, text, jsonData } = humanizeMemoryNote(rawSummary, rawText)

    return { kind: 'memory', summary, text, tags, timestamp, details: { $type: type, ...(jsonData ? { memoryData: jsonData } : {}) } }
  }

  if (type === 'agent.memory.decision') {
    const decision = typeof r.decision === 'string' ? r.decision : 'Decision'
    const status = typeof r.status === 'string' ? r.status : 'unknown'
    const context = typeof r.context === 'string' ? r.context : ''
    const rationale = typeof r.rationale === 'string' ? r.rationale : ''
    const text = [context, rationale].filter(Boolean).join('\n\n') || undefined
    const timestamp = typeof r.createdAt === 'string' ? r.createdAt : undefined
    return {
      kind: 'memory',
      summary: `Decision: ${decision} (${status})`,
      text,
      timestamp,
      details: { $type: type, status },
    }
  }

  if (type === 'agent.comms.message') {
    const sender = typeof r.sender === 'string' ? r.sender : 'unknown'
    const recipient = typeof r.recipient === 'string' ? r.recipient : 'unknown'
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : undefined
    const content = r.content && typeof r.content === 'object' && !Array.isArray(r.content) ? (r.content as Record<string, unknown>) : {}
    const kind = typeof content.kind === 'string' ? content.kind : 'unknown'
    const text =
      kind === 'text' && typeof content.text === 'string'
        ? content.text
        : kind === 'json'
          ? JSON.stringify(content.data ?? null, null, 2)
          : kind === 'ref' && typeof content.uri === 'string'
            ? content.uri
            : undefined
    return {
      kind: 'message',
      summary: `Message: ${sender} -> ${recipient}`,
      text,
      timestamp: createdAt,
      details: { $type: type, sender, recipient, content },
      tags: [`kind:${kind}`],
    }
  }

  if (type === 'agent.comms.task') {
    const sender = typeof r.sender === 'string' ? r.sender : 'unknown'
    const recipient = typeof r.recipient === 'string' ? r.recipient : 'unknown'
    const task = typeof r.task === 'string' ? r.task : 'Task'
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : undefined
    return {
      kind: 'message',
      summary: `Task: ${sender} -> ${recipient}`,
      text: task,
      timestamp: createdAt,
      details: { $type: type, sender, recipient, task },
    }
  }

  if (type === 'agent.comms.response') {
    const sender = typeof r.sender === 'string' ? r.sender : 'unknown'
    const recipient = typeof r.recipient === 'string' ? r.recipient : 'unknown'
    const status = typeof r.status === 'string' ? r.status : 'unknown'
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : undefined
    const error = typeof r.error === 'string' ? r.error : undefined
    const text = error ?? (r.result !== undefined ? JSON.stringify(r.result, null, 2) : undefined)
    return {
      kind: 'message',
      summary: `Response (${status}): ${sender} -> ${recipient}`,
      text,
      timestamp: createdAt,
      details: { $type: type, sender, recipient, status },
    }
  }

  if (type === 'agent.comms.handoff') {
    const from = typeof r.from === 'string' ? r.from : 'unknown'
    const to = typeof r.to === 'string' ? r.to : 'unknown'
    const reason = typeof r.reason === 'string' ? r.reason : undefined
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : undefined
    return {
      kind: 'message',
      summary: `Handoff: ${from} -> ${to}`,
      text: reason,
      timestamp: createdAt,
      details: { $type: type, from, to },
    }
  }

  return { kind: 'system', summary: `Record: ${type}`, details: { $type: type } }
}
