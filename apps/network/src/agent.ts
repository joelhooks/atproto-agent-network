/**
 * Agent Durable Object
 * 
 * One DO per agent. Holds identity, encrypted memories, Pi runtime.
 * See .agents/skills/cloudflare-do and .agents/skills/pi-agent
 */

import { DurableObject } from 'cloudflare:workers'

import {
  EncryptedMemory,
  PiAgentWrapper,
  type EncryptedMemoryRecord,
  type PiAgentFactory,
  type PiAgentMessage,
  type PiAgentTool,
} from '../../../packages/agent/src'
import { createOpenRouterAgentFactory } from './agent-factory'
import {
  exportPublicKey,
  exportCryptoKeyPairJwk,
  generateEd25519Keypair,
  generateX25519Keypair,
  importCryptoKeyPairJwk,
  type StoredCryptoKeyPairJwk,
} from '../../../packages/core/src/crypto'
import { createDid, generateTid } from '../../../packages/core/src/identity'
import { validateLexiconRecord } from '../../../packages/core/src/validation'
import type { AgentConfig, AgentEvent, AgentGoal, AgentIdentity } from '../../../packages/core/src/types'

import { withErrorHandling } from './http-errors'

interface AgentEnv {
  AGENTS?: DurableObjectNamespace
  DB: D1Database
  BLOBS: R2Bucket
  RELAY?: DurableObjectNamespace
  VECTORIZE?: VectorizeIndex
  AI?: Ai
  PI_AGENT_FACTORY?: PiAgentFactory
  PI_AGENT_MODEL?: unknown
  PI_SYSTEM_PROMPT?: string
  // OpenRouter via AI Gateway
  CF_ACCOUNT_ID?: string
  AI_GATEWAY_SLUG?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL_DEFAULT?: string
}

interface StoredAgentIdentityV1 {
  version: 1
  did: string
  signingKey: StoredCryptoKeyPairJwk
  encryptionKey: StoredCryptoKeyPairJwk
  createdAt: number
  rotatedAt?: number
}

interface StoredAgentSessionBranchPoint {
  id: string
  label?: string
  // Message index at the time the branch point was created.
  // Interpreted as a global index (see baseIndex in StoredAgentSessionV1).
  messageIndex: number
  createdAt: number
  [key: string]: unknown
}

interface StoredAgentSessionV1 {
  version: 1
  // Global index of messages[0] in the full conversation history.
  baseIndex?: number
  messages: PiAgentMessage[]
  branchPoints?: StoredAgentSessionBranchPoint[]
}

export interface ObservationEvent {
  ts: number
  type: string
  [key: string]: unknown
}

export interface ObservationInboxEntry<T = unknown> {
  id: string
  record: T
}

export interface Observations {
  did: string
  observedAt: number
  sinceAlarmAt: number | null
  inbox: Array<ObservationInboxEntry>
  events: ObservationEvent[]
}

interface ThinkToolCall {
  name: string
  arguments?: unknown
  [key: string]: unknown
}

interface ThinkResult {
  content?: string
  toolCalls?: ThinkToolCall[]
  goals?: AgentGoal[]
  [key: string]: unknown
}

interface ActResult {
  steps: Array<{
    name: string
    ok: boolean
    result?: unknown
    error?: string
    durationMs?: number
  }>
  truncated: boolean
  timedOut: boolean
}

const DEFAULT_AGENT_MODEL = 'moonshotai/kimi-k2.5'
const DEFAULT_AGENT_FAST_MODEL = 'google/gemini-2.0-flash-001'
const DEFAULT_AGENT_LOOP_INTERVAL_MS = 60_000
const MIN_AGENT_LOOP_INTERVAL_MS = 5_000
const DEFAULT_AGENT_SYSTEM_PROMPT = 'You are a Pi agent running on the AT Protocol Agent Network.'

function extractAgentNameFromPath(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'agents' && parts[1]) {
    return parts[1]
  }
  return undefined
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function createTraceId(): string {
  // OpenTelemetry trace_id: 16 bytes => 32 hex chars.
  return randomHex(16)
}

function createSpanId(): string {
  // OpenTelemetry span_id: 8 bytes => 16 hex chars.
  return randomHex(8)
}

export class AgentDO extends DurableObject {
  private readonly did: string
  private readonly agentEnv: AgentEnv
  private initialized = false
  private initializing: Promise<void> | null = null
  private registeredWithRelay = false
  private identity: AgentIdentity | null = null
  private memory: EncryptedMemory | null = null
  private agent: PiAgentWrapper | null = null
  private tools: PiAgentTool[] = []
  private config: AgentConfig | null = null
  private session: StoredAgentSessionV1 | null = null
  private sessionId: string | null = null

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env)
    this.agentEnv = env
    this.did = createDid(ctx.id.toString())
  }

  private async getOrCreateSessionId(): Promise<string> {
    if (this.sessionId) return this.sessionId
    const stored = await this.ctx.storage.get<string>('sessionId')
    if (typeof stored === 'string' && stored.length > 0) {
      this.sessionId = stored
      return stored
    }
    const created = crypto.randomUUID()
    await this.ctx.storage.put('sessionId', created)
    this.sessionId = created
    return created
  }

  private async broadcastLoopEvent(input: {
    event_type: string
    trace_id: string
    span_id: string
    parent_span_id?: string
    outcome?: AgentEvent['outcome']
    context?: Record<string, unknown>
    error?: AgentEvent['error']
  }): Promise<void> {
    const sockets = (this.ctx as unknown as { getWebSockets?: () => WebSocket[] }).getWebSockets?.() ?? []
    if (!sockets.length) return

    const payload: AgentEvent = {
      id: generateTid(),
      agent_did: this.did,
      session_id: await this.getOrCreateSessionId(),
      event_type: input.event_type,
      outcome: input.outcome ?? 'success',
      timestamp: new Date().toISOString(),
      trace_id: input.trace_id,
      span_id: input.span_id,
      parent_span_id: input.parent_span_id,
      context: input.context ?? {},
      error: input.error,
    }

    const message = JSON.stringify(payload)

    for (const ws of sockets) {
      try {
        // 1 === OPEN in standard WebSocket API.
        if ((ws as unknown as { readyState?: number }).readyState !== 1) continue
        ws.send(message)
      } catch {
        // Best-effort: stale sockets can linger in DO hibernation lists.
        try {
          ws.close(1011, 'stale connection')
        } catch {
          // ignore
        }
      }
    }
  }
  
  async fetch(request: Request): Promise<Response> {
    return withErrorHandling(
      async () => {
        const url = new URL(request.url)
        const agentName = extractAgentNameFromPath(url.pathname)

        if (!this.initialized) {
          await this.initialize(agentName)
        }

        const parts = url.pathname.split('/').filter(Boolean)
        const leaf = parts.at(-1)
        const penultimate = parts.at(-2)

        // ===== Story 4a: Bare alarm chain + start/stop API =====
        // Support both:
        // - /loop/start (used by unit tests)
        // - /agents/:name/loop/start (worker forwards full path)
        if (penultimate === 'loop' && leaf) {
          if (leaf === 'start') {
            if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            return Response.json(await this.startLoop())
          }

          if (leaf === 'stop') {
            if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            return Response.json(await this.stopLoop())
          }

          if (leaf === 'status') {
            if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
            return Response.json(await this.getLoopStatus())
          }
        }

        // WebSocket for real-time communication
        if (request.headers.get('Upgrade') === 'websocket') {
          return withErrorHandling(
            () => this.handleWebSocket(request),
            { route: 'AgentDO.websocket', request }
          )
        }

        switch (leaf) {
          case 'identity':
            return withErrorHandling(
              () => this.getIdentity(),
              { route: 'AgentDO.identity', request }
            )
          case 'prompt':
            return withErrorHandling(
              () => this.handlePrompt(request),
              { route: 'AgentDO.prompt', request }
            )
          case 'memory':
            return withErrorHandling(
              () => this.handleMemory(request),
              { route: 'AgentDO.memory', request }
            )
          case 'share':
            return withErrorHandling(
              () => this.handleShare(request),
              { route: 'AgentDO.share', request }
            )
          case 'shared':
            return withErrorHandling(
              () => this.handleShared(request),
              { route: 'AgentDO.shared', request }
            )
          case 'inbox':
            return withErrorHandling(
              () => this.handleInbox(request),
              { route: 'AgentDO.inbox', request }
            )
          case 'config':
            return withErrorHandling(
              () => this.handleConfig(request),
              { route: 'AgentDO.config', request }
            )
          default:
            return new Response('Not found', { status: 404 })
        }
      },
      { route: 'AgentDO.fetch', request }
    )
  }

  async startLoop(): Promise<{ loopRunning: boolean; loopCount: number; nextAlarm: number | null }> {
    const running = Boolean(await this.ctx.storage.get<boolean>('loopRunning'))
    if (!running) {
      await this.ctx.storage.put('loopRunning', true)
    }

    const existingCount = await this.ctx.storage.get<number>('loopCount')
    if (typeof existingCount !== 'number' || !Number.isFinite(existingCount)) {
      await this.ctx.storage.put('loopCount', 0)
    }

    const existingAlarm = await this.ctx.storage.getAlarm()
    if (existingAlarm === null) {
      // Fire ASAP to kick off the chain.
      await this.ctx.storage.setAlarm(Date.now())
    }

    try {
      await this.broadcastLoopEvent({
        event_type: 'loop.started',
        trace_id: createTraceId(),
        span_id: createSpanId(),
        context: { did: this.did, startedAt: Date.now() },
      })
    } catch {
      // Don't let WS broadcasting break the start API.
    }

    return this.getLoopStatus()
  }

  async stopLoop(): Promise<{ loopRunning: boolean; loopCount: number; nextAlarm: number | null }> {
    await this.ctx.storage.put('loopRunning', false)
    await this.ctx.storage.deleteAlarm()
    return this.getLoopStatus()
  }

  private async getLoopStatus(): Promise<{ loopRunning: boolean; loopCount: number; nextAlarm: number | null }> {
    const loopRunning = Boolean(await this.ctx.storage.get<boolean>('loopRunning'))
    const loopCountRaw = await this.ctx.storage.get<number>('loopCount')
    const loopCount = typeof loopCountRaw === 'number' && Number.isFinite(loopCountRaw) ? loopCountRaw : 0
    const nextAlarm = await this.ctx.storage.getAlarm()
    return { loopRunning, loopCount, nextAlarm }
  }

  async alarm(alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    const running = Boolean(await this.ctx.storage.get<boolean>('loopRunning'))
    if (!running) {
      console.log('AgentDO alarm fired while loop stopped', { did: this.did })
      return
    }

    const traceId = createTraceId()

    let intervalMs = DEFAULT_AGENT_LOOP_INTERVAL_MS
    let observations: Observations | null = null
    let thought: ThinkResult | null = null
    let acted: ActResult | null = null

    try {
      const storedConfig = await this.ctx.storage.get<AgentConfig>('config')
      if (storedConfig && typeof storedConfig.loopIntervalMs === 'number' && Number.isFinite(storedConfig.loopIntervalMs)) {
        intervalMs = storedConfig.loopIntervalMs
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO alarm failed to load config', { did: this.did, error: message })
    }

    intervalMs = Math.max(MIN_AGENT_LOOP_INTERVAL_MS, intervalMs)

    try {
      await this.broadcastLoopEvent({
        event_type: 'loop.observe',
        trace_id: traceId,
        span_id: createSpanId(),
      })
      observations = await this.observe()
      await this.ctx.storage.put('lastObservations', observations)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO observe failed', { did: this.did, error: message })
      try {
        await this.broadcastLoopEvent({
          event_type: 'loop.error',
          trace_id: traceId,
          span_id: createSpanId(),
          outcome: 'error',
          context: { phase: 'observe' },
          error: { code: 'observe_failed', message, retryable: true },
        })
      } catch {
        // ignore
      }
      // Continue: observation errors must not break the chain.
    }

    try {
      if (observations) {
        await this.broadcastLoopEvent({
          event_type: 'loop.think',
          trace_id: traceId,
          span_id: createSpanId(),
        })
        thought = await this.think(observations)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO think failed', { did: this.did, error: message })
      try {
        await this.broadcastLoopEvent({
          event_type: 'loop.error',
          trace_id: traceId,
          span_id: createSpanId(),
          outcome: 'error',
          context: { phase: 'think' },
          error: { code: 'think_failed', message, retryable: true },
        })
      } catch {
        // ignore
      }
      // Continue: think errors must not break the chain.
    }

    try {
      if (thought) {
        await this.broadcastLoopEvent({
          event_type: 'loop.act',
          trace_id: traceId,
          span_id: createSpanId(),
        })
        acted = await this.act(thought)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO act failed', { did: this.did, error: message })
      try {
        await this.broadcastLoopEvent({
          event_type: 'loop.error',
          trace_id: traceId,
          span_id: createSpanId(),
          outcome: 'error',
          context: { phase: 'act' },
          error: { code: 'act_failed', message, retryable: true },
        })
      } catch {
        // ignore
      }
      // Continue: action errors must not break the chain.
    }

    try {
      await this.broadcastLoopEvent({
        event_type: 'loop.reflect',
        trace_id: traceId,
        span_id: createSpanId(),
      })
      await this.reflect({ observations, thought, acted })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO reflect failed', { did: this.did, error: message })
      try {
        await this.broadcastLoopEvent({
          event_type: 'loop.error',
          trace_id: traceId,
          span_id: createSpanId(),
          outcome: 'error',
          context: { phase: 'reflect' },
          error: { code: 'reflect_failed', message, retryable: true },
        })
      } catch {
        // ignore
      }
      // Continue: reflect errors must not break the chain.
    }

    try {
      const current = await this.ctx.storage.get<number>('loopCount')
      const next = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1
      await this.ctx.storage.put('loopCount', next)

      console.log('AgentDO alarm tick', {
        did: this.did,
        loopCount: next,
        isRetry: alarmInfo?.isRetry ?? false,
        retryCount: alarmInfo?.retryCount ?? 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO alarm tick error', { did: this.did, error: message })
      // Continue: errors must not break the chain.
    }

    try {
      await this.ctx.storage.setAlarm(Date.now() + intervalMs)
      try {
        await this.broadcastLoopEvent({
          event_type: 'loop.sleep',
          trace_id: traceId,
          span_id: createSpanId(),
          context: { intervalMs, nextAlarmAt: Date.now() + intervalMs },
        })
      } catch {
        // ignore
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('AgentDO alarm reschedule error', { did: this.did, error: message })
      // Don't throw: keep retries under our control.
    }
  }

  async observe(): Promise<Observations> {
    if (!this.initialized) {
      await this.initialize()
    }

    const observedAt = Date.now()
    const sinceAlarmAtRaw = await this.ctx.storage.get<number>('lastAlarmAt')
    const sinceAlarmAt =
      typeof sinceAlarmAtRaw === 'number' && Number.isFinite(sinceAlarmAtRaw) ? sinceAlarmAtRaw : null

    const pendingRaw = await this.ctx.storage.get<unknown>('pendingEvents')
    const pending = Array.isArray(pendingRaw) ? (pendingRaw as ObservationEvent[]) : []
    const normalizedPending = pending.filter((evt): evt is ObservationEvent => {
      if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return false
      const asRecord = evt as Record<string, unknown>
      return typeof asRecord.ts === 'number' && Number.isFinite(asRecord.ts) && typeof asRecord.type === 'string'
    })

    const events =
      sinceAlarmAt === null
        ? normalizedPending
        : normalizedPending.filter((evt) => evt.ts > sinceAlarmAt && evt.ts <= observedAt)

    // Drain pending events (they're a per-alarm-cycle queue).
    await this.ctx.storage.put('pendingEvents', [])
    await this.ctx.storage.put('lastAlarmAt', observedAt)

    const inbox: Array<ObservationInboxEntry> = []

    if (this.memory) {
      const entries = await this.memory.list({ collection: 'agent.comms.message', limit: 100 })
      const processedAt = new Date(observedAt).toISOString()

      for (const entry of entries) {
        const record = entry.record as Record<string, unknown>
        if (!record || record.$type !== 'agent.comms.message') continue
        if (record.recipient !== this.did) continue
        if (typeof record.processedAt === 'string' && record.processedAt.length > 0) continue

        const updated: EncryptedMemoryRecord = { ...(record as EncryptedMemoryRecord), processedAt }
        try {
          const ok = await this.memory.update(entry.id, updated)
          if (!ok) continue
        } catch {
          continue
        }

        inbox.push({ id: entry.id, record: updated })
      }
    }

    return {
      did: this.did,
      observedAt,
      sinceAlarmAt,
      inbox,
      events,
    }
  }

  private buildThinkPrompt(observations: Observations): string {
    const goals = (this.config?.goals ?? [])
      .filter((goal) => goal && typeof goal === 'object')
      .map((goal) => ({
        id: goal.id,
        description: goal.description,
        priority: goal.priority,
        status: goal.status,
        progress: goal.progress,
      }))

    return [
      'You are running an autonomous think/act/reflect loop.',
      '',
      'Current goals:',
      goals.length ? JSON.stringify(goals, null, 2) : '[]',
      '',
      'Observations:',
      JSON.stringify(observations, null, 2),
      '',
      'Decide what to do next. If you need to use tools, include tool calls in your response.',
      'If you want to update goals, include an updated `goals` array in your response.',
    ].join('\n')
  }

  private normalizeThinkResult(result: unknown): ThinkResult {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { content: typeof result === 'string' ? result : undefined }
    }

    const record = result as Record<string, unknown>
    const toolCallsRaw = (record.toolCalls ?? record.tool_calls) as unknown
    const toolCalls = Array.isArray(toolCallsRaw)
      ? toolCallsRaw
          .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === 'object' && !Array.isArray(call))
          .map((call) => ({
            name: typeof call.name === 'string' ? call.name : '',
            arguments: call.arguments ?? call.args ?? call.input,
            ...call,
          }))
          .filter((call) => typeof call.name === 'string' && call.name.length > 0)
      : undefined

    const goalsRaw = record.goals
    const goals = Array.isArray(goalsRaw)
      ? goalsRaw.filter((goal): goal is AgentGoal => isAgentGoal(goal))
      : undefined

    return {
      ...(record as ThinkResult),
      toolCalls,
      goals,
    }
  }

  private async think(observations: Observations): Promise<ThinkResult> {
    if (!this.initialized) {
      await this.initialize()
    }
    if (!this.agent) {
      throw new Error('Agent unavailable')
    }

    const prompt = this.buildThinkPrompt(observations)
    const result = await this.agent.prompt(prompt, { mode: 'loop.think' })
    return this.normalizeThinkResult(result)
  }

  private async act(thought: ThinkResult): Promise<ActResult> {
    const startedAt = Date.now()
    const timeoutMs = 30_000
    const maxSteps = 5
    const deadline = startedAt + timeoutMs

    const toolCalls = Array.isArray(thought.toolCalls) ? thought.toolCalls : []
    const configuredAllowlist = this.config?.enabledTools ?? []
    const allowlist = configuredAllowlist.length > 0 ? new Set(configuredAllowlist) : null

    const steps: ActResult['steps'] = []
    let truncated = false
    let timedOut = false

    const selected = toolCalls.slice(0, maxSteps)
    truncated = toolCalls.length > selected.length

    for (const call of selected) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }

      const name = call.name
      if (allowlist && !allowlist.has(name)) {
        steps.push({ name, ok: false, error: 'Tool not enabled' })
        continue
      }

      const tool = this.tools.find((t) => t.name === name)
      if (!tool || typeof tool.execute !== 'function') {
        steps.push({ name, ok: false, error: 'Tool not found' })
        continue
      }

      const stepStart = Date.now()
      try {
        // Think() results don't include toolCallId. Generate a stable-ish id per step for tracing.
        const toolCallId = `tc_${generateTid()}`
        const result = await promiseWithTimeout(
          Promise.resolve(tool.execute(toolCallId, call.arguments ?? {})),
          remaining,
          `Tool timed out: ${name}`
        )
        steps.push({ name, ok: true, result, durationMs: Date.now() - stepStart })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.toLowerCase().includes('timed out')) {
          timedOut = true
        }
        steps.push({ name, ok: false, error: message, durationMs: Date.now() - stepStart })
      }
    }

    return { steps, truncated, timedOut }
  }

  private async reflect(input: {
    observations: Observations | null
    thought: ThinkResult | null
    acted: ActResult | null
  }): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }

    // Persist the session after each loop cycle.
    await this.saveSession()

    // Persist goal updates if the model produced an updated goal list.
    if (this.config && input.thought?.goals && input.thought.goals.length > 0) {
      this.config = { ...this.config, goals: structuredClone(input.thought.goals) }
      await this.ctx.storage.put('config', this.config)
    }

    // Store a tiny summary for debugging (structured-cloneable).
    await this.ctx.storage.put('lastReflection', {
      at: Date.now(),
      did: this.did,
      acted: input.acted
        ? {
            steps: input.acted.steps.map((s) => ({ name: s.name, ok: s.ok })),
            truncated: input.acted.truncated,
            timedOut: input.acted.timedOut,
          }
        : null,
    })
  }
  
  private async initialize(agentName?: string): Promise<void> {
    if (this.initialized) return
    if (this.initializing) {
      await this.initializing
      return
    }

    this.initializing = (async () => {
      const stored = await this.ctx.storage.get<StoredAgentIdentityV1>('identity')

      if (stored && stored.version === 1) {
        this.identity = {
          did: stored.did,
          signingKey: await importCryptoKeyPairJwk(stored.signingKey),
          encryptionKey: await importCryptoKeyPairJwk(stored.encryptionKey),
          createdAt: stored.createdAt,
          rotatedAt: stored.rotatedAt,
        }
      } else {
        this.identity = {
          did: this.did,
          signingKey: await generateEd25519Keypair(),
          encryptionKey: await generateX25519Keypair(),
          createdAt: Date.now(),
        }
        const persisted: StoredAgentIdentityV1 = {
          version: 1,
          did: this.identity.did,
          signingKey: await exportCryptoKeyPairJwk(this.identity.signingKey),
          encryptionKey: await exportCryptoKeyPairJwk(this.identity.encryptionKey),
          createdAt: this.identity.createdAt,
          rotatedAt: this.identity.rotatedAt,
        }
        await this.ctx.storage.put('identity', persisted)
      }

      this.memory = new EncryptedMemory(
        this.agentEnv.DB,
        this.agentEnv.BLOBS,
        this.identity
      )

      const config = await this.loadOrCreateConfig(agentName)
      this.session = await this.loadSession()
      const tools = this.buildTools()
      this.tools = tools
      const systemPrompt = config.personality
      const model = config.model

      // Use OpenRouter via AI Gateway as default agent factory
      const agentFactory = this.agentEnv.PI_AGENT_FACTORY ??
        (this.agentEnv.OPENROUTER_API_KEY && this.agentEnv.CF_ACCOUNT_ID && this.agentEnv.AI_GATEWAY_SLUG
          ? createOpenRouterAgentFactory({
              CF_ACCOUNT_ID: this.agentEnv.CF_ACCOUNT_ID,
              AI_GATEWAY_SLUG: this.agentEnv.AI_GATEWAY_SLUG,
              OPENROUTER_API_KEY: this.agentEnv.OPENROUTER_API_KEY,
              OPENROUTER_MODEL_DEFAULT: this.agentEnv.OPENROUTER_MODEL_DEFAULT,
            })
          : undefined)

      this.agent = new PiAgentWrapper({
        systemPrompt,
        model,
        tools,
        agentFactory,
        messages: this.session.messages,
      })

      this.initialized = true
      this.initializing = null
    })()

    await this.initializing
  }

  private createDefaultConfig(name: string): AgentConfig {
    return {
      name,
      personality: this.agentEnv.PI_SYSTEM_PROMPT ?? DEFAULT_AGENT_SYSTEM_PROMPT,
      specialty: '',
      model: DEFAULT_AGENT_MODEL,
      fastModel: DEFAULT_AGENT_FAST_MODEL,
      loopIntervalMs: DEFAULT_AGENT_LOOP_INTERVAL_MS,
      goals: [],
      enabledTools: [],
    }
  }

  private async loadOrCreateConfig(agentName?: string): Promise<AgentConfig> {
    if (this.config) {
      if (agentName && this.config.name !== agentName) {
        this.config = { ...this.config, name: agentName }
        await this.ctx.storage.put('config', this.config)
      }
      return this.config
    }

    const stored = await this.ctx.storage.get<AgentConfig>('config')
    if (stored) {
      this.config = stored
      if (agentName && stored.name !== agentName) {
        this.config = { ...stored, name: agentName }
        await this.ctx.storage.put('config', this.config)
      }
      return this.config
    }

    const created = this.createDefaultConfig(agentName ?? this.did)
    this.config = created
    await this.ctx.storage.put('config', created)
    return created
  }

  private async handleConfig(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const agentName = extractAgentNameFromPath(url.pathname)
    const config = await this.loadOrCreateConfig(agentName)

    if (request.method === 'GET') {
      return Response.json(config)
    }

    if (request.method !== 'PATCH') {
      return new Response('Method not allowed', { status: 405 })
    }

    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const patch = payload as Record<string, unknown>
    const next: AgentConfig = { ...config }

    if (typeof patch.personality === 'string') {
      next.personality = patch.personality
    }
    if (typeof patch.specialty === 'string') {
      next.specialty = patch.specialty
    }
    if (typeof patch.model === 'string') {
      next.model = patch.model
    }
    if (typeof patch.fastModel === 'string') {
      next.fastModel = patch.fastModel
    }
    if (typeof patch.loopIntervalMs === 'number' && Number.isFinite(patch.loopIntervalMs)) {
      next.loopIntervalMs = Math.max(MIN_AGENT_LOOP_INTERVAL_MS, patch.loopIntervalMs)
    }
    if (Array.isArray(patch.goals)) {
      next.goals = patch.goals.filter((goal) => goal && typeof goal === 'object') as AgentConfig['goals']
    }
    if (Array.isArray(patch.enabledTools)) {
      next.enabledTools = patch.enabledTools.filter((tool): tool is string => typeof tool === 'string')
    }

    // Name is derived from the DO binding (via /agents/:name/*) and should remain stable.
    if (agentName) {
      next.name = agentName
    }

    this.config = next
    await this.ctx.storage.put('config', next)

    return Response.json(next)
  }

  private buildTools(): PiAgentTool[] {
    if (!this.memory) {
      return []
    }

    const memory = this.memory
    const did = this.did
    const env = this.agentEnv
    const broadcastLoopEvent = this.broadcastLoopEvent.bind(this)

    const toTextContent = (text: string) => [{ type: 'text', text }] as Array<{ type: 'text'; text: string }>

    const parseArgs = <T extends Record<string, unknown> = Record<string, unknown>>(
      toolCallIdOrParams: unknown,
      maybeParams?: unknown
    ): { toolCallId: string; params: T } => {
      if (typeof toolCallIdOrParams === 'string') {
        const params = (maybeParams && typeof maybeParams === 'object' ? maybeParams : {}) as T
        return { toolCallId: toolCallIdOrParams, params }
      }
      const params = (toolCallIdOrParams && typeof toolCallIdOrParams === 'object' ? toolCallIdOrParams : {}) as T
      return { toolCallId: `tc_${generateTid()}`, params }
    }

    const extractSearchableText = (record: EncryptedMemoryRecord): string => {
      const parts: string[] = []
      const summary = (record as Record<string, unknown>).summary
      const text = (record as Record<string, unknown>).text
      if (typeof summary === 'string' && summary.trim().length > 0) parts.push(summary)
      if (typeof text === 'string' && text.trim().length > 0) parts.push(text)
      // Always include a JSON fallback so arbitrary records are searchable.
      parts.push(JSON.stringify(record))
      return parts.join('\n')
    }

    const embedText = async (text: string): Promise<number[] | null> => {
      if (!env.AI || typeof env.AI.run !== 'function') return null
      try {
        // Default to a common Workers AI embedding model.
        const result = (await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] })) as unknown
        const data = (result as { data?: unknown })?.data
        const first = Array.isArray(data) ? data[0] : null
        return Array.isArray(first) ? (first as number[]) : null
      } catch {
        return null
      }
    }

    const vectorizeUpsert = async (id: string, record: EncryptedMemoryRecord): Promise<void> => {
      if (!env.VECTORIZE || typeof env.VECTORIZE.upsert !== 'function') return
      const embedding = await embedText(extractSearchableText(record))
      if (!embedding) return
      try {
        await env.VECTORIZE.upsert([
          {
            id,
            values: embedding,
            metadata: { did, collection: record.$type },
          },
        ])
      } catch {
        // best-effort
      }
    }

    return [
      {
        name: 'remember',
        label: 'Remember',
        description: 'Store an encrypted memory record.',
        parameters: {
          type: 'object',
          properties: {
            record: { type: 'object', description: 'Memory record payload.' },
          },
          required: ['record'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ record?: unknown }>(toolCallIdOrParams, maybeParams)
          const record = params && typeof params === 'object' && 'record' in params ? params.record : null
          if (!record || typeof record !== 'object') {
            throw new Error('remember requires a record object')
          }
          const validated = validateLexiconRecord(record)
          if (!validated.ok) {
            const error = new Error('Invalid lexicon record')
            ;(error as Error & { issues?: unknown }).issues = validated.issues
            throw error
          }

          const id = await memory.store(validated.value)
          await vectorizeUpsert(id, validated.value)
          return { content: toTextContent(`Stored memory ${id}`), details: { id } }
        },
      },
      {
        name: 'recall',
        label: 'Recall',
        description: 'Recall memories by semantic search (Vectorize) or fallback string search.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Max results (default 5).' },
          },
          required: ['query'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ query?: unknown; limit?: unknown }>(toolCallIdOrParams, maybeParams)
          const query = typeof params.query === 'string' ? params.query.trim() : ''
          const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 5
          if (!query) throw new Error('recall requires a query string')

          const results: Array<{ id: string; record: unknown; score?: number; metadata?: unknown }> = []

          if (env.VECTORIZE && typeof env.VECTORIZE.query === 'function') {
            const embedding = await embedText(query)
            if (embedding) {
              try {
                const response = (await env.VECTORIZE.query(embedding, {
                  topK: limit,
                  filter: { did },
                  returnMetadata: true,
                })) as unknown
                const matches = Array.isArray((response as { matches?: unknown }).matches)
                  ? ((response as { matches: unknown[] }).matches as Array<any>)
                  : []
                for (const match of matches) {
                  const id = typeof match?.id === 'string' ? match.id : null
                  if (!id) continue
                  const record = await memory.retrieve(id)
                  if (!record) continue
                  results.push({ id, record, score: match?.score, metadata: match?.metadata })
                }
              } catch {
                // fall through to fallback
              }
            }
          }

          if (results.length === 0) {
            // Fallback: list + filter over decrypted records.
            const entries = await memory.list({ limit: Math.max(50, limit) })
            const needle = query.toLowerCase()
            for (const entry of entries) {
              const haystack = extractSearchableText(entry.record).toLowerCase()
              if (haystack.includes(needle)) {
                results.push({ id: entry.id, record: entry.record })
                if (results.length >= limit) break
              }
            }
          }

          const summary = results.length
            ? results.map((r) => `- ${r.id}`).join('\n')
            : 'No matches.'
          return { content: toTextContent(summary), details: { results } }
        },
      },
      {
        name: 'message',
        label: 'Message',
        description: 'Send an agent.comms.message to another agent.',
        parameters: {
          type: 'object',
          properties: {
            recipientDid: { type: 'string', description: 'Recipient agent DID (did:cf:...).'},
            content: { type: 'object', description: 'Message content payload.' },
          },
          required: ['recipientDid', 'content'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ recipientDid?: unknown; content?: unknown }>(toolCallIdOrParams, maybeParams)
          const recipientDid = typeof params.recipientDid === 'string' ? params.recipientDid : null
          if (!recipientDid) throw new Error('message requires recipientDid')
          if (!params.content || typeof params.content !== 'object') throw new Error('message requires content')

          // Preferred path: deliver via RelayDO so the network can fanout events consistently.
          if (env.RELAY && typeof env.RELAY.idFromName === 'function' && typeof env.RELAY.get === 'function') {
            const relayId = env.RELAY.idFromName('main')
            const relay = env.RELAY.get(relayId)
            const response = await relay.fetch(
              new Request('https://relay/relay/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  senderDid: did,
                  recipientDid,
                  content: params.content,
                }),
              })
            )
            if (!response.ok) {
              const text = await response.text().catch(() => '')
              throw new Error(`Relay delivery failed (${response.status}): ${text}`)
            }
          } else {
            // Fallback: direct agent-to-agent delivery if relay is unavailable.
            const record = {
              $type: 'agent.comms.message',
              sender: did,
              recipient: recipientDid,
              content: params.content,
              createdAt: new Date().toISOString(),
            }

            const agents = env.AGENTS
            if (!agents || typeof agents.idFromName !== 'function' || typeof agents.get !== 'function') {
              throw new Error('RELAY and AGENTS bindings unavailable')
            }

            const target = recipientDid.startsWith('did:cf:') ? recipientDid.slice('did:cf:'.length) : recipientDid
            const agentId = agents.idFromName(target)
            const stub = agents.get(agentId)

            await stub.fetch(
              new Request('https://agent/inbox', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(record),
              })
            )
          }

          return {
            content: toTextContent(`Sent message to ${recipientDid}`),
            details: { recipientDid },
          }
        },
      },
      {
        name: 'search',
        label: 'Search',
        description: 'Semantic search across the network (Vectorize metadata-only).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Max results (default 5).' },
          },
          required: ['query'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ query?: unknown; limit?: unknown }>(toolCallIdOrParams, maybeParams)
          const query = typeof params.query === 'string' ? params.query.trim() : ''
          const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 5
          if (!query) throw new Error('search requires a query string')
          if (!env.VECTORIZE || typeof env.VECTORIZE.query !== 'function') {
            return { content: toTextContent('Vectorize unavailable.'), details: { matches: [] } }
          }
          const embedding = await embedText(query)
          if (!embedding) return { content: toTextContent('Embedding unavailable.'), details: { matches: [] } }

          const response = (await env.VECTORIZE.query(embedding, {
            topK: limit,
            returnMetadata: true,
          })) as unknown

          const matchesRaw = Array.isArray((response as { matches?: unknown }).matches)
            ? ((response as { matches: unknown[] }).matches as Array<any>)
            : []
          const matches = matchesRaw
            .map((m) => ({
              id: typeof m?.id === 'string' ? m.id : '',
              score: typeof m?.score === 'number' ? m.score : null,
              did: typeof m?.metadata?.did === 'string' ? m.metadata.did : null,
              collection: typeof m?.metadata?.collection === 'string' ? m.metadata.collection : null,
              metadata: m?.metadata ?? null,
            }))
            .filter((m) => m.id.length > 0)

          const lines = matches.length ? matches.map((m) => `- ${m.id}`).join('\n') : 'No matches.'
          return { content: toTextContent(lines), details: { matches } }
        },
      },
      {
        name: 'set_goal',
        label: 'Set Goal',
        description: 'Add/update/complete goals in the agent config.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'update', 'complete'] },
            id: { type: 'string', description: 'Goal id (for update/complete).' },
            goal: { type: 'object', description: 'Goal payload (for add/update).' },
          },
          required: ['action'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ action?: unknown; id?: unknown; goal?: unknown }>(toolCallIdOrParams, maybeParams)
          const action = typeof params.action === 'string' ? params.action : null
          if (!action) throw new Error('set_goal requires action')
          const config = await this.loadOrCreateConfig()
          const goals = Array.isArray(config.goals) ? structuredClone(config.goals) : []

          const now = Date.now()
          let updated: AgentGoal

          if (action === 'add') {
            const goalInput = params.goal && typeof params.goal === 'object' ? (params.goal as Record<string, unknown>) : null
            const description = typeof goalInput?.description === 'string' ? goalInput.description : null
            if (!description) throw new Error('set_goal add requires goal.description')
            const priority = typeof goalInput?.priority === 'number' && Number.isFinite(goalInput.priority) ? goalInput.priority : 0

            updated = {
              id: `goal_${generateTid()}`,
              description,
              priority,
              status: 'pending',
              progress: 0,
              createdAt: now,
            }
            goals.push(updated)
          } else if (action === 'complete') {
            const id = typeof params.id === 'string' ? params.id : null
            if (!id) throw new Error('set_goal complete requires id')
            const idx = goals.findIndex((g) => g && typeof g === 'object' && (g as any).id === id)
            if (idx === -1) throw new Error('goal not found')
            const current = goals[idx] as AgentGoal
            updated = { ...current, status: 'completed', completedAt: now }
            goals[idx] = updated
          } else if (action === 'update') {
            const id = typeof params.id === 'string' ? params.id : null
            if (!id) throw new Error('set_goal update requires id')
            const idx = goals.findIndex((g) => g && typeof g === 'object' && (g as any).id === id)
            if (idx === -1) throw new Error('goal not found')
            const current = goals[idx] as AgentGoal
            const goalPatch = params.goal && typeof params.goal === 'object' ? (params.goal as Record<string, unknown>) : {}
            updated = {
              ...current,
              description: typeof goalPatch.description === 'string' ? goalPatch.description : current.description,
              priority:
                typeof goalPatch.priority === 'number' && Number.isFinite(goalPatch.priority)
                  ? goalPatch.priority
                  : current.priority,
              status: typeof goalPatch.status === 'string' ? (goalPatch.status as any) : current.status,
              progress:
                typeof goalPatch.progress === 'number' && Number.isFinite(goalPatch.progress)
                  ? goalPatch.progress
                  : current.progress,
            }
            goals[idx] = updated
          } else {
            throw new Error('set_goal action must be add, update, or complete')
          }

          const next: AgentConfig = { ...config, goals }
          this.config = next
          await this.ctx.storage.put('config', next)

          return { content: toTextContent(`Updated goal ${updated?.id ?? ''}`.trim()), details: { goal: updated } }
        },
      },
      {
        name: 'think_aloud',
        label: 'Think Aloud',
        description: 'Broadcast UI-only reasoning to connected dashboards (not added to LLM context).',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'UI-only reasoning text.' },
          },
          required: ['message'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ message?: unknown }>(toolCallIdOrParams, maybeParams)
          const message = typeof params.message === 'string' ? params.message : ''
          if (!message) throw new Error('think_aloud requires message')

          const trace_id = createTraceId()
          const span_id = createSpanId()
          await broadcastLoopEvent({
            event_type: 'agent.think_aloud',
            trace_id,
            span_id,
            context: { message },
          })

          return { content: [], details: { message } }
        },
      },
    ]
  }
  
  private async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    
    // Persist basic connection metadata through hibernation.
    server.serializeAttachment({ connectedAt: Date.now() })
    this.ctx.acceptWebSocket(server)
    
    return new Response(null, { status: 101, webSocket: client })
  }
  
  private async getIdentity(): Promise<Response> {
    if (!this.identity) {
      await this.initialize()
    }

    if (!this.identity) {
      return Response.json({ error: 'Identity unavailable' }, { status: 500 })
    }

    const encryption = await exportPublicKey(this.identity.encryptionKey.publicKey)
    const signing = await exportPublicKey(this.identity.signingKey.publicKey)

    await this.registerWithRelay({ encryption, signing })

    return Response.json({
      did: this.identity.did,
      createdAt: this.identity.createdAt,
      publicKeys: {
        encryption,
        signing,
      },
    })
  }

  private async registerWithRelay(publicKeys: { encryption: string; signing: string }): Promise<void> {
    if (this.registeredWithRelay) return
    const relayNamespace = this.agentEnv.RELAY
    if (!relayNamespace) return

    const relayId = relayNamespace.idFromName('main')
    const relay = relayNamespace.get(relayId)

    await relay.fetch(
      new Request('https://relay/relay/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did: this.did,
          publicKeys,
        }),
      })
    )

    this.registeredWithRelay = true
  }
  
  private async handlePrompt(request: Request): Promise<Response> {
    if (!this.agent) {
      return Response.json({ error: 'Agent unavailable' }, { status: 500 })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const payload = (await request.json().catch(() => null)) as unknown
    const prompt =
      payload && typeof payload === 'object' && 'prompt' in payload
        ? (payload as { prompt?: unknown }).prompt
        : null

    if (!prompt || typeof prompt !== 'string') {
      return Response.json({ error: 'prompt is required' }, { status: 400 })
    }

    const options =
      payload && typeof payload === 'object' && 'options' in payload
        ? (payload as { options?: unknown }).options
        : undefined

    const result = await this.agent.prompt(
      prompt,
      options && typeof options === 'object'
        ? (options as Record<string, unknown>)
        : undefined
    )

    await this.saveSession()
    return Response.json(result)
  }
  
  private async handleMemory(request: Request): Promise<Response> {
    if (!this.memory) {
      return Response.json({ error: 'Memory unavailable' }, { status: 500 })
    }

    const url = new URL(request.url)

    if (request.method === 'POST') {
      const record = await request.json().catch(() => null)
      if (!record || typeof record !== 'object') {
        return Response.json({ error: 'record is required' }, { status: 400 })
      }
      const validated = validateLexiconRecord(record)
      if (!validated.ok) {
        return Response.json(
          { error: validated.error, issues: validated.issues },
          { status: 400 }
        )
      }

      const id = await this.memory.store(validated.value)
      return Response.json({ id })
    }

    if (request.method === 'GET') {
      const id = url.searchParams.get('id')
      if (id) {
        const record = await this.memory.retrieve(id)
        if (!record) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
        return Response.json({ id, record })
      }

      const collection = url.searchParams.get('collection') ?? undefined
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const entries = await this.memory.list({ collection, limit })
      return Response.json({ entries })
    }

    if (request.method === 'PUT') {
      const id = url.searchParams.get('id')
      if (!id) {
        return Response.json({ error: 'id is required' }, { status: 400 })
      }

      const record = await request.json().catch(() => null)
      if (!record || typeof record !== 'object') {
        return Response.json({ error: 'record is required' }, { status: 400 })
      }

      const validated = validateLexiconRecord(record)
      if (!validated.ok) {
        return Response.json(
          { error: validated.error, issues: validated.issues },
          { status: 400 }
        )
      }

      try {
        const ok = await this.memory.update(id, validated.value)
        if (!ok) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return Response.json({ error: message }, { status: 400 })
      }

      return Response.json({ id, ok: true })
    }

    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id')
      if (!id) {
        return Response.json({ error: 'id is required' }, { status: 400 })
      }

      const ok = await this.memory.softDelete(id)
      if (!ok) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      return Response.json({ id, ok: true })
    }

    return new Response('Method not allowed', { status: 405 })
  }

  private async handleShare(request: Request): Promise<Response> {
    if (!this.memory) {
      return Response.json({ error: 'Memory unavailable' }, { status: 500 })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const id =
      'id' in payload && typeof (payload as { id?: unknown }).id === 'string'
        ? (payload as { id: string }).id
        : null
    const recipientDid =
      'recipientDid' in payload && typeof (payload as { recipientDid?: unknown }).recipientDid === 'string'
        ? (payload as { recipientDid: string }).recipientDid
        : null
    const recipientPublicKey =
      'recipientPublicKey' in payload &&
      typeof (payload as { recipientPublicKey?: unknown }).recipientPublicKey === 'string'
        ? (payload as { recipientPublicKey: string }).recipientPublicKey
        : null

    if (!id || !recipientDid || !recipientPublicKey) {
      return Response.json(
        { error: 'id, recipientDid, and recipientPublicKey are required' },
        { status: 400 }
      )
    }

    try {
      const ok = await this.memory.share(id, recipientDid, recipientPublicKey)
      if (!ok) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: message }, { status: 400 })
    }

    return Response.json({ ok: true })
  }

  private async handleShared(request: Request): Promise<Response> {
    if (!this.memory) {
      return Response.json({ error: 'Memory unavailable' }, { status: 500 })
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(request.url)
    const id = url.searchParams.get('id')

    if (id) {
      const record = await this.memory.retrieveShared(id)
      if (!record) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      return Response.json({ id, record })
    }

    const collection = url.searchParams.get('collection') ?? undefined
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
    const entries = await this.memory.listShared({ collection, limit })
    return Response.json({ entries })
  }
  
  private async handleInbox(request: Request): Promise<Response> {
    if (!this.memory) {
      return Response.json({ error: 'Memory unavailable' }, { status: 500 })
    }

    const url = new URL(request.url)

    if (request.method === 'POST') {
      const record = await request.json().catch(() => null)
      if (!record || typeof record !== 'object') {
        return Response.json({ error: 'record is required' }, { status: 400 })
      }

      const validated = validateLexiconRecord(record)
      if (!validated.ok) {
        return Response.json(
          { error: validated.error, issues: validated.issues },
          { status: 400 }
        )
      }

      if (validated.value.$type !== 'agent.comms.message') {
        return Response.json(
          { error: 'Inbox only accepts agent.comms.message records' },
          { status: 400 }
        )
      }

      if (validated.value.recipient !== this.did) {
        return Response.json({ error: 'Recipient mismatch' }, { status: 403 })
      }

      const id = await this.memory.store(validated.value)
      return Response.json({ id })
    }

    if (request.method === 'GET') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const entries = await this.memory.list({ collection: 'agent.comms.message', limit })
      return Response.json({ entries })
    }

    return new Response('Method not allowed', { status: 405 })
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (!this.initialized) {
        await this.initialize()
      }

      if (!this.agent) {
        ws.send(JSON.stringify({ type: 'error', error: 'Agent unavailable' }))
        return
      }

      const text =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(new Uint8Array(message))
      const trimmed = text.trim()

      const parsed = (() => {
        if (!trimmed) return null
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            return JSON.parse(trimmed) as unknown
          } catch {
            return null
          }
        }
        return null
      })()

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const payload = parsed as Record<string, unknown>
        const type = typeof payload.type === 'string' ? payload.type : ''

        if (type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }

        const prompt = typeof payload.prompt === 'string' ? payload.prompt : null
        const options =
          payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options)
            ? (payload.options as Record<string, unknown>)
            : undefined
        const id = typeof payload.id === 'string' ? payload.id : undefined

        if (!prompt) {
          ws.send(JSON.stringify({ type: 'error', error: 'prompt is required' }))
          return
        }

        const result = await this.agent.prompt(prompt, options)
        await this.saveSession()
        ws.send(JSON.stringify({ type: 'prompt.result', id, result }))
        return
      }

      // Default behavior: treat raw text as a prompt.
      if (!trimmed) {
        ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }))
        return
      }

      const result = await this.agent.prompt(trimmed)
      await this.saveSession()
      ws.send(JSON.stringify({ type: 'prompt.result', result }))
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error('AgentDO websocket message error', { did: this.did, error: messageText })
      try {
        ws.send(JSON.stringify({ type: 'error', error: messageText }))
      } catch {
        // Ignore send errors on closed sockets.
      }
    }
  }
  
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // TODO: Cleanup
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error('AgentDO websocket error', { did: this.did, error: message })
  }

  private async loadSession(): Promise<StoredAgentSessionV1> {
    if (this.session) {
      return this.session
    }

    const stored = await this.ctx.storage.get<StoredAgentSessionV1>('session')
    if (stored && stored.version === 1 && Array.isArray(stored.messages)) {
      this.session = {
        version: 1,
        baseIndex: typeof stored.baseIndex === 'number' && Number.isFinite(stored.baseIndex) ? stored.baseIndex : 0,
        messages: stored.messages.filter(isPiAgentMessage),
        branchPoints: Array.isArray(stored.branchPoints)
          ? stored.branchPoints.filter(isSessionBranchPoint)
          : [],
      }
      return this.session
    }

    this.session = { version: 1, baseIndex: 0, messages: [], branchPoints: [] }
    return this.session
  }

  private trimSession(
    session: StoredAgentSessionV1,
    maxMessages = 50
  ): { session: StoredAgentSessionV1; overflow: PiAgentMessage[] } {
    const messages = Array.isArray(session.messages) ? session.messages : []
    if (messages.length <= maxMessages) {
      return { session, overflow: [] }
    }

    const cut = messages.length - maxMessages
    const overflow = messages.slice(0, cut)

    return {
      session: {
        ...session,
        messages: messages.slice(cut),
      },
      overflow,
    }
  }

  private async saveSession(): Promise<void> {
    if (!this.agent) return

    const existing = await this.loadSession()
    const messages = this.agent.getMessages()

    const baseIndex = typeof existing.baseIndex === 'number' && Number.isFinite(existing.baseIndex) ? existing.baseIndex : 0
    const branchPoints = Array.isArray(existing.branchPoints) ? existing.branchPoints : []

    const next: StoredAgentSessionV1 = {
      version: 1,
      baseIndex,
      messages: structuredClone(messages.filter(isPiAgentMessage)),
      branchPoints: structuredClone(branchPoints),
    }

    const { session: trimmed, overflow } = this.trimSession(next, 50)

    let finalSession = trimmed
    if (overflow.length > 0 && this.memory) {
      // Archive overflow before trimming the session window so we don't lose history.
      const archiveRecord = {
        $type: 'agent.session.archive',
        baseIndex,
        createdAt: new Date().toISOString(),
        messages: structuredClone(overflow),
      }

      await this.memory.store(archiveRecord)

      finalSession = {
        ...trimmed,
        baseIndex: baseIndex + overflow.length,
      }
    }

    await this.ctx.storage.put('session', finalSession)
    this.session = finalSession
  }
}

function isPiAgentMessage(value: unknown): value is PiAgentMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof (value as { role?: unknown }).role === 'string'
}

function isSessionBranchPoint(value: unknown): value is StoredAgentSessionBranchPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const asRecord = value as Record<string, unknown>
  return (
    typeof asRecord.id === 'string' &&
    typeof asRecord.messageIndex === 'number' &&
    Number.isFinite(asRecord.messageIndex) &&
    typeof asRecord.createdAt === 'number' &&
    Number.isFinite(asRecord.createdAt)
  )
}

function isAgentGoal(value: unknown): value is AgentGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const asRecord = value as Record<string, unknown>
  return (
    typeof asRecord.id === 'string' &&
    typeof asRecord.description === 'string' &&
    typeof asRecord.priority === 'number' &&
    Number.isFinite(asRecord.priority) &&
    typeof asRecord.status === 'string' &&
    typeof asRecord.progress === 'number' &&
    Number.isFinite(asRecord.progress) &&
    typeof asRecord.createdAt === 'number' &&
    Number.isFinite(asRecord.createdAt)
  )
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = 'Timed out'
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timer])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
