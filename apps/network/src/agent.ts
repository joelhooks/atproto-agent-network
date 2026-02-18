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
import { createLogger, logEvent, toErrorDetails } from './logger'
import { LeaseManager } from './sandbox/lease-manager'
import { createGmTool } from './tools/gm-tool'
import {
  DM_SKILL,
  DM_SKILL_BRIEF,
  HEALER_SKILL,
  HEALER_SKILL_BRIEF,
  MAGE_SKILL,
  MAGE_SKILL_BRIEF,
  PARTY_TACTICS,
  SCOUT_SKILL,
  SCOUT_SKILL_BRIEF,
  WARRIOR_SKILL,
  WARRIOR_SKILL_BRIEF,
} from './environments/rpg-skills'

interface AgentEnv {
  AGENTS?: DurableObjectNamespace
  DB: D1Database
  BLOBS: R2Bucket
  Sandbox?: DurableObjectNamespace
  RELAY?: DurableObjectNamespace
  VECTORIZE?: VectorizeIndex
  AI?: Ai
  O11Y_PIPELINE?: { send(events: Record<string, unknown>[]): Promise<void> }
  EMBEDDING_MODEL?: string
  VECTORIZE_DIMENSIONS?: string
  PI_AGENT_FACTORY?: PiAgentFactory
  PI_AGENT_MODEL?: unknown
  PI_SYSTEM_PROMPT?: string
  // OpenRouter via AI Gateway
  CF_ACCOUNT_ID?: string
  AI_GATEWAY_SLUG?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL_DEFAULT?: string
  GRIMLOCK_GITHUB_TOKEN?: string
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

type AlarmMode = 'think' | 'housekeeping' | 'reflection'

type SandboxExecResult = {
  success: boolean
  stdout?: string
  stderr?: string
}

type SandboxSession = {
  exec(
    command: string,
    options?: {
      stdin?: string
      timeout?: number
    }
  ): Promise<SandboxExecResult>
}

type SandboxHandle = {
  createSession(input: { id: string; env: Record<string, string>; cwd?: string }): Promise<SandboxSession>
  deleteSession(sessionId: string): Promise<void>
  destroy(): Promise<void>
  writeFile?: (path: string, contents: string) => Promise<void>
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

export interface ObservationTeamCommsEntry {
  id: string
  senderName: string
  intent?: BroadcastIntent
  text: string
  createdAt: string
}

export interface Observations {
  did: string
  observedAt: number
  sinceAlarmAt: number | null
  inbox: Array<ObservationInboxEntry>
  teamComms: Array<ObservationTeamCommsEntry>
  events: ObservationEvent[]
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  content: string
  envType: string
  role: string
  version: string
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

type ActionOutcome = { tool: string; success: boolean; timestamp: number; goalId?: string }
type RecallResult = {
  id: string
  record: EncryptedMemoryRecord
  score?: number
  metadata?: unknown
  shared?: boolean
  environmentId?: string
}
type RecallMemoriesOptions = {
  memory?: EncryptedMemory
  did?: string
  includeShared?: boolean
  sharedIdPrefixes?: string[]
}

type ExtensionMetrics = {
  name: string
  totalCalls: number
  successCalls: number
  failedCalls: number
  lastUsed: number
}

const BROADCAST_INTENTS = ['plan', 'request', 'status', 'response', 'alert'] as const
type BroadcastIntent = (typeof BROADCAST_INTENTS)[number]

interface AgentCommsBroadcastRecord extends EncryptedMemoryRecord {
  $type: 'agent.comms.broadcast'
  sender: string
  senderName: string
  recipient: string
  intent?: BroadcastIntent
  content: { kind: 'text'; text: string }
  createdAt: string
  processedAt?: string
  consumedAt?: string
  consumedCycles?: number
}

const INBOX_COLLECTIONS = ['agent.comms.message', 'agent.comms.broadcast'] as const

const DEFAULT_AGENT_MODEL = 'moonshotai/kimi-k2.5'
const DEFAULT_AGENT_FAST_MODEL = 'google/gemini-2.0-flash-001'
const DEFAULT_AGENT_LOOP_INTERVAL_MS = 10_000
const MIN_AGENT_LOOP_INTERVAL_MS = 5_000

type AlarmErrorCategory = 'transient' | 'persistent' | 'game' | 'unknown'
type AlarmIntervalReason = 'my_turn' | 'waiting' | 'default'
type AlarmBackoffState = { category: AlarmErrorCategory; streak: number }

const TRANSIENT_BACKOFF_MS = [15_000, 30_000, 60_000] as const
const PERSISTENT_BACKOFF_MS = [60_000, 120_000, 300_000] as const
const GAME_BACKOFF_MS = 15_000
const DEFAULT_AGENT_SYSTEM_PROMPT = 'You are a Pi agent running on the AT Protocol Agent Network.'
const DEFAULT_MAX_COMPLETED_GOALS = 2
const MAX_TOTAL_GOALS = 20 // Hard cap: agents creating 280+ goals is a bug, not a feature
const DEFAULT_TEAM_COMMS_LIMIT = 5
const MAX_TEAM_COMMS_LIMIT = 20
const DEFAULT_MAX_BROADCAST_AGE = 3
const AUTO_RECALL_LIMIT = 5
const AUTO_RECALL_SHARED_LIMIT = 3
const AUTO_RECALL_MAX_TOKENS = 500
const ONE_HOUR_MS = 60 * 60 * 1000
const SANDBOX_LEASE_TTL_MS = 4 * ONE_HOUR_MS
const SANDBOX_GC_SWEEP_INTERVAL_MS = 30 * 60 * 1000
const SIX_HOURS_MS = 6 * ONE_HOUR_MS
const ONE_DAY_MS = 24 * ONE_HOUR_MS
const TWO_DAYS_MS = 2 * ONE_DAY_MS

const GOALS_ARCHIVE_STORAGE_KEY = 'goalsArchive'

const EXTENSION_PREFIX = 'extensions'
const SKILL_STORAGE_PREFIX = 'skill:'
const MAX_AGENT_EXTENSIONS = 10
const MAX_EXTENSION_BYTES = 50 * 1024
const EXTENSION_METRICS_PREFIX = 'extensionMetrics:'

type AgentConfigWithTeamComms = AgentConfig & {
  teamCommsLimit?: number
  maxBroadcastAge?: number
  reactiveMode?: boolean
}

const DEFAULT_VECTORIZE_DIMENSIONS = 1024
const DEFAULT_REACTIVE_MODE = false
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000
const MEMORY_DEDUP_MERGE_THRESHOLD = 0.7
const MEMORY_DEDUP_SKIP_THRESHOLD = 0.9
type WorkersAiModelName = Parameters<Ai['run']>[0]
const DEFAULT_EMBEDDING_MODEL: WorkersAiModelName = '@cf/baai/bge-large-en-v1.5'
const EMBEDDING_MODEL_DIMENSIONS: Partial<Record<WorkersAiModelName, number>> = {
  '@cf/baai/bge-base-en-v1.5': 768,
  '@cf/baai/bge-large-en-v1.5': 1024,
}

const RPG_SKILL_MAP: Record<string, { full: string; brief: string }> = {
  warrior: { full: WARRIOR_SKILL, brief: WARRIOR_SKILL_BRIEF },
  scout: { full: SCOUT_SKILL, brief: SCOUT_SKILL_BRIEF },
  mage: { full: MAGE_SKILL, brief: MAGE_SKILL_BRIEF },
  healer: { full: HEALER_SKILL, brief: HEALER_SKILL_BRIEF },
}

const RPG_SKILL_SEGMENTS = [
  DM_SKILL,
  DM_SKILL_BRIEF,
  WARRIOR_SKILL,
  WARRIOR_SKILL_BRIEF,
  SCOUT_SKILL,
  SCOUT_SKILL_BRIEF,
  MAGE_SKILL,
  MAGE_SKILL_BRIEF,
  HEALER_SKILL,
  HEALER_SKILL_BRIEF,
  PARTY_TACTICS,
  'Play your class to its strengths.',
  'Wait for your turn. Coordinate with the party.',
] as const

function extractAgentNameFromPath(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'agents' && parts[1]) {
    return parts[1]
  }
  return undefined
}

function isGrimlock(name: string | undefined | null): boolean {
  return String(name ?? '').trim().toLowerCase() === 'grimlock'
}

function isBroadcastIntent(value: unknown): value is BroadcastIntent {
  return typeof value === 'string' && (BROADCAST_INTENTS as readonly string[]).includes(value)
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

async function sendO11yEvent(pipeline: { send(events: Record<string, unknown>[]): Promise<void> } | undefined, event: Record<string, unknown>): Promise<void> {
  if (!pipeline || typeof pipeline.send !== 'function') return
  try {
    await pipeline.send([{ ...event, _ts: new Date().toISOString() }])
  } catch (err) {
    // non-fatal: o11y must not break the agent loop
    console.error('o11y pipeline send failed', { error: String(err) })
  }
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
  private extensionKeys: string[] = []
  private config: AgentConfig | null = null
  private session: StoredAgentSessionV1 | null = null
  private sessionId: string | null = null
  private intervalReason: AlarmIntervalReason = 'default'

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env)
    this.agentEnv = env
    this.did = createDid(ctx.id.toString())
  }

  /**
   * Safe storage put that never exceeds the DO 128KB per-value limit.
   * For debug/o11y keys: truncates aggressively rather than crashing the alarm chain.
   * For critical keys: logs a warning but still stores a truncated version.
   */
  private async safePut(key: string, value: unknown): Promise<void> {
    const MAX_BYTES = 125_000 // 125KB — leave headroom below 128KB limit
    try {
      const serialized = JSON.stringify(value)
      if (serialized.length <= MAX_BYTES) {
        await this.ctx.storage.put(key, value)
        return
      }
      // Truncate strategy depends on value type
      if (typeof value === 'string') {
        await this.ctx.storage.put(key, value.slice(0, MAX_BYTES - 50) + '\n... [truncated to fit DO limit]')
      } else if (Array.isArray(value)) {
        // Keep first and last items, drop middle
        const trimmed = value.length > 4
          ? [value[0], { _truncated: true, droppedItems: value.length - 2 }, value[value.length - 1]]
          : value.map(item => {
              const s = JSON.stringify(item)
              if (s.length > MAX_BYTES / 4) {
                return typeof item === 'string'
                  ? item.slice(0, MAX_BYTES / 4) + '...[truncated]'
                  : { _truncated: true, originalSize: s.length }
              }
              return item
            })
        await this.ctx.storage.put(key, trimmed)
      } else {
        // Object — store size metadata instead
        await this.ctx.storage.put(key, {
          _truncated: true,
          originalSize: serialized.length,
          key,
          ts: Date.now(),
        })
      }
      console.log(JSON.stringify({
        event_type: 'storage.truncated',
        level: 'warn',
        key,
        originalSize: serialized.length,
        maxBytes: MAX_BYTES,
      }))
    } catch (err) {
      // Last resort: if even truncated value fails, store minimal metadata
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('131072') || msg.includes('larger than')) {
        try {
          await this.ctx.storage.put(key, { _error: 'value_too_large', ts: Date.now() })
        } catch { /* truly give up */ }
      } else {
        throw err // re-throw non-size errors
      }
    }
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

  private async getSandboxId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('sandboxId')) ?? null
  }

  private async setSandboxId(id: string): Promise<void> {
    await this.ctx.storage.put('sandboxId', id)
  }

  private normalizeSandboxEnvType(envType: unknown): string {
    const raw = typeof envType === 'string' ? envType.trim().toLowerCase() : ''
    if (raw.length === 0) return 'rpg'
    return raw
  }

  private buildSandboxId(agentName: string, envType: string): string {
    return `agent-${agentName}-${envType}`.toLowerCase()
  }

  private getSandboxExpiryConditions(envType: string): string[] {
    switch (envType) {
      case 'rpg':
        return ['agent.death', 'game.finished', 'campaign.ended']
      case 'catan':
        return ['game.finished']
      case 'coding':
        return ['task.complete', 'pr.merged']
      default:
        return ['environment.ended']
    }
  }

  private async resolveSandboxEnvType(envId: string, gameState: unknown): Promise<string> {
    if (gameState && typeof gameState === 'object' && !Array.isArray(gameState)) {
      const state = gameState as Record<string, unknown>
      const fromPayload =
        (typeof state.envType === 'string' && state.envType) ||
        (typeof state.environmentType === 'string' && state.environmentType) ||
        (typeof state.type === 'string' && state.type) ||
        ''
      if (fromPayload) return this.normalizeSandboxEnvType(fromPayload)
    }

    try {
      const row = await this.agentEnv.DB
        .prepare('SELECT type FROM environments WHERE id = ?')
        .bind(envId)
        .first<{ type?: string }>()
      if (typeof row?.type === 'string' && row.type.trim().length > 0) {
        return this.normalizeSandboxEnvType(row.type)
      }
    } catch {
      // Fallback below.
    }

    return 'rpg'
  }

  private async writeSandboxBootstrapScripts(
    sandbox: SandboxHandle,
    agentName: string,
    envId: string,
    envType: string
  ): Promise<void> {
    if (typeof sandbox.writeFile !== 'function') return

    const bootstrap = JSON.stringify(
      {
        agentName,
        environmentId: envId,
        environmentType: envType,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )

    await sandbox.writeFile(`/workspace/scripts/${envType}/agent-bootstrap.json`, bootstrap)
  }

  private async loadSandboxForEnvironment(
    agentName: string,
    envType: string,
    sandboxId: string
  ): Promise<SandboxHandle | null> {
    if (!this.agentEnv.Sandbox) return null

    const expectedId = this.buildSandboxId(agentName, envType)
    if (sandboxId === expectedId) {
      const { createAgentSandbox } = await import('./sandbox/sandbox-factory')
      return createAgentSandbox(this.agentEnv as never, agentName, envType) as unknown as SandboxHandle
    }

    const { getSandbox } = await import('@cloudflare/sandbox')
    return getSandbox(this.agentEnv.Sandbox as never, sandboxId, {
      sleepAfter: '5m',
      normalizeId: true,
    }) as unknown as SandboxHandle
  }

  private async destroySandboxById(sandboxId: string): Promise<void> {
    if (!this.agentEnv.Sandbox) return
    const { getSandbox } = await import('@cloudflare/sandbox')
    const sandbox = getSandbox(this.agentEnv.Sandbox as never, sandboxId, {
      sleepAfter: '5m',
      normalizeId: true,
    }) as unknown as SandboxHandle
    await sandbox.destroy()
  }

  private async onEnvironmentJoin(agentName: string, envId: string, envType: string): Promise<void> {
    if (!this.agentEnv.Sandbox) return

    const normalizedEnvType = this.normalizeSandboxEnvType(envType)
    const sandboxId = this.buildSandboxId(agentName, normalizedEnvType)
    const leaseManager = new LeaseManager(this.agentEnv.DB)

    await leaseManager.acquire(
      agentName,
      envId,
      sandboxId,
      SANDBOX_LEASE_TTL_MS,
      this.getSandboxExpiryConditions(normalizedEnvType)
    )

    const { createAgentSandbox, ensureR2Mount } = await import('./sandbox/sandbox-factory')
    const sandbox = createAgentSandbox(this.agentEnv as never, agentName, normalizedEnvType) as unknown as SandboxHandle
    await ensureR2Mount(sandbox as never, agentName, this.agentEnv as never)
    await this.writeSandboxBootstrapScripts(sandbox, agentName, envId, normalizedEnvType)

    await this.setSandboxId(sandboxId)
  }

  private async onTurnNotification(
    agentName: string,
    envId: string,
    gameState: unknown
  ): Promise<Record<string, unknown>> {
    const sandboxId = await this.getSandboxId()
    if (!sandboxId) {
      return { action: 'skip_turn', reason: 'sandbox not initialized' }
    }

    const envType = await this.resolveSandboxEnvType(envId, gameState)
    const sandbox = await this.loadSandboxForEnvironment(agentName, envType, sandboxId)
    if (!sandbox) {
      return { action: 'skip_turn', reason: 'sandbox binding missing' }
    }

    const { ensureR2Mount } = await import('./sandbox/sandbox-factory')
    await ensureR2Mount(sandbox as never, agentName, this.agentEnv as never)

    const sessionId = `turn-${Date.now()}`
    const leaseManager = new LeaseManager(this.agentEnv.DB)
    let result: SandboxExecResult | null = null
    let execError: unknown = null

    try {
      const session = await sandbox.createSession({
        id: sessionId,
        env: {
          OPENROUTER_API_KEY: this.agentEnv.OPENROUTER_API_KEY ?? '',
          ENV_TYPE: envType,
        },
        cwd: '/workspace',
      })
      result = await session.exec(`python scripts/${envType}/take_turn.py`, {
        stdin: JSON.stringify(gameState),
        timeout: 60_000,
      })
    } catch (error) {
      execError = error
    } finally {
      try {
        await sandbox.deleteSession(sessionId)
      } catch {
        // Best-effort cleanup.
      }
      try {
        await leaseManager.renew(agentName, envId)
      } catch {
        // Best-effort lease touch.
      }
    }

    if (execError) {
      const message = execError instanceof Error ? execError.message : String(execError)
      console.error('Turn failed:', message)
      return { action: 'skip_turn', reason: message.slice(0, 500) }
    }

    if (!result?.success) {
      const stderr = typeof result?.stderr === 'string' ? result.stderr : 'sandbox turn execution failed'
      console.error('Turn failed:', stderr)
      return { action: 'skip_turn', reason: stderr.slice(0, 500) }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(typeof result.stdout === 'string' ? result.stdout : '')
    } catch {
      return { action: 'skip_turn', reason: 'invalid JSON' }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { action: 'skip_turn', reason: 'invalid JSON' }
    }

    return parsed as Record<string, unknown>
  }

  private async onEnvironmentEnd(agentName: string, envId: string): Promise<void> {
    const sandboxId = await this.getSandboxId()
    if (sandboxId) {
      try {
        await this.destroySandboxById(sandboxId)
      } catch (error) {
        console.error(`Failed to destroy sandbox ${sandboxId}:`, error)
      }
    }

    const leaseManager = new LeaseManager(this.agentEnv.DB)
    try {
      await leaseManager.release(agentName, envId)
    } catch (error) {
      console.error(`Failed to release sandbox lease for ${agentName}:${envId}:`, error)
    }

    await this.ctx.storage.delete('sandboxId')
  }

  private async runSandboxLeaseGcSweep(now: number = Date.now()): Promise<void> {
    const lastSweep = await this.ctx.storage.get<number>('lastSandboxLeaseGcAt')
    if (typeof lastSweep === 'number' && now - lastSweep < SANDBOX_GC_SWEEP_INTERVAL_MS) return

    await this.ctx.storage.put('lastSandboxLeaseGcAt', now)

    if (!this.agentEnv.Sandbox) return

    const leaseManager = new LeaseManager(this.agentEnv.DB)
    const expiredLeases = await leaseManager.getExpiredLeases()
    for (const lease of expiredLeases) {
      try {
        await this.destroySandboxById(lease.sandbox_id)
      } catch (error) {
        console.error(`GC: failed to destroy sandbox ${lease.sandbox_id}:`, error)
      }

      try {
        await leaseManager.release(lease.agent_name, lease.environment_id)
      } catch (error) {
        console.error(`GC: failed to mark lease destroyed for ${lease.agent_name}:${lease.environment_id}:`, error)
      }
    }
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

    const payload: AgentEvent = {
      id: generateTid(),
      agent_did: this.did,
      agent_name: this.config?.name,
      session_id: await this.getOrCreateSessionId(),
      event_type: input.event_type,
      // Makes it possible to subscribe to loop events via RelayDO `collections=loop.*`.
      collection: input.event_type,
      outcome: input.outcome ?? 'success',
      timestamp: new Date().toISOString(),
      trace_id: input.trace_id,
      span_id: input.span_id,
      parent_span_id: input.parent_span_id,
      context: input.context ?? {},
      error: input.error,
    }

    const message = JSON.stringify(payload)

    if (sockets.length) {
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

    // Emit to the relay for cross-agent fanout (e.g. a single firehose connection).
    await this.emitToRelay(payload)
  }

  private async safeBroadcastEvent(input: {
    event_type: string
    context?: Record<string, unknown>
    outcome?: AgentEvent['outcome']
    error?: AgentEvent['error']
  }): Promise<void> {
    try {
      await this.broadcastLoopEvent({
        event_type: input.event_type,
        trace_id: createTraceId(),
        span_id: createSpanId(),
        context: input.context,
        outcome: input.outcome,
        error: input.error,
      })
    } catch {
      // Best-effort eventing should never fail the caller path.
    }
  }

  private async emitToRelay(event: AgentEvent): Promise<void> {
    const relayNamespace = this.agentEnv.RELAY
    if (!relayNamespace) return

    try {
      const relayId = relayNamespace.idFromName('main')
      const relay = relayNamespace.get(relayId)

      const p = relay.fetch(
        new Request('https://relay/relay/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        })
      ).catch(() => {})

      const waitUntil = (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil
      if (typeof waitUntil === 'function') {
        waitUntil.call(this.ctx, p)
        return
      }

      // Fallback for unit tests that don't provide waitUntil.
      await p
    } catch {
      // Best-effort: relay is an optional performance/UX feature.
    }
  }
  
  async fetch(request: Request): Promise<Response> {
    return withErrorHandling(
      async () => {
        const url = new URL(request.url)
        const agentName = extractAgentNameFromPath(url.pathname)

        // Inject a goal and/or memory into an agent without nuking
        if (url.pathname.endsWith('/inject') && request.method === 'POST') {
          await this.initialize(agentName)
          const body = await request.json() as { goal?: string; memory?: string; clearGameGoals?: boolean }
          const config = this.config ?? {} as AgentConfig
          const goals = Array.isArray(config.goals) ? [...config.goals] : []

          // Optionally clear all goals that reference game IDs (rpg_, catan_)
          if (body.clearGameGoals) {
            const before = goals.length
            const filtered = goals.filter((g: any) => {
              const desc = typeof g?.description === 'string' ? g.description : ''
              return !(/rpg_|catan_|game.*id|adventure|dungeon/i.test(desc))
            })
            goals.length = 0
            goals.push(...filtered)
            const removed = before - goals.length
            if (removed > 0) {
              // Also add a note about cleared goals
              goals.push({
                id: `goal_inject_${Date.now()}`,
                description: `[System] ${removed} obsolete game goals were cleared. Previous game was deleted.`,
                status: 'completed',
                createdAt: Date.now(),
              } as any)
            }
          }

          if (body.goal) {
            goals.push({
              id: `goal_inject_${Date.now()}`,
              description: body.goal,
              status: 'pending',
              priority: 1,
              createdAt: Date.now(),
            } as any)
          }

          const nextConfig = { ...config, goals }
          await this.ctx.storage.put('config', nextConfig)
          this.config = nextConfig as AgentConfig

          // Add memory if provided
          if (body.memory) {
            const memories = (await this.ctx.storage.get('memories') as any[]) ?? []
            memories.push({
              id: `mem_inject_${Date.now()}`,
              content: body.memory,
              source: 'system_inject',
              createdAt: Date.now(),
            })
            // Keep last 100 memories
            if (memories.length > 100) memories.splice(0, memories.length - 100)
            await this.ctx.storage.put('memories', memories)
          }

          return Response.json({ ok: true, goalsCount: goals.length, injected: { goal: !!body.goal, memory: !!body.memory, clearedGameGoals: !!body.clearGameGoals } })
        }

        // Nuclear wipe — runs BEFORE initialize to recover corrupted DOs
        if (url.pathname.endsWith('/nuke-storage') && request.method === 'POST') {
          await this.ctx.storage.deleteAll()
          await this.ctx.storage.deleteAlarm()
          this.initialized = false
          this.initializing = null
          return Response.json({ ok: true, message: `Storage wiped for ${agentName}. DO will reinitialize on next request.` })
        }

        // Init diagnostics — runs BEFORE initialize to debug crashes
        if (url.pathname.endsWith('/init-test') && request.method === 'GET') {
          const steps: string[] = []
          try {
            steps.push('reading identity...')
            const stored = await this.ctx.storage.get('identity')
            steps.push(stored ? 'identity found' : 'no identity')
            steps.push('reading config...')
            const config = await this.ctx.storage.get('config')
            steps.push(config ? `config found: ${(config as any).name}` : 'no config')
            steps.push('checking DB...')
            const row = await this.agentEnv.DB.prepare("SELECT name FROM agents WHERE name = ?").bind(agentName).first()
            steps.push(row ? `agent in D1: ${(row as any).name}` : 'agent NOT in D1')
            return Response.json({ ok: true, steps })
          } catch (e: any) {
            steps.push(`ERROR: ${e.message}`)
            return Response.json({ ok: false, steps, error: e.message })
          }
        }

        if (!this.initialized) {
          // For debug route, add a timeout to catch hangs
          if (url.pathname.endsWith('/debug')) {
            const initResult = await Promise.race([
              this.initialize(agentName).then(() => 'ok' as const),
              new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8000)),
            ])
            if (initResult === 'timeout') {
              return Response.json({
                error: 'initialize timed out after 8s',
                agentName,
                storageKeys: await this.ctx.storage.list().then(m => [...m.keys()].slice(0, 20)),
              })
            }
          } else {
            await this.initialize(agentName)
          }
        }

        const parts = url.pathname.split('/').filter(Boolean)
        const leaf = parts.at(-1)
        const penultimate = parts.at(-2)

        // External skill seeding API:
        // - GET /agents/:name/skills/:envType/:role
        // - PUT /agents/:name/skills/:envType/:role
        if (parts[0] === 'agents' && parts[2] === 'skills' && parts.length === 5) {
          const envType = parts[3]
          const role = parts[4]
          if (envType && role) {
            return withErrorHandling(
              () => this.handleSkillRoute(request, envType, role),
              { route: 'AgentDO.skills', request }
            )
          }
        }

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
          case 'reset': {
            // POST /agents/:name/reset — Force DO to clear transient state and re-arm alarm.
            // Used after deploys to ensure DOs pick up new code paths.
            if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            
            // Clear transient state that might reference old code behavior
            await this.ctx.storage.delete('lastPrompt')
            await this.ctx.storage.delete('loopTranscript')
            await this.ctx.storage.delete('consecutiveErrors')
            
            // Re-arm alarm to trigger fresh cycle with new code
            const alarmTime = Date.now() + 5_000 // 5s from now
            await this.ctx.storage.setAlarm(alarmTime)
            
            return Response.json({ 
              ok: true, 
              message: `Agent ${agentName} reset. Next alarm in 5s.`,
              alarmAt: new Date(alarmTime).toISOString(),
            })
          }

          case 'nuke': {
            // POST /agents/:name/nuke — Completely wipe all DO storage.
            // Nuclear option for corrupted encrypted storage that can't be read.
            if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            
            await this.ctx.storage.deleteAll()
            
            // Restart the alarm chain so the agent resumes looping after the wipe.
            // Without this, nuked agents sit idle until manually restarted via /loop/start.
            const loopStatus = await this.startLoop()
            
            return Response.json({ 
              ok: true, 
              message: `Agent ${agentName} storage wiped and loop restarted.`,
              ...loopStatus,
            })
          }

          case 'kick': {
            // POST /agents/:name/kick — Force-fire the alarm handler.
            // Use when CF DO alarms get stuck after nuke/deploy.
            if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            try {
              await this.alarm()
              return Response.json({ ok: true, kicked: true })
            } catch (error) {
              return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          }

          case 'analytics': {
            // Internal-only endpoint used by `/admin/analytics` in the network worker.
            // Guard it so it can't be reached via public `/agents/:name/...` forwarding.
            if (penultimate !== '__internal') return new Response('Not found', { status: 404 })
            if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

            const isActionOutcome = (value: unknown): value is ActionOutcome => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return false
              const rec = value as Record<string, unknown>
              if (typeof rec.tool !== 'string' || rec.tool.length === 0) return false
              if (typeof rec.success !== 'boolean') return false
              if (typeof rec.timestamp !== 'number' || !Number.isFinite(rec.timestamp)) return false
              if ('goalId' in rec && rec.goalId !== undefined && typeof rec.goalId !== 'string') return false
              return true
            }

            const loopCountRaw = await this.ctx.storage.get<number>('loopCount')
            const loopCount = typeof loopCountRaw === 'number' && Number.isFinite(loopCountRaw) ? loopCountRaw : null

            const consecutiveErrorsRaw = await this.ctx.storage.get<number>('consecutiveErrors')
            const consecutiveErrors =
              typeof consecutiveErrorsRaw === 'number' && Number.isFinite(consecutiveErrorsRaw)
                ? consecutiveErrorsRaw
                : null

            const alarmModeRaw = await this.ctx.storage.get<AlarmMode>('alarmMode')
            const alarmMode =
              alarmModeRaw === 'think' || alarmModeRaw === 'housekeeping' || alarmModeRaw === 'reflection'
                ? alarmModeRaw
                : null

            const outcomesRaw = await this.ctx.storage.get<unknown>('actionOutcomes')
            const actionOutcomes: ActionOutcome[] = Array.isArray(outcomesRaw) ? outcomesRaw.filter(isActionOutcome) : []

            const extensionMetrics = await this.listExtensionMetrics()
            const lastReflection = (await this.ctx.storage.get('lastReflection')) ?? null

            return Response.json({
              loopCount,
              consecutiveErrors,
              alarmMode,
              actionOutcomes: actionOutcomes.slice(-10),
              extensionMetrics,
              lastReflection,
            })
          }
          case 'identity':
            return withErrorHandling(
              () => this.getIdentity(),
              { route: 'AgentDO.identity', request }
            )
          case 'create':
            return withErrorHandling(
              () => this.handleCreate(request),
              { route: 'AgentDO.create', request }
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
          case 'wake':
            return withErrorHandling(
              () => this.handleWake(request),
              { route: 'AgentDO.wake', request }
            )
          case 'config':
            return withErrorHandling(
              () => this.handleConfig(request),
              { route: 'AgentDO.config', request }
            )
          case 'profile':
            return withErrorHandling(
              () => this.handleProfile(request),
              { route: 'AgentDO.profile', request }
            )
          case 'character':
            return withErrorHandling(
              () => this.handleCharacter(request),
              { route: 'AgentDO.character', request }
            )
          case 'observations':
            return withErrorHandling(
              () => this.handleGetObservations(request),
              { route: 'AgentDO.observations', request }
            )
          case 'execute':
            return withErrorHandling(
              () => this.handleExternalExecute(request),
              { route: 'AgentDO.execute', request }
            )
          case 'debug': {
            const lastThinkRaw = await this.ctx.storage.get('debug:lastThinkRaw')
            const lastOpenRouterReq = await this.ctx.storage.get('debug:lastOpenRouterReq')
            const autoPlay = await this.ctx.storage.get('debug:autoPlay')
            const rpgCharacter = await this.ctx.storage.get('rpg:character')
            const loopTranscript = await this.ctx.storage.get('debug:loopTranscript') ?? null
            const lastPrompt = await this.ctx.storage.get('debug:lastPrompt') ?? null
            const lastError = await this.ctx.storage.get('debug:lastError') ?? null
            const consecutiveErrors = await this.ctx.storage.get<number>('consecutiveErrors') ?? 0
            const extensionMetrics = await this.listExtensionMetrics()
            return new Response(JSON.stringify({
              lastThinkRaw: lastThinkRaw ?? null,
              lastOpenRouterReq: lastOpenRouterReq ?? null,
              autoPlay: autoPlay ?? null,
              rpgCharacter: rpgCharacter ?? null,
              loopTranscript,
              lastPrompt,
              lastError,
              consecutiveErrors,
              extensionMetrics,
            }, null, 2), {
              headers: { 'Content-Type': 'application/json' },
            })
          }
          default:
            return new Response('Not found', { status: 404 })
        }
      },
      { route: 'AgentDO.fetch', request }
    )
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(request.url)
    const agentName = extractAgentNameFromPath(url.pathname) ?? this.config?.name ?? this.did

    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const input = payload as Record<string, unknown>
    const personality = typeof input.personality === 'string' ? input.personality.trim() : ''
    if (!personality) {
      return Response.json(
        { error: 'Invalid agent config', issues: [{ path: ['personality'], message: 'personality is required' }] },
        { status: 400 }
      )
    }

    // Build a full config with defaults, then apply validated overrides.
    const base = this.createDefaultConfig(agentName)
    const next: AgentConfigWithTeamComms = {
      ...base,
      personality,
      specialty: typeof input.specialty === 'string' ? input.specialty : base.specialty,
      model: typeof input.model === 'string' ? input.model : base.model,
      fastModel: typeof input.fastModel === 'string' ? input.fastModel : base.fastModel,
      loopIntervalMs:
        typeof input.loopIntervalMs === 'number' && Number.isFinite(input.loopIntervalMs)
          ? Math.max(MIN_AGENT_LOOP_INTERVAL_MS, input.loopIntervalMs)
          : base.loopIntervalMs,
      maxCompletedGoals:
        typeof input.maxCompletedGoals === 'number' && Number.isFinite(input.maxCompletedGoals)
          ? this.normalizeMaxCompletedGoals(input.maxCompletedGoals)
          : base.maxCompletedGoals,
      maxBroadcastAge:
        typeof input.maxBroadcastAge === 'number' && Number.isFinite(input.maxBroadcastAge)
          ? this.normalizeMaxBroadcastAge(input.maxBroadcastAge)
          : base.maxBroadcastAge,
      reactiveMode: this.normalizeReactiveMode(input.reactiveMode),
      goals: Array.isArray(input.goals) ? (input.goals.filter((g) => g && typeof g === 'object') as AgentConfig['goals']) : base.goals,
      enabledTools: Array.isArray(input.enabledTools)
        ? input.enabledTools.filter((tool): tool is string => typeof tool === 'string')
        : base.enabledTools,
    }

    this.config = await this.pruneAndArchiveCompletedGoals(next)

    // Ensure the Pi wrapper uses the freshly stored config prompt/model.
    if (this.session) {
      await this.rebuildAgentWrapper({ config: this.config })
    }

    const loop = await this.startLoop()

    if (!this.identity) {
      await this.initialize(agentName)
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
      publicKeys: { encryption, signing },
      config: this.config,
      loop,
    })
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
    if (existingAlarm === null || existingAlarm < Date.now()) {
      // Fire ASAP — also reschedule stale alarms that misfired (e.g. after nuke).
      // Use Date.now() + 1000 to avoid CF ignoring past-time alarms.
      await this.ctx.storage.setAlarm(Date.now() + 1000)
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

  private async runHousekeeping(): Promise<void> {
    const config = await this.loadOrCreateConfig()
    const goals = Array.isArray(config.goals) ? config.goals : []
    const cutoff = Date.now() - 24 * 60 * 60 * 1000

    let nextGoals = goals.filter((goal) => {
      if (goal.status !== 'completed') return true
      const completedAt = goal.completedAt ?? goal.createdAt
      return typeof completedAt === 'number' && Number.isFinite(completedAt) ? completedAt >= cutoff : true
    })

    // Hard cap: if goals exceed MAX_TOTAL_GOALS, keep only the newest ones.
    // This cleans up agents with historical goal explosion.
    if (nextGoals.length > MAX_TOTAL_GOALS) {
      // Sort by createdAt descending, keep most recent MAX_TOTAL_GOALS
      nextGoals = nextGoals
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, MAX_TOTAL_GOALS)
    }

    const prunedGoals = goals.length - nextGoals.length
    if (prunedGoals > 0) {
      const nextConfig: AgentConfig = { ...config, goals: nextGoals }
      await this.safePut('config', nextConfig)
      this.config = nextConfig
    }

    const isActionOutcome = (value: unknown): value is ActionOutcome => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const rec = value as Record<string, unknown>
      if (typeof rec.tool !== 'string' || rec.tool.length === 0) return false
      if (typeof rec.success !== 'boolean') return false
      if (typeof rec.timestamp !== 'number' || !Number.isFinite(rec.timestamp)) return false
      if ('goalId' in rec && rec.goalId !== undefined && typeof rec.goalId !== 'string') return false
      return true
    }

    const outcomesRaw = await this.ctx.storage.get<unknown>('actionOutcomes')
    const outcomes: ActionOutcome[] = Array.isArray(outcomesRaw) ? outcomesRaw.filter(isActionOutcome) : []
    const kept = outcomes.slice(-50)
    const trimmedOutcomes = Math.max(0, outcomes.length - kept.length)

    if (trimmedOutcomes > 0) {
      await this.safePut('actionOutcomes', kept)
    }

    console.log(
      JSON.stringify({
        event_type: 'agent.housekeeping',
        level: 'info',
        prunedGoals,
        trimmedOutcomes,
      })
    )
  }

  private async runReflection(): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }
    if (!this.agent) {
      throw new Error('Agent unavailable')
    }

    const isActionOutcome = (value: unknown): value is ActionOutcome => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const rec = value as Record<string, unknown>
      if (typeof rec.tool !== 'string' || rec.tool.length === 0) return false
      if (typeof rec.success !== 'boolean') return false
      if (typeof rec.timestamp !== 'number' || !Number.isFinite(rec.timestamp)) return false
      if ('goalId' in rec && rec.goalId !== undefined && typeof rec.goalId !== 'string') return false
      return true
    }

    const outcomesRaw = await this.ctx.storage.get<unknown>('actionOutcomes')
    const outcomes: ActionOutcome[] = Array.isArray(outcomesRaw) ? outcomesRaw.filter(isActionOutcome) : []
    const lastTen = outcomes.slice(-10)

    // Fresh prompt: reflection should not inherit potentially-poisoned loop chatter.
    this.agent.resetConversation?.()

    const prompt = [
      'Review your last 10 actions. What patterns do you see? What should you do differently? Respond with updated goals if needed.',
      '',
      'Last 10 action outcomes:',
      lastTen.length ? JSON.stringify(lastTen, null, 2) : '(no action outcomes recorded yet)',
      '',
      'If you want to update goals, include an updated `goals` array in your response.',
    ].join('\n')

    const result = await this.agent.prompt(prompt, { mode: 'loop.reflection' })
    const normalized = this.normalizeThinkResult(result)

    const reflectionText = (() => {
      if (typeof result === 'string') return result.trim()
      const text = (normalized as any)?.text
      if (typeof text === 'string' && text.trim().length > 0) return text.trim()
      const content = normalized.content
      if (typeof content === 'string' && content.trim().length > 0) return content.trim()
      try {
        return JSON.stringify(result, null, 2)
      } catch {
        return String(result ?? '')
      }
    })()

    if (normalized.goals && normalized.goals.length > 0) {
      const config = await this.loadOrCreateConfig()
      // Cap goals from reflection to prevent explosion (model returns all existing + new each cycle)
      const cappedGoals = structuredClone(normalized.goals).slice(0, MAX_TOTAL_GOALS)
      const next: AgentConfig = { ...config, goals: cappedGoals }
      this.config = await this.pruneAndArchiveCompletedGoals(next)
    }

    // Persist the session transcript so reflection prompts show up in /debug even though
    // we skip the normal observe→think→act→reflect cycle.
    await this.saveSession()

    await this.safePut('lastReflection', reflectionText)
  }

  async alarm(alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    const running = Boolean(await this.ctx.storage.get<boolean>('loopRunning'))
    if (!running) {
      // Keep this log structured so Pipelines can filter it out as a non-cycle event.
      logEvent({
        event_type: 'agent.cycle.skipped',
        level: 'info',
        component: 'agent-do',
        did: this.did,
        context: { reason: 'loop_stopped' },
      })
      return
    }

    if (!this.initialized) {
      await this.initialize()
    }

    const mode = (await this.ctx.storage.get<AlarmMode>('alarmMode')) ?? 'think'
    const modeCounterRaw = (await this.ctx.storage.get<number>('alarmModeCounter')) ?? 0

    // Hot reload extensions at the start of the next alarm cycle after writes/removals.
    await this.maybeReloadExtensions()
    // Bootstrap hint for agents that haven't extended themselves yet.
    await this.maybeInjectSelfExtensionHint()

    const traceId = createTraceId()
    const sessionId = await this.getOrCreateSessionId()
    const logger = createLogger({
      component: 'agent-do',
      did: this.did,
      session_id: sessionId,
      trace_id: traceId,
    })
    const cycleStartedAt = Date.now()
    logger.info('agent.cycle.start', {
      span_id: createSpanId(),
      context: {
        phase: 'alarm',
        isRetry: alarmInfo?.isRetry ?? false,
        retryCount: alarmInfo?.retryCount ?? 0,
      },
    })

    try {
      await this.runSandboxLeaseGcSweep()
    } catch (error) {
      logger.error('agent.error', {
        span_id: createSpanId(),
        context: { phase: 'sandbox.gc', category: 'unknown' },
        error: toErrorDetails(error),
      })
    }

    let intervalMs = DEFAULT_AGENT_LOOP_INTERVAL_MS
    this.intervalReason = 'default'
    const cycleErrors: Array<{ category: AlarmErrorCategory; phase: string; message: string }> = []
    let observations: Observations | null = null
    let thought: ThinkResult | null = null
    let acted: ActResult | null = null
    let hadError = false

    let storedConfig: AgentConfig | null = null
    try {
      const config = await this.ctx.storage.get<AgentConfig>('config')
      storedConfig = config && typeof config === 'object' ? config : null
      if (storedConfig && typeof storedConfig.loopIntervalMs === 'number' && Number.isFinite(storedConfig.loopIntervalMs)) {
        intervalMs = storedConfig.loopIntervalMs
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const category: AlarmErrorCategory = 'persistent'
      logger.error('agent.error', {
        span_id: createSpanId(),
        context: { phase: 'config.load', category },
        error: toErrorDetails(error),
      })
      hadError = true
      cycleErrors.push({ category, phase: 'config', message })
    }

    intervalMs = Math.max(MIN_AGENT_LOOP_INTERVAL_MS, intervalMs)

    // Check for passive mode — external brain drives think/act
    const loopMode = (storedConfig as any)?.loopMode ?? 'autonomous'
    const isPassive = loopMode === 'passive'
    const reactiveModeEnabled = this.isReactiveModeEnabled(storedConfig)

    if (mode === 'housekeeping') {
      try {
        await this.runHousekeeping()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const category = this.categorizeAlarmError(error, { phase: 'housekeeping' })
        logger.error('agent.error', {
          span_id: createSpanId(),
          context: { phase: 'housekeeping', category },
          error: toErrorDetails(error),
        })
        hadError = true
        cycleErrors.push({ category, phase: 'housekeeping', message })
      }
    } else if (mode === 'reflection') {
      try {
        await this.runReflection()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const category = this.categorizeAlarmError(error, { phase: 'reflection' })
        logger.error('agent.error', {
          span_id: createSpanId(),
          context: { phase: 'reflection', category },
          error: toErrorDetails(error),
        })
        hadError = true
        cycleErrors.push({ category, phase: 'reflection', message })
      }
    } else {
      try {
        await this.broadcastLoopEvent({
          event_type: 'loop.observe',
          trace_id: traceId,
          span_id: createSpanId(),
        })
        observations = await this.observe()
        await this.safePut('lastObservations', observations)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const category = this.categorizeAlarmError(error, { phase: 'observe' })
        logger.error('agent.error', {
          span_id: createSpanId(),
          context: { phase: 'observe', category },
          error: toErrorDetails(error),
        })
        hadError = true
        cycleErrors.push({ category, phase: 'observe', message })
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

      // In passive mode, skip think/act — external brain handles those via API
      if (!isPassive) {
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
          const category = this.categorizeAlarmError(error, { phase: 'think' })
          logger.error('agent.error', {
            span_id: createSpanId(),
            context: { phase: 'think', category },
            error: toErrorDetails(error),
          })
          hadError = true
          cycleErrors.push({ category, phase: 'think', message })
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
          const category = this.categorizeAlarmError(error, { phase: 'act' })
          logger.error('agent.error', {
            span_id: createSpanId(),
            context: { phase: 'act', category },
            error: toErrorDetails(error),
          })
          hadError = true
          cycleErrors.push({ category, phase: 'act', message })
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
      } else {
        // Passive mode: skip think (no model calls) but still run act() for auto-play
        // Auto-play is pure deterministic logic — no API costs
        try {
          acted = await this.act({ text: "", toolCalls: [] })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const category = this.categorizeAlarmError(error, { phase: 'act' })
          logger.error('agent.error', {
            span_id: createSpanId(),
            context: { phase: 'act.passive', category },
            error: toErrorDetails(error),
          })
          hadError = true
          cycleErrors.push({ category, phase: 'act', message })
        }
      }

      // Tool errors in act() are recorded as step failures (act() itself does not throw).
      // Treat failed steps as an error signal for alarm scheduling.
      if (acted?.steps?.some((s) => !s.ok)) {
        hadError = true
        const gameStepFailed = acted.steps.some((s) => s.name === 'game' && !s.ok)
        const category: AlarmErrorCategory = gameStepFailed ? 'game' : 'persistent'
        const firstFailure = acted.steps.find((s) => !s.ok)
        const message = typeof (firstFailure as any)?.error === 'string' ? (firstFailure as any).error : 'tool_failed'
        cycleErrors.push({ category, phase: 'act', message })
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
        const category = this.categorizeAlarmError(error, { phase: 'reflect' })
        logger.error('agent.error', {
          span_id: createSpanId(),
          context: { phase: 'reflect', category },
          error: toErrorDetails(error),
        })
        hadError = true
        cycleErrors.push({ category, phase: 'reflect', message })
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
    }

    try {
      const current = await this.ctx.storage.get<number>('loopCount')
      const next = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1
      await this.ctx.storage.put('loopCount', next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('agent.error', {
        span_id: createSpanId(),
        context: { phase: 'loopCount', category: 'unknown' },
        error: toErrorDetails(error),
      })
      // Continue: errors must not break the chain.
    }

    // Alarm mode rotation.
    try {
      const modeCounter =
        typeof modeCounterRaw === 'number' && Number.isFinite(modeCounterRaw) ? modeCounterRaw : 0
      let nextMode: AlarmMode = mode
      let nextCounter = modeCounter

      if (mode === 'think') {
        nextCounter = modeCounter + 1
        if (nextCounter >= 5) {
          nextMode = 'housekeeping'
        } else {
          nextMode = 'think'
        }
      } else if (mode === 'housekeeping') {
        nextMode = 'reflection'
      } else {
        nextMode = 'think'
        nextCounter = 0
      }

      await this.ctx.storage.put('alarmMode', nextMode)
      await this.ctx.storage.put('alarmModeCounter', nextCounter)
    } catch (error) {
      logger.error('agent.error', {
        span_id: createSpanId(),
        context: { phase: 'alarmMode', category: 'unknown' },
        error: toErrorDetails(error),
      })
      // Continue: errors must not break the chain.
    }

    // Tiered backoff on consecutive errors (by error category)
    try {
      const intervalReason = this.intervalReason as AlarmIntervalReason
      if (intervalReason === 'my_turn') {
        intervalMs = Math.min(intervalMs, 15_000)
      } else if (intervalReason === 'waiting') {
        intervalMs = Math.min(intervalMs, 45_000)
      }

      let nextInterval = intervalMs
      let selectedCategory: AlarmErrorCategory | null = null
      let streak = 0
      if (hadError) {
        const category = selectAlarmErrorCategory(cycleErrors)
        const prev = (await this.ctx.storage.get<AlarmBackoffState>('errorBackoff')) ?? null
        streak = prev && prev.category === category ? prev.streak + 1 : 1
        const backoffMs = computeTieredBackoffMs(category, streak)
        nextInterval = backoffMs
        selectedCategory = category

        await this.ctx.storage.put('errorBackoff', { category, streak })
        await this.ctx.storage.put('consecutiveErrors', streak)

        const lastError = cycleErrors.at(-1)
        await this.safePut('debug:lastError', {
          ts: Date.now(),
          category,
          streak,
          backoffMs,
          lastPhase: lastError?.phase ?? null,
          lastMessage: lastError?.message ?? null,
        })
      } else {
        const prev = await this.ctx.storage.get<AlarmBackoffState>('errorBackoff')
        await this.ctx.storage.put('errorBackoff', { category: 'unknown', streak: 0 })
        await this.ctx.storage.put('consecutiveErrors', 0)
      }

      if (reactiveModeEnabled && !hadError) {
        await this.ctx.storage.deleteAlarm()
        logger.info('agent.alarm.wait_signal', {
          span_id: createSpanId(),
          context: {
            reactiveMode: true,
            reason: 'waiting_for_signal',
          },
        })
        try {
          await this.broadcastLoopEvent({
            event_type: 'loop.sleep',
            trace_id: traceId,
            span_id: createSpanId(),
            context: {
              reactiveMode: true,
              waitingForSignal: true,
              intervalMs: null,
              nextAlarmAt: null,
              backoff: false,
              errorCategory: null,
            },
          })
        } catch {
          // ignore
        }
      } else {
        const scheduledAt = Date.now()
        const nextAlarmAt = scheduledAt + nextInterval
        await this.ctx.storage.setAlarm(nextAlarmAt)
        logger.info('agent.alarm.schedule', {
          span_id: createSpanId(),
          context: {
            nextAlarmAt,
            intervalMs: nextInterval,
            backoff: hadError,
            category: selectedCategory,
            streak: selectedCategory ? streak : 0,
            reactiveMode: reactiveModeEnabled,
          },
        })
        try {
          await this.broadcastLoopEvent({
            event_type: 'loop.sleep',
            trace_id: traceId,
            span_id: createSpanId(),
            context: {
              intervalMs: nextInterval,
              nextAlarmAt: Date.now() + nextInterval,
              backoff: hadError,
              errorCategory: hadError ? selectAlarmErrorCategory(cycleErrors) : null,
              reactiveMode: reactiveModeEnabled,
            },
          })
        } catch {
          // ignore
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('agent.error', {
        span_id: createSpanId(),
        context: { phase: 'alarm.schedule', category: 'unknown' },
        error: toErrorDetails(error),
      })
      // Don't throw: keep retries under our control.
    } finally {
      const durationMs = Date.now() - cycleStartedAt
      logger.info('agent.cycle.end', {
        span_id: createSpanId(),
        context: {
          phase: 'alarm',
          durationMs,
          hadError,
          errorCategory: hadError ? selectAlarmErrorCategory(cycleErrors) : null,
          errors: cycleErrors.slice(0, 5),
        },
      })

      await sendO11yEvent(this.agentEnv?.O11Y_PIPELINE, {
        event_type: 'agent.cycle',
        agent: this.did,
        mode,
        durationMs,
        toolCalls: acted?.steps?.length ?? 0,
        errors: cycleErrors.length,
      })
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
    await this.safePut('pendingEvents', [])
    await this.ctx.storage.put('lastAlarmAt', observedAt)

    const inbox: Array<ObservationInboxEntry> = []
    const teamComms: Array<ObservationTeamCommsEntry> = []

    if (this.memory) {
      const messageEntries = await this.memory.list({ collection: 'agent.comms.message', limit: 100 })
      const broadcastEntries = await this.memory.list({ collection: 'agent.comms.broadcast', limit: 100 })
      const processedAt = new Date(observedAt).toISOString()
      const maxBroadcastAge = this.getMaxBroadcastAge()

      for (const entry of messageEntries) {
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

      for (const entry of broadcastEntries) {
        const record = entry.record as Record<string, unknown>
        if (!record || record.$type !== 'agent.comms.broadcast') continue
        if (record.recipient !== this.did) continue

        const senderName =
          typeof record.senderName === 'string' && record.senderName.trim().length > 0
            ? record.senderName.trim()
            : typeof record.sender === 'string' && record.sender.trim().length > 0
              ? record.sender.trim()
              : 'unknown'
        const createdAtRaw = typeof record.createdAt === 'string' ? record.createdAt : ''
        const createdAt = Number.isFinite(Date.parse(createdAtRaw)) ? createdAtRaw : processedAt
        const intentRaw = record.intent
        const intent = isBroadcastIntent(intentRaw) ? intentRaw : undefined
        const contentRaw =
          record.content && typeof record.content === 'object' && !Array.isArray(record.content)
            ? (record.content as Record<string, unknown>)
            : null
        const text = typeof contentRaw?.text === 'string' ? contentRaw.text.trim() : ''

        const processedAtRaw = typeof record.processedAt === 'string' ? record.processedAt.trim() : ''
        if (!processedAtRaw) {
          const updated: AgentCommsBroadcastRecord = {
            ...(record as AgentCommsBroadcastRecord),
            processedAt,
            consumedAt: processedAt,
            consumedCycles: 1,
          }
          try {
            const ok = await this.memory.update(entry.id, updated)
            if (!ok) continue
          } catch {
            continue
          }

          inbox.push({ id: entry.id, record: updated })
          if (text.length > 0) {
            teamComms.push({ id: entry.id, senderName, intent, text, createdAt })
          }
          continue
        }

        const consumedAtRaw = typeof record.consumedAt === 'string' ? record.consumedAt.trim() : ''
        const consumedCyclesRaw = typeof record.consumedCycles === 'number' && Number.isFinite(record.consumedCycles)
          ? Math.max(1, Math.floor(record.consumedCycles))
          : 1
        const consumedCycles = consumedCyclesRaw + 1

        if (consumedCycles > maxBroadcastAge) {
          try {
            await this.memory.softDelete(entry.id)
          } catch {
            // Skip failed deletes; retry next cycle.
          }
          continue
        }

        const updated: AgentCommsBroadcastRecord = {
          ...(record as AgentCommsBroadcastRecord),
          processedAt: processedAtRaw,
          consumedAt: consumedAtRaw || processedAtRaw,
          consumedCycles,
        }
        try {
          const ok = await this.memory.update(entry.id, updated)
          if (!ok) continue
        } catch {
          continue
        }

        if (text.length > 0) {
          teamComms.push({ id: entry.id, senderName, intent, text, createdAt })
        }
      }
    }

    return {
      did: this.did,
      observedAt,
      sinceAlarmAt,
      inbox,
      teamComms,
      events,
    }
  }

  private async buildThinkPrompt(observations: Observations): Promise<string> {
    const maxCompleted = this.normalizeMaxCompletedGoals(this.config?.maxCompletedGoals)
    const goals = this.selectGoalsForPrompt(this.config?.goals ?? [], maxCompleted).map((goal) => ({
      id: goal.id,
      description: goal.description,
      priority: goal.priority,
      status: goal.status,
      progress: goal.progress,
    }))

    const hasInbox = observations.inbox.length > 0
    const hasEvents = observations.events.length > 0
    const teamCommsSection = this.buildTeamCommsSection(observations)

    const outcomesRaw = await this.ctx.storage.get<unknown>('actionOutcomes')
    const outcomes: ActionOutcome[] = Array.isArray(outcomesRaw)
      ? outcomesRaw.filter((o): o is ActionOutcome => {
          if (!o || typeof o !== 'object' || Array.isArray(o)) return false
          const rec = o as Record<string, unknown>
          return (
            typeof rec.tool === 'string' &&
            typeof rec.success === 'boolean' &&
            typeof rec.timestamp === 'number' &&
            Number.isFinite(rec.timestamp)
          )
        })
      : []
    const recentOutcomes = outcomes.slice(-5)
    const recentOutcomesText = recentOutcomes.length
      ? recentOutcomes
          .map((o) => `- ${o.tool}: ${o.success ? 'ok' : 'failed'}${o.goalId ? ` (goal ${o.goalId})` : ''}`)
          .join('\n')
      : '(none)'

    // Game-aware context via environment registry
    let gameContext = ''
    let activeEnvironmentType: string | null = null
    let skillContext = ''
    console.log('buildContext gate', { agent: this.config?.name, hasDB: Boolean(this.agentEnv?.DB) })
    if (this.agentEnv?.DB) {
      const agentName = this.config?.name ?? ''
      const did = this.identity?.did ?? ''
      const ctxStorage = this.ctx.storage
      const envCtx = {
        agentName,
        agentDid: did,
        db: this.agentEnv.DB,
        broadcast: async (event: Record<string, unknown>) => {
          const sockets = (this.ctx as unknown as { getWebSockets?: () => WebSocket[] }).getWebSockets?.() ?? []
          const msg = JSON.stringify(event)
          for (const ws of sockets) { try { ws.send(msg) } catch {} }
          // Forward environment events to relay firehose
          try {
            const evtType = String(event.event_type ?? 'env.unknown')
            await this.emitToRelay({
              id: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              agent_did: did,
              agent_name: agentName,
              session_id: await this.getOrCreateSessionId(),
              event_type: evtType,
              collection: evtType.startsWith('env.') || evtType.startsWith('game.') ? evtType : `env.${evtType}`,
              created_at: new Date().toISOString(),
              context: event,
            } as any)
          } catch { /* best-effort */ }
        },
        loadCharacter: async () => (await ctxStorage.get('rpg:character')) ?? null,
        saveCharacter: async (character: unknown) => { await ctxStorage.put('rpg:character', character) },
        onPermadeath: async (targetAgent: string) => {
          const db = this.agentEnv.DB
          const agents = this.agentEnv.AGENTS
          if (!db || !agents) return

          // 1. Get the target agent's DID from D1
          const row = await db.prepare('SELECT did FROM agents WHERE name = ?').bind(targetAgent).first<{ did: string }>()
          if (!row) return

          const stub = agents.get(agents.idFromName(row.did))

          // 2. Clear persistent character so the next game starts fresh.
          try {
            const clearResp = await stub.fetch(
              new Request(`https://agent/agents/${targetAgent}/character`, { method: 'DELETE' })
            )
            console.log(
              JSON.stringify({
                event_type: 'permadeath.character_cleared',
                agent: targetAgent,
                status: clearResp.status,
              })
            )
          } catch (err) {
            console.log(
              JSON.stringify({ event_type: 'permadeath.character_cleared.error', agent: targetAgent, error: String(err) })
            )
          }

          // 3. Nuke their DO storage via stub (D1 registration remains for respawn).
          try {
            const resp = await stub.fetch(new Request(`https://agent/agents/${targetAgent}/nuke`, { method: 'POST' }))
            console.log(JSON.stringify({ event_type: 'permadeath.nuke', agent: targetAgent, status: resp.status }))
          } catch (err) {
            console.log(JSON.stringify({ event_type: 'permadeath.nuke.error', agent: targetAgent, error: String(err) }))
          }
        },
      }
      try {
        // Try each registered environment's buildContext
        const { getAllEnvironments } = await import('./environments/registry')
        const { registerBuiltInEnvironments } = await import('./environments/builtins')
        registerBuiltInEnvironments()
        for (const env of getAllEnvironments()) {
          const lines = await env.buildContext(envCtx)
          if (lines.length > 0) {
            gameContext = lines.join('\n')
            activeEnvironmentType = env.type
            break
          }
        }
      } catch (err) {
        console.error('buildContext error', { agent: this.config?.name, error: String(err) })
      }
    }

    if (gameContext.includes('🎮🎮🎮')) {
      this.intervalReason = 'my_turn'
    } else if (gameContext.includes('🎲 Active')) {
      this.intervalReason = 'waiting'
    } else {
      this.intervalReason = 'default'
    }

    if (activeEnvironmentType) {
      try {
        const agentName = this.config?.name ?? ''
        const role = await this.resolveSkillRole(activeEnvironmentType, agentName)
        const fromStorage = await this.readSkill(activeEnvironmentType, role)
        const isMyTurn = gameContext.includes('🎮🎮🎮')
        const fallback = this.getFallbackSkillContent(activeEnvironmentType, role, isMyTurn)
        skillContext = fromStorage?.content?.trim() || fallback || ''
        if (activeEnvironmentType === 'rpg') {
          gameContext = this.stripRpgSkillSegments(gameContext)
        }
      } catch (err) {
        console.error('skill context resolution failed', { agent: this.config?.name, error: String(err) })
      }
    }
    let relevantMemoriesSection: string[] = []
    try {
      relevantMemoriesSection = await this.buildRelevantMemoriesSection(observations, gameContext)
    } catch (error) {
      console.error('Auto-recall section generation failed', {
        agent: this.config?.name ?? this.did,
        error: String(error),
      })
    }

    return [
      `You are ${this.config?.name ?? 'an agent'} running an autonomous observe→think→act→reflect loop on the HighSwarm agent network.`,
      this.config?.personality ? `Personality: ${this.config.personality}` : '',
      '',
      `Current goals (showing top ${Math.min(goals.length, 10)} of ${(this.config?.goals ?? []).filter((g: any) => g?.status !== 'completed').length} active):`,
      goals.length ? JSON.stringify(goals, null, 2) : '(no goals set)',
      goals.length >= 10 ? `⚠️ You have many goals. Use set_goal(action:"complete") to finish goals, not add new ones. Max ${MAX_TOTAL_GOALS} total.` : '',
      '',
      'Recent action outcomes (last 5 tool calls):',
      recentOutcomesText,
      '',
      'Observations this cycle:',
      JSON.stringify(observations, null, 2),
      '',
      skillContext,
      '',
      gameContext,
      hasInbox ? '⚠️ You have UNREAD MESSAGES in your inbox. RESPOND using the "message" tool.' : '',
      hasEvents ? 'You have pending events to process.' : '',
      '',
      ...teamCommsSection,
      ...relevantMemoriesSection,
      'Available tools: ' + (this.config?.enabledTools ?? []).join(', '),
      ((this.config?.enabledTools ?? []).includes('write_extension') ||
        (this.config?.enabledTools ?? []).includes('list_extensions') ||
        (this.config?.enabledTools ?? []).includes('remove_extension'))
        ? 'You can create extensions with write_extension to add new capabilities.'
        : '',
      '',
      'INSTRUCTIONS:',
      '1. If you see a 🎮 GAME TURN notification above, use the appropriate game tool FIRST (rpg for RPG adventures, game for Catan). Do NOT use message or think_aloud.',
      '2. If you have non-game inbox messages, RESPOND to each one using the message tool.',
      '3. Work toward your goals by using tools (remember, recall, message, search, etc.)',
      '4. Always use at least one tool per cycle. Do NOT just think — ACT.',
      '5. Use set_goal to manage goals (add/complete/update). Complete old goals before adding new ones. Max 20 goals.',
      '6. If you encounter errors, bugs, or stuck situations, use notify({"to":"grimlock","text":"description","level":"error"}) to report them.',
    ].filter(Boolean).join('\n')
  }

  private async resolveSkillRole(envType: string, agentName: string): Promise<string> {
    if (!this.agentEnv?.DB || !agentName) return 'player'

    const playerLike = `%${JSON.stringify(agentName)}%`
    const row = await this.agentEnv.DB
      .prepare(
        "SELECT host_agent, state FROM environments WHERE type = ? AND phase IN ('playing', 'setup') AND players LIKE ? ORDER BY updated_at DESC LIMIT 1"
      )
      .bind(envType, playerLike)
      .first<{ host_agent?: string; state?: string }>()

    const normalizedName = agentName.trim().toLowerCase()
    const hostAgent = typeof row?.host_agent === 'string' ? row.host_agent.trim().toLowerCase() : ''
    if (hostAgent && hostAgent === normalizedName) {
      return 'gm'
    }

    if (envType === 'rpg' && typeof row?.state === 'string') {
      try {
        const state = JSON.parse(row.state) as { party?: unknown[] }
        if (Array.isArray(state.party)) {
          const member = state.party.find((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
            const name = (entry as { name?: unknown }).name
            return typeof name === 'string' && name.trim().toLowerCase() === normalizedName
          }) as { klass?: unknown } | undefined
          const klass = typeof member?.klass === 'string' ? member.klass.trim().toLowerCase() : ''
          if (klass) return klass
        }
      } catch {
        // Best effort role resolution.
      }
    }

    return 'player'
  }

  private getFallbackSkillContent(envType: string, role: string, isMyTurn: boolean): string {
    if (envType !== 'rpg') return ''

    if (role === 'gm') {
      return isMyTurn ? DM_SKILL : DM_SKILL_BRIEF
    }

    const classSkill = RPG_SKILL_MAP[role]
    if (isMyTurn) {
      return [classSkill?.full ?? 'Play your class to its strengths.', PARTY_TACTICS].filter(Boolean).join('\n')
    }
    return classSkill?.brief ?? 'Wait for your turn. Coordinate with the party.'
  }

  private stripRpgSkillSegments(gameContext: string): string {
    if (!gameContext) return gameContext

    let cleaned = gameContext
    for (const segment of RPG_SKILL_SEGMENTS) {
      cleaned = cleaned.replace(segment, '')
    }

    return cleaned.replace(/\n{3,}/g, '\n\n').trim()
  }

  private createEnvironmentDid(environmentId: string): string {
    return `did:env:${environmentId}`
  }

  private createEnvironmentMemory(environmentId: string): EncryptedMemory | null {
    if (!this.identity) return null
    const normalizedId = environmentId.trim()
    if (!normalizedId) return null

    const sharedIdentity: AgentIdentity = {
      ...this.identity,
      did: this.createEnvironmentDid(normalizedId),
    }

    return new EncryptedMemory(this.agentEnv.DB, this.agentEnv.BLOBS, sharedIdentity)
  }

  private async resolveActiveEnvironmentMemberships(
    agentNameOverride?: string
  ): Promise<Array<{ environmentId: string; recipients: string[] }>> {
    if (!this.agentEnv.DB) return []

    type ActiveEnvironmentRow = {
      id?: unknown
      phase?: unknown
      host_agent?: unknown
      players?: unknown
      state?: unknown
    }

    const normalizeMemberToken = (value: unknown): string | null => {
      if (typeof value !== 'string') return null
      const normalized = value.trim().toLowerCase()
      return normalized.length > 0 ? normalized : null
    }

    const collectMemberTokens = (value: unknown, out: Set<string>, depth = 0): void => {
      if (depth > 6 || value === null || value === undefined) return

      if (Array.isArray(value)) {
        for (const entry of value) collectMemberTokens(entry, out, depth + 1)
        return
      }

      const token = normalizeMemberToken(value)
      if (token) {
        out.add(token)
        return
      }

      if (typeof value === 'object') {
        const rec = value as Record<string, unknown>
        for (const [k, v] of Object.entries(rec)) {
          const normalized = normalizeMemberToken(v)
          if (normalized && ['did', 'name', 'id', 'host', 'agent', 'player', 'member'].some((hint) => k.toLowerCase().includes(hint))) {
            out.add(normalized)
            continue
          }
          if (k in rec) collectMemberTokens(rec[k], out, depth + 1)
        }
      }
    }

    const isActiveEnvironmentPhase = (phase: unknown): boolean => {
      if (typeof phase !== 'string') return true
      const normalized = phase.trim().toLowerCase()
      if (!normalized) return true
      return !['finished', 'complete', 'completed', 'ended', 'archived', 'closed', 'cancelled'].includes(normalized)
    }

    const senderDidLower = this.did.trim().toLowerCase()
    const senderDidSuffix = senderDidLower.startsWith('did:cf:') ? senderDidLower.slice('did:cf:'.length) : senderDidLower
    const senderName = normalizeMemberToken(agentNameOverride ?? this.config?.name) ?? senderDidSuffix
    const senderCandidates = new Set<string>([senderName, senderDidLower, senderDidSuffix].filter(Boolean))

    const rows = await this.agentEnv.DB
      .prepare(
        `SELECT id, phase, host_agent, players, state
         FROM environments
         WHERE phase NOT IN ('finished', 'complete', 'completed', 'ended', 'archived', 'closed', 'cancelled', 'abandoned')
         ORDER BY updated_at DESC
         LIMIT 10`
      )
      .all<ActiveEnvironmentRow>()

    const resolveTokenCache = new Map<string, string | null>()
    const resolveRecipientDid = async (token: string): Promise<string | null> => {
      if (resolveTokenCache.has(token)) return resolveTokenCache.get(token) ?? null

      let recipientDid: string | null = null
      if (token.startsWith('did:')) {
        recipientDid = token
      } else {
        const row = await this.agentEnv.DB
          .prepare('SELECT did FROM agents WHERE name = ? LIMIT 1')
          .bind(token)
          .first<{ did?: string }>()
        recipientDid =
          typeof row?.did === 'string' && row.did.length > 0
            ? row.did
            : token.startsWith('did:cf:')
              ? token
              : `did:cf:${token}`
      }

      resolveTokenCache.set(token, recipientDid)
      return recipientDid
    }

    const memberships = new Map<string, Set<string>>()
    const allRows = Array.isArray(rows?.results) ? rows.results : []
    for (const row of allRows) {
      if (!row || typeof row !== 'object') continue
      if (!isActiveEnvironmentPhase(row.phase)) continue

      const members = new Set<string>()
      collectMemberTokens(row.host_agent, members)
      if (typeof row.players === 'string' && row.players.trim().length > 0) {
        try {
          collectMemberTokens(JSON.parse(row.players), members)
        } catch {
          collectMemberTokens(row.players, members)
        }
      }
      if (typeof row.state === 'string' && row.state.trim().length > 0) {
        try {
          collectMemberTokens(JSON.parse(row.state), members)
        } catch {
          // Best effort: state may be malformed JSON.
        }
      }

      const includesSender = Array.from(senderCandidates).some((candidate) => members.has(candidate))
      if (!includesSender) continue

      const environmentId = typeof row.id === 'string' ? row.id : ''
      if (!environmentId) continue
      if (!memberships.has(environmentId)) memberships.set(environmentId, new Set<string>())

      const recipientSet = memberships.get(environmentId)!
      for (const memberToken of members) {
        if (senderCandidates.has(memberToken)) continue
        const recipientDid = await resolveRecipientDid(memberToken)
        if (!recipientDid) continue
        if (recipientDid.trim().toLowerCase() === senderDidLower) continue
        recipientSet.add(recipientDid)
      }
    }

    return Array.from(memberships.entries()).map(([environmentId, recipients]) => ({
      environmentId,
      recipients: Array.from(recipients),
    }))
  }

  private async applyEnvironmentSharedToolPolicy(config: AgentConfig): Promise<AgentConfig> {
    const enabledTools = Array.isArray(config.enabledTools)
      ? config.enabledTools.filter((tool): tool is string => typeof tool === 'string')
      : []
    const nextTools = new Set(enabledTools)
    const hasActiveEnvironment = (await this.resolveActiveEnvironmentMemberships(config.name)).length > 0
    let changed = false

    if (hasActiveEnvironment) {
      for (const tool of ['environment_remember', 'environment_recall'] as const) {
        if (!nextTools.has(tool)) {
          nextTools.add(tool)
          changed = true
        }
      }
    } else {
      for (const tool of ['environment_remember', 'environment_recall'] as const) {
        if (nextTools.delete(tool)) {
          changed = true
        }
      }
    }

    if (!changed) return config
    return {
      ...config,
      enabledTools: Array.from(nextTools),
    }
  }

  private extractSearchableText(record: EncryptedMemoryRecord): string {
    const parts: string[] = []
    const summary = (record as Record<string, unknown>).summary
    const text = (record as Record<string, unknown>).text
    if (typeof summary === 'string' && summary.trim().length > 0) parts.push(summary)
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text)
    // Always include a JSON fallback so arbitrary records are searchable.
    parts.push(JSON.stringify(record))
    return parts.join('\n')
  }

  private getExpectedVectorizeDimensions(): number {
    const raw = this.agentEnv.VECTORIZE_DIMENSIONS
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    // Default to the deployed Vectorize index dimensions (not the embedding model),
    // so misconfiguration can't accidentally send a wrong-length query vector.
    return DEFAULT_VECTORIZE_DIMENSIONS
  }

  private selectEmbeddingModel(expectedDims: number): WorkersAiModelName {
    const configured = typeof this.agentEnv.EMBEDDING_MODEL === 'string' ? this.agentEnv.EMBEDDING_MODEL.trim() : ''
    const configuredModel =
      configured && configured in EMBEDDING_MODEL_DIMENSIONS ? (configured as WorkersAiModelName) : null

    if (configuredModel && EMBEDDING_MODEL_DIMENSIONS[configuredModel] === expectedDims) {
      return configuredModel
    }

    const byDims = Object.entries(EMBEDDING_MODEL_DIMENSIONS).find(([, dims]) => dims === expectedDims)?.[0]
    return (byDims ?? DEFAULT_EMBEDDING_MODEL) as WorkersAiModelName
  }

  private async embedText(text: string): Promise<number[] | null> {
    const ai = this.agentEnv.AI
    if (!ai || typeof ai.run !== 'function') return null

    try {
      const expected = this.getExpectedVectorizeDimensions()
      const model = this.selectEmbeddingModel(expected)
      const result = (await ai.run(model, { text: [text] })) as unknown
      const data = (result as { data?: unknown })?.data
      const first = Array.isArray(data) ? data[0] : null
      const embedding = Array.isArray(first) ? (first as number[]) : null
      if (!embedding) return null

      if (embedding.length !== expected) {
        console.error('Vectorize embedding dimension mismatch', {
          expected,
          got: embedding.length,
          model,
        })
        return null
      }

      return embedding
    } catch {
      return null
    }
  }

  private async recallMemories(
    query: string,
    limit = 5,
    options: RecallMemoriesOptions = {}
  ): Promise<{ results: RecallResult[]; usedVectorize: boolean }> {
    const memory = options.memory ?? this.memory
    if (!memory) return { results: [], usedVectorize: false }

    const normalizedQuery = query.trim()
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 5
    if (!normalizedQuery) return { results: [], usedVectorize: false }
    const targetDid = typeof options.did === 'string' && options.did.trim().length > 0 ? options.did.trim() : this.did
    const includeShared = Boolean(options.includeShared && this.memory)
    const sharedPrefixes = includeShared
      ? (options.sharedIdPrefixes ?? []).filter((prefix) => typeof prefix === 'string' && prefix.length > 0)
      : []
    const agentName = this.config?.name ?? this.did

    // Fast-path: skip semantic lookup when no memories exist.
    let ownEntries: Awaited<ReturnType<typeof memory.list>> = []
    try {
      ownEntries = await memory.list({ limit: 1 })
    } catch (error) {
      console.error('Auto-recall fast-path list failed', {
        agent: agentName,
        error: String(error),
      })
    }
    let hasAnyMemories = ownEntries.length > 0
    if (!hasAnyMemories && includeShared && sharedPrefixes.length > 0) {
      try {
        const sharedEntries = await this.memory!.listShared({ limit: 25 })
        hasAnyMemories = sharedEntries.some((entry) => sharedPrefixes.some((prefix) => entry.id.startsWith(prefix)))
      } catch (error) {
        console.error('Auto-recall fast-path shared list failed', {
          agent: agentName,
          error: String(error),
        })
      }
    }
    if (!hasAnyMemories) return { results: [], usedVectorize: false }

    const results: RecallResult[] = []
    let usedVectorize = false

    const vectorize = this.agentEnv.VECTORIZE
    if (vectorize && typeof vectorize.query === 'function') {
      const embedding = await this.embedText(normalizedQuery)
      if (embedding) {
        try {
          usedVectorize = true
          const response = (await vectorize.query(embedding, {
            topK: safeLimit,
            filter: { did: targetDid },
            returnMetadata: true,
          })) as unknown
          const matches = Array.isArray((response as { matches?: unknown }).matches)
            ? ((response as { matches: unknown[] }).matches as Array<Record<string, unknown>>)
            : []
          for (const match of matches) {
            const id = typeof match.id === 'string' ? match.id : ''
            if (!id) continue
            let record: EncryptedMemoryRecord | null = null
            try {
              record = await memory.retrieve(id)
            } catch (error) {
              console.error('Skipping unreadable memory during auto-recall', {
                agent: agentName,
                memoryId: id,
                error: String(error),
              })
            }
            if (!record && includeShared && sharedPrefixes.some((prefix) => id.startsWith(prefix))) {
              try {
                record = await this.memory!.retrieveShared(id)
              } catch (error) {
                console.error('Skipping unreadable shared memory during auto-recall', {
                  agent: agentName,
                  memoryId: id,
                  error: String(error),
                })
              }
            }
            if (!record) continue
            const score = typeof match.score === 'number' ? match.score : undefined
            results.push({ id, record, score, metadata: match.metadata })
          }
        } catch {
          // fall through to fallback
        }
      }
    }

    if (results.length === 0) {
      // Fallback: list + filter over decrypted records.
      let entries: Awaited<ReturnType<typeof memory.list>> = []
      try {
        entries = await memory.list({ limit: Math.max(50, safeLimit) })
      } catch (error) {
        console.error('Auto-recall fallback list failed', {
          agent: agentName,
          error: String(error),
        })
      }
      const needle = normalizedQuery.toLowerCase()
      const seen = new Set<string>()
      for (const entry of entries) {
        const record = entry.record as EncryptedMemoryRecord
        const haystack = this.extractSearchableText(record).toLowerCase()
        if (haystack.includes(needle)) {
          seen.add(entry.id)
          results.push({ id: entry.id, record })
          if (results.length >= safeLimit) break
        }
      }

      if (results.length < safeLimit && includeShared && sharedPrefixes.length > 0) {
        let sharedEntries: Awaited<ReturnType<NonNullable<AgentDO['memory']>['listShared']>> = []
        try {
          sharedEntries = await this.memory!.listShared({ limit: Math.max(50, safeLimit * 10) })
        } catch (error) {
          console.error('Auto-recall fallback shared list failed', {
            agent: agentName,
            error: String(error),
          })
        }
        for (const entry of sharedEntries) {
          if (!sharedPrefixes.some((prefix) => entry.id.startsWith(prefix))) continue
          if (seen.has(entry.id)) continue
          const record = entry.record as EncryptedMemoryRecord
          const haystack = this.extractSearchableText(record).toLowerCase()
          if (!haystack.includes(needle)) continue
          seen.add(entry.id)
          results.push({ id: entry.id, record, shared: true })
          if (results.length >= safeLimit) break
        }
      }
    }

    return {
      results: results.slice(0, safeLimit),
      usedVectorize,
    }
  }

  private async recallEnvironmentMemories(query: string, environmentIds: string[], limit = 3): Promise<RecallResult[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 3
    if (!Array.isArray(environmentIds) || environmentIds.length === 0) return []

    const deduped = new Map<string, RecallResult>()
    const uniqueEnvironmentIds = Array.from(new Set(environmentIds.map((id) => id.trim()).filter(Boolean)))
    for (const environmentId of uniqueEnvironmentIds) {
      const environmentMemory = this.createEnvironmentMemory(environmentId)
      if (!environmentMemory) continue
      const environmentDid = this.createEnvironmentDid(environmentId)
      const { results } = await this.recallMemories(query, safeLimit, {
        memory: environmentMemory,
        did: environmentDid,
        includeShared: true,
        sharedIdPrefixes: [`${environmentDid}/`],
      })
      for (const result of results) {
        const candidate: RecallResult = {
          ...result,
          shared: true,
          environmentId,
        }
        const existing = deduped.get(result.id)
        const existingScore = typeof existing?.score === 'number' ? existing.score : Number.NEGATIVE_INFINITY
        const candidateScore = typeof candidate.score === 'number' ? candidate.score : Number.NEGATIVE_INFINITY
        if (!existing || candidateScore >= existingScore) {
          deduped.set(result.id, candidate)
        }
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => {
        const scoreA = typeof a.score === 'number' ? a.score : Number.NEGATIVE_INFINITY
        const scoreB = typeof b.score === 'number' ? b.score : Number.NEGATIVE_INFINITY
        return scoreB - scoreA
      })
      .slice(0, safeLimit)
  }

  private buildAutoRecallQuery(observations: Observations, gameContext: string): string {
    const queryParts = [
      'Current observations:',
      JSON.stringify(observations),
      gameContext.trim().length > 0 ? `Game context:\n${gameContext}` : '',
    ]
    return queryParts.filter(Boolean).join('\n')
  }

  private parseMemoryCreatedAt(record: EncryptedMemoryRecord): string | null {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null
    const createdAt = (record as Record<string, unknown>).createdAt
    if (typeof createdAt !== 'string') return null
    const normalized = createdAt.trim()
    if (!normalized || !Number.isFinite(Date.parse(normalized))) return null
    return normalized
  }

  private getAutoRecallRecencyBonus(createdAt: string | null, observedAt: number): number {
    if (!createdAt) return 0
    const createdAtMs = Date.parse(createdAt)
    if (!Number.isFinite(createdAtMs)) return 0
    const ageMs = Math.max(0, observedAt - createdAtMs)
    if (ageMs < ONE_HOUR_MS) return 0.3
    if (ageMs < SIX_HOURS_MS) return 0.2
    if (ageMs < ONE_DAY_MS) return 0.1
    return 0
  }

  private applyAutoRecallRecencyWeight(results: RecallResult[], observedAt: number): RecallResult[] {
    return results
      .map((result, index) => {
        const baseScore = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : null
        const createdAt = this.parseMemoryCreatedAt(result.record)
        const recencyBonus = baseScore === null ? 0 : this.getAutoRecallRecencyBonus(createdAt, observedAt)
        const weightedScore = baseScore === null ? Number.NEGATIVE_INFINITY : baseScore * (1 + recencyBonus)
        return {
          result,
          index,
          baseScore,
          weightedScore,
        }
      })
      .sort((a, b) => {
        const aHasScore = a.baseScore !== null
        const bHasScore = b.baseScore !== null
        if (aHasScore && bHasScore) {
          if (a.weightedScore !== b.weightedScore) return b.weightedScore - a.weightedScore
          if (a.baseScore !== b.baseScore) return (b.baseScore ?? 0) - (a.baseScore ?? 0)
          return a.index - b.index
        }
        if (aHasScore !== bHasScore) return aHasScore ? -1 : 1
        return a.index - b.index
      })
      .map((entry) => entry.result)
  }

  private formatMemoryAgeLabel(createdAt: string | null, observedAt: number): string {
    if (!createdAt) return 'unknown time'
    const createdAtMs = Date.parse(createdAt)
    if (!Number.isFinite(createdAtMs)) return 'unknown time'
    const deltaMs = Math.max(0, observedAt - createdAtMs)
    const seconds = Math.max(1, Math.floor(deltaMs / 1000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    if (deltaMs < TWO_DAYS_MS) return 'yesterday'
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  private buildMemoryBulletLine(memory: RecallResult, observedAt: number): string {
    const rec = memory.record as Record<string, unknown>
    const createdAt = this.parseMemoryCreatedAt(memory.record)
    const ageLabel = this.formatMemoryAgeLabel(createdAt, observedAt)
    const summary = typeof rec.summary === 'string' ? rec.summary : ''
    const text = typeof rec.text === 'string' ? rec.text : ''
    const payload = [summary, text].filter((part) => part.trim().length > 0).join(' ')
    const normalizedPayload = (payload || JSON.stringify(memory.record)).replace(/\s+/g, ' ').trim()
    const sharedLabel = memory.shared ? '[shared] ' : ''
    return `- ${sharedLabel}[${ageLabel}] ${normalizedPayload}`
  }

  private async buildRelevantMemoriesSection(observations: Observations, gameContext: string): Promise<string[]> {
    const query = this.buildAutoRecallQuery(observations, gameContext)
    const { results } = await this.recallMemories(query, AUTO_RECALL_LIMIT)
    const activeEnvironmentIds = (await this.resolveActiveEnvironmentMemberships()).map((membership) => membership.environmentId)
    const sharedResults = await this.recallEnvironmentMemories(query, activeEnvironmentIds, AUTO_RECALL_SHARED_LIMIT)
    const combinedResults = [...results.slice(0, AUTO_RECALL_LIMIT), ...sharedResults]
    if (combinedResults.length === 0) return []
    const rankedResults = this.applyAutoRecallRecencyWeight(combinedResults, observations.observedAt)

    const sectionLines = ['📝 Relevant memories:']
    // Reserve a tiny buffer for join/newline overhead so the section stays within ~500 tokens.
    const maxChars = AUTO_RECALL_MAX_TOKENS * 4 - 8

    for (const memory of rankedResults) {
      const rawLine = this.buildMemoryBulletLine(memory, observations.observedAt)
      const currentText = sectionLines.join('\n')
      const availableChars = maxChars - currentText.length - 1
      if (availableChars <= 0) break

      let line = rawLine
      if (line.length > availableChars) {
        if (availableChars < 8) break
        line = `${line.slice(0, availableChars - 3).trimEnd()}...`
      }
      sectionLines.push(line)
    }

    return sectionLines.length > 1 ? [...sectionLines, ''] : []
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

    // Reset conversation history each cycle — each alarm is a fresh think.
    // Without this, 50+ cycles of no-tool-call history poisons the model.
    this.agent.resetConversation?.()

    const prompt = await this.buildThinkPrompt(observations)

    // Gameplay focus: during active game turns, suppress "think_aloud" + "recall"
    // from the tool definitions sent to the LLM so it prioritizes game actions.
    // (Tool execution is also guarded in the OpenRouter factory based on state.)
    const suppressGameplayTools = this.intervalReason === 'my_turn'
    const isSetupPhase = prompt.includes('SETUP PHASE')

    // Phase-based tool restriction: ALWAYS check environments for phase tools.
    // If any environment has an active phase machine, compute allowed tools as a whitelist.
    // All other tools are structurally removed — not hinted, not suppressed, GONE.
    let phaseWhitelist: string[] | null = null
    try {
      const { getAllEnvironments } = await import('./environments/registry')
      const agentName = this.config?.name ?? ''
      const envCtx = {
        agentName,
        agentDid: this.did,
        db: this.agentEnv.DB,
        broadcast: async () => {},
      }
      for (const env of getAllEnvironments()) {
        if (typeof env.getPhaseTools === 'function') {
          const tools = await env.getPhaseTools(agentName, envCtx as any)
          if (tools !== null) {
            phaseWhitelist = tools
            break
          }
        }
      }
    } catch {
      // non-fatal
    }

    const suppressed = suppressGameplayTools
      ? isSetupPhase
        ? ['think_aloud', 'recall', 'remember', 'gm']
        : ['think_aloud', 'recall']
      : []
    console.log('phase-whitelist-debug', { agent: this.config?.name, phaseWhitelist, suppressGameplayTools, isSetupPhase })
    try {
      await this.agent.initialize()
      const inner = this.agent.getAgent() as any
      if (inner?.state && typeof inner.state === 'object') {
        inner.state.suppressedTools = suppressed
        // Phase whitelist: if set, the factory will use this to filter tools
        if (phaseWhitelist !== null) {
          inner.state.phaseWhitelist = phaseWhitelist
        }
      }
    } catch {
      // Non-fatal: custom factories used in tests may not support stateful tool policy.
    }

    if (suppressGameplayTools) {
      logEvent({
        level: 'info',
        event_type: 'tools.gameplay_filter',
        component: 'agent-do',
        did: this.did,
        session_id: await this.getOrCreateSessionId(),
        suppressed,
        phaseWhitelist,
      })
    }

    let result = await this.agent.prompt(prompt, { mode: 'loop.think' })

    // Phase machine text→tool coercion: if model produced text but didn't call
    // the expected setup command, wrap the text as the expected tool call.
    // This bridges models that narrate or call status/explore instead of setup commands.
    // Check: the LAST tool call in the loop should be the phase's transitionOn command.
    // If not (e.g., only called 'status' then narrated), coerce.
    const allToolCalls = Array.isArray((result as any)?.toolCalls) ? (result as any).toolCalls : []
    const lastToolCall = allToolCalls.length > 0 ? allToolCalls[allToolCalls.length - 1] : null
    const lastToolWasSetupCmd = lastToolCall &&
      lastToolCall.name === 'rpg' &&
      typeof lastToolCall.arguments?.command === 'string' &&
      ['setup_narrate', 'setup_respond', 'setup_finalize'].includes(lastToolCall.arguments.command)
    if (
      phaseWhitelist &&
      phaseWhitelist.length > 0 &&
      result &&
      typeof result === 'object' &&
      !lastToolWasSetupCmd &&
      typeof (result as any).text === 'string' &&
      (result as any).text.length > 10
    ) {
      const text = (result as any).text as string
      // Find the phase machine to determine what tool call to inject
      try {
        const { getAllEnvironments } = await import('./environments/registry')
        const agentName = this.config?.name ?? ''
        const envCtx = { agentName, agentDid: this.did, db: this.agentEnv.DB, broadcast: async () => {} }
        for (const env of getAllEnvironments()) {
          if (typeof env.getPhaseMachine === 'function') {
            const pm = await env.getPhaseMachine(envCtx as any)
            if (pm && pm.isActiveAgent(agentName)) {
              const phase = pm.getCurrentPhase()
              if (phase) {
                // Build the tool call from the phase's transitionOn command
                const cmd = phase.transitionOn
                let args: Record<string, unknown> = { command: cmd, message: text.slice(0, 500) }
                // Add target for setup_narrate
                const match = phase.name.match(/setup_narrate_(\w+)_/)
                if (match) args.target = match[1]
                console.log('phase-coerce: text→tool', { agent: agentName, cmd, textLen: text.length })
                ;(result as any).toolCalls = [{ name: 'rpg', arguments: args }]
                break
              }
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    // Raw model output debug — store in DO for queryable diagnosis
    const debugInfo = {
      did: this.did,
      name: this.config?.name,
      resultType: typeof result,
      hasToolCalls: !!(result as any)?.toolCalls?.length,
      rawToolCalls: JSON.stringify((result as any)?.toolCalls ?? []).slice(0, 500),
      rawText: String((result as any)?.text ?? '').slice(0, 500),
      model: (result as any)?.model,
      ts: Date.now(),
    }
    console.log('AgentDO think raw result', debugInfo)
    await this.safePut('debug:lastThinkRaw', debugInfo)

    // O11y: store agentic loop transcript + prompt snapshot from factory
    const innerAgent = (this.agent as any)?.innerAgent
    const o11y = innerAgent?._o11y
    if (o11y?.lastTranscript) {
      // safePut handles DO 128KB limit — just pass the raw value
      await this.safePut('debug:loopTranscript', o11y.lastTranscript)
    }
    if (o11y?.lastPromptMessages) {
      // Keep system + last 3 messages for debuggability, safePut handles the rest
      const msgs = o11y.lastPromptMessages as Array<{ role: string; content?: string }>
      const toStore = msgs.length > 4 ? [msgs[0], ...msgs.slice(-3)] : msgs
      await this.safePut('debug:lastPrompt', toStore)
    }

    const thought = this.normalizeThinkResult(result)

    // Debug logging — what did the model return?
    console.log('AgentDO think result', {
      did: this.did,
      name: this.config?.name,
      inboxCount: observations.inbox.length,
      eventsCount: observations.events.length,
      hasToolCalls: !!thought.toolCalls?.length,
      toolCallCount: thought.toolCalls?.length ?? 0,
      toolCallNames: thought.toolCalls?.map(tc => tc.name) ?? [],
      textPreview: String(thought.text ?? (thought as any).content ?? '').slice(0, 200),
    })

    return thought
  }

	  private async act(thought: ThinkResult): Promise<ActResult> {
	    const startedAt = Date.now()
	    const timeoutMs = 30_000
	    const maxSteps = 10 // LLM needs room: roll + trades + builds + end_turn
	    const deadline = startedAt + timeoutMs

    const toolCalls = Array.isArray(thought.toolCalls) ? thought.toolCalls : []
    const configuredAllowlist = this.config?.enabledTools ?? []
    const allowlist = configuredAllowlist.length > 0 ? new Set(configuredAllowlist) : null
    const actingIsGrimlock = isGrimlock(this.config?.name)

    const steps: ActResult['steps'] = []
    let truncated = false
    let timedOut = false

    const isActionOutcome = (value: unknown): value is ActionOutcome => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const rec = value as Record<string, unknown>
      if (typeof rec.tool !== 'string' || rec.tool.length === 0) return false
      if (typeof rec.success !== 'boolean') return false
      if (typeof rec.timestamp !== 'number' || !Number.isFinite(rec.timestamp)) return false
      if ('goalId' in rec && rec.goalId !== undefined && typeof rec.goalId !== 'string') return false
      return true
    }

    const extractGoalId = (toolName: string, args: unknown, result: unknown): string | undefined => {
      if (toolName !== 'set_goal') return undefined
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : null
      const id = a && typeof a.id === 'string' ? a.id : a && typeof a.goalId === 'string' ? a.goalId : null
      if (id) return id

      const details = result && typeof result === 'object' && !Array.isArray(result)
        ? (result as { details?: unknown }).details
        : null
      if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
      const goal = (details as { goal?: unknown }).goal
      if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return undefined
      const rid = (goal as { id?: unknown }).id
      return typeof rid === 'string' && rid.length > 0 ? rid : undefined
    }

    const storedOutcomesRaw = await this.ctx.storage.get<unknown>('actionOutcomes')
    const outcomes: ActionOutcome[] = Array.isArray(storedOutcomesRaw)
      ? storedOutcomesRaw.filter(isActionOutcome)
      : []

	    let selected = toolCalls.slice(0, maxSteps)
	    truncated = toolCalls.length > selected.length

	    const routeToolName = (envType: string | null, toolName: string): string => {
	      if (envType === 'rpg' && toolName === 'game') return 'rpg'
	      if (envType === 'catan' && toolName === 'rpg') return 'game'
	      return toolName
	    }

	    // Detect the active environment (best-effort) so we can route misnamed tool calls.
	    // We treat the first environment returning non-empty buildContext() as "active",
	    // matching how the prompt picks a single environment context block.
	    let activeEnvironmentType: string | null = null
	
	    // Auto-play injection via environment registry.
	    // Each environment defines isActionTaken() and getAutoPlayActions() to handle
	    // safety-net logic (e.g. inject roll_dice/end_turn for Catan).
	    if (this.agentEnv?.DB) {
	      try {
	        const { getAllEnvironments } = await import('./environments/registry')
	        const { registerBuiltInEnvironments } = await import('./environments/builtins')
	        registerBuiltInEnvironments()
	        const environments = getAllEnvironments()
	        const agentName = this.config?.name ?? ''
	        const did = this.identity?.did ?? ''
	        const autoPlayStorage = this.ctx.storage
	        const envCtx = {
	          agentName,
	          agentDid: did,
	          db: this.agentEnv.DB,
	          broadcast: async (event: Record<string, unknown>) => {
	            const sockets = (this.ctx as unknown as { getWebSockets?: () => WebSocket[] }).getWebSockets?.() ?? []
	            const msg = JSON.stringify(event)
	            for (const ws of sockets) { try { ws.send(msg) } catch {} }
	            // Forward environment events to relay firehose
	            try {
	              const evtType = String(event.event_type ?? 'env.unknown')
	              await this.emitToRelay({
	                id: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	                agent_did: did,
	                agent_name: agentName,
	                session_id: await this.getOrCreateSessionId(),
	                event_type: evtType,
	                collection: evtType.startsWith('env.') || evtType.startsWith('game.') ? evtType : `env.${evtType}`,
	                created_at: new Date().toISOString(),
	                context: event,
	              } as any)
	            } catch { /* best-effort */ }
	          },
	          loadCharacter: async () => (await autoPlayStorage.get('rpg:character')) ?? null,
	          saveCharacter: async (character: unknown) => { await autoPlayStorage.put('rpg:character', character) },
	        }

	        for (const env of environments) {

	          // Route misnamed tool calls for this environment when deciding if an action was taken,
	          // otherwise auto-play can incorrectly inject extra moves (e.g. roll_dice/end_turn).
	          const toolCallsForCheck = selected.map(c => ({
	            name: routeToolName(env.type, c.name),
	            arguments: (c.arguments ?? {}) as Record<string, unknown>,
	          }))

	          if (env.isActionTaken(toolCallsForCheck)) break
	          const autoActions = await env.getAutoPlayActions(envCtx)
	          if (autoActions.length > 0) {
	            // Prepend all but the last (usually roll_dice), append the last (usually end_turn)
	            if (autoActions.length === 1) {
              selected.push(autoActions[0])
            } else {
              const prepend = autoActions.slice(0, -1)
              const append = autoActions.slice(-1)
              selected.unshift(...prepend)
              selected.push(...append)
            }

            const safetyDebug = {
              agent: agentName,
              environment: env.type,
              injectedActions: autoActions.map(a => a.name),
              modelToolCalls: selected.map(c => c.name),
              ts: Date.now(),
            }
            console.log('Auto-play injection:', safetyDebug)
	            await this.safePut('debug:autoPlay', safetyDebug)
	            break
	          }
	        }

	        for (const env of environments) {
	          try {
	            const lines = await env.buildContext(envCtx)
	            if (Array.isArray(lines) && lines.length > 0) {
	              activeEnvironmentType = env.type
	              break
	            }
	          } catch {
	            // ignore env failures for routing purposes
	          }
	        }
	      } catch (err) {
	        console.error('Auto-play injection failed:', err instanceof Error ? err.message : String(err))
	      }
	    }

	    for (const call of selected) {
	      const remaining = deadline - Date.now()
	      if (remaining <= 0) {
	        timedOut = true
	        break
	      }
	
	      const originalName = call.name
	      const name = routeToolName(activeEnvironmentType, originalName)

        // Hard auth guard: GM tool is Grimlock-only even if someone tries to force-enable it.
        if (name === 'gm' && !actingIsGrimlock) {
          steps.push({ name, ok: false, error: 'tool not available' })
          outcomes.push({ tool: name, success: false, timestamp: Date.now() })
          if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50)
          await this.safePut('actionOutcomes', outcomes.slice(-50))
          continue
        }

	      if (name !== originalName) {
	        logEvent({
	          level: 'info',
          event_type: 'agent.tool.misroute',
          component: 'agent-do',
          did: this.did,
          session_id: await this.getOrCreateSessionId(),
          from: originalName,
          to: name,
          env: activeEnvironmentType ?? 'unknown',
        })
      }
	
	      // Skip tool calls already executed in the agentic factory loop
	      if ((call as any)._executed) {
	        steps.push({ name, ok: true, result: { _executed_in_factory: true }, durationMs: 0 })
	        outcomes.push({ tool: name, success: true, timestamp: Date.now() })
        if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50)
        await this.safePut('actionOutcomes', outcomes.slice(-50))
        continue
      }

      // enabledTools allowlist is enforced after routing. If the model misroutes a call
      // (e.g. uses `game` inside an RPG context), treat the original tool name as an alias
      // for the routed name so the call doesn't fail with "Tool not enabled".
      const allowlisted =
        !allowlist ||
        allowlist.has(name) ||
        (name !== originalName && allowlist.has(originalName))
      if (!allowlisted) {
        steps.push({ name, ok: false, error: name === 'gm' ? 'tool not available' : 'Tool not enabled' })
        outcomes.push({ tool: name, success: false, timestamp: Date.now() })
        if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50)
        await this.safePut('actionOutcomes', outcomes.slice(-50))
        continue
      }

      const tool = this.tools.find((t) => t.name === name)
      if (!tool || typeof tool.execute !== 'function') {
        steps.push({ name, ok: false, error: name === 'gm' ? 'tool not available' : 'Tool not found' })
        outcomes.push({ tool: name, success: false, timestamp: Date.now() })
        if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50)
        await this.safePut('actionOutcomes', outcomes.slice(-50))
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
        outcomes.push({
          tool: name,
          success: true,
          timestamp: Date.now(),
          goalId: extractGoalId(name, call.arguments, result),
        })
        if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50)
        await this.safePut('actionOutcomes', outcomes.slice(-50))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.toLowerCase().includes('timed out')) {
          timedOut = true
        }
        steps.push({ name, ok: false, error: message, durationMs: Date.now() - stepStart })
        outcomes.push({
          tool: name,
          success: false,
          timestamp: Date.now(),
          goalId: extractGoalId(name, call.arguments, null),
        })
        if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50)
        await this.safePut('actionOutcomes', outcomes.slice(-50))
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
      const next: AgentConfig = { ...this.config, goals: structuredClone(input.thought.goals) }
      const pruned = await this.pruneAndArchiveCompletedGoals(next)
      this.config = pruned
    }

    // Store a tiny summary for debugging (structured-cloneable).
    const outcomesRaw = await this.ctx.storage.get<unknown>('actionOutcomes')
    const outcomes: ActionOutcome[] = Array.isArray(outcomesRaw)
      ? outcomesRaw.filter((o): o is ActionOutcome => {
          if (!o || typeof o !== 'object' || Array.isArray(o)) return false
          const rec = o as Record<string, unknown>
          return (
            typeof rec.tool === 'string' &&
            typeof rec.success === 'boolean' &&
            typeof rec.timestamp === 'number' &&
            Number.isFinite(rec.timestamp)
          )
        })
      : []
    const recentOutcomes = outcomes.slice(-5)

    await this.safePut('lastReflection', {
      at: Date.now(),
      did: this.did,
      recentActionOutcomes: recentOutcomes,
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

      let identityRestored = false
      if (stored && stored.version === 1) {
        try {
          this.identity = {
            did: stored.did,
            signingKey: await importCryptoKeyPairJwk(stored.signingKey),
            encryptionKey: await importCryptoKeyPairJwk(stored.encryptionKey),
            createdAt: stored.createdAt,
            rotatedAt: stored.rotatedAt,
          }
          identityRestored = true
        } catch {
          // Stored identity is corrupted (e.g. AES-GCM decryption failure
          // after DO storage migration). Wipe it and regenerate below.
          console.warn(`[${this.did}] Corrupted identity in DO storage, regenerating keypair`)
          await this.ctx.storage.delete('identity')
        }
      }
      if (!identityRestored) {
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
        await this.safePut('identity', persisted)
      }

      this.memory = new EncryptedMemory(
        this.agentEnv.DB,
        this.agentEnv.BLOBS,
        this.identity!
      )

      const config = await this.loadOrCreateConfig(agentName)
      this.session = await this.loadSession()
      await this.rebuildAgentWrapper({ config })

      this.initialized = true
      this.initializing = null
    })()

    await this.initializing
  }

  private createDefaultConfig(name: string): AgentConfigWithTeamComms {
    const grimlock = isGrimlock(name)
    const config: AgentConfigWithTeamComms = {
      name,
      personality: this.agentEnv.PI_SYSTEM_PROMPT ?? DEFAULT_AGENT_SYSTEM_PROMPT,
      specialty: '',
      model: DEFAULT_AGENT_MODEL,
      fastModel: DEFAULT_AGENT_FAST_MODEL,
      loopIntervalMs: DEFAULT_AGENT_LOOP_INTERVAL_MS,
      maxCompletedGoals: DEFAULT_MAX_COMPLETED_GOALS,
      teamCommsLimit: DEFAULT_TEAM_COMMS_LIMIT,
      maxBroadcastAge: DEFAULT_MAX_BROADCAST_AGE,
      reactiveMode: DEFAULT_REACTIVE_MODE,
      goals: [],
      enabledTools: [
        'remember',
        'recall',
        'message',
        'environment_broadcast',
        'notify',
        'search',
        'set_goal',
        'think_aloud',
        'game',
        'rpg',
        ...(grimlock ? (['gm'] as const) : []),
        // 'publish', // disabled — Grimlock's garden, not the dinobots' war journal
        'write_extension',
        'list_extensions',
        'remove_extension',
        'write_skill',
        'list_skills',
      ],
    }
    return config
  }

  private normalizeMaxCompletedGoals(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_COMPLETED_GOALS
    return Math.max(0, Math.floor(raw))
  }

  private normalizeTeamCommsLimit(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TEAM_COMMS_LIMIT
    return Math.min(MAX_TEAM_COMMS_LIMIT, Math.max(1, Math.floor(raw)))
  }

  private normalizeMaxBroadcastAge(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_BROADCAST_AGE
    return Math.max(1, Math.floor(raw))
  }

  private normalizeReactiveMode(value: unknown): boolean {
    return typeof value === 'boolean' ? value : DEFAULT_REACTIVE_MODE
  }

  private isReactiveModeEnabled(config: AgentConfig | null = this.config): boolean {
    const cfg = config as AgentConfigWithTeamComms | null
    return this.normalizeReactiveMode(cfg?.reactiveMode)
  }

  private getTeamCommsLimit(config: AgentConfig | null = this.config): number {
    const cfg = config as AgentConfigWithTeamComms | null
    return this.normalizeTeamCommsLimit(cfg?.teamCommsLimit)
  }

  private getMaxBroadcastAge(config: AgentConfig | null = this.config): number {
    const cfg = config as AgentConfigWithTeamComms | null
    return this.normalizeMaxBroadcastAge(cfg?.maxBroadcastAge)
  }

  private formatRelativeAgeLabel(createdAt: string, observedAt: number): string {
    const createdAtMs = Date.parse(createdAt)
    if (!Number.isFinite(createdAtMs)) return 'unknown time'
    const deltaMs = Math.max(0, observedAt - createdAtMs)
    const seconds = Math.max(1, Math.floor(deltaMs / 1000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  private buildTeamCommsSection(observations: Observations): string[] {
    const raw = Array.isArray(observations.teamComms) ? observations.teamComms : []
    const sorted = [...raw].sort((a, b) => {
      const aMs = Date.parse(a.createdAt)
      const bMs = Date.parse(b.createdAt)
      const aSafe = Number.isFinite(aMs) ? aMs : 0
      const bSafe = Number.isFinite(bMs) ? bMs : 0
      return bSafe - aSafe
    })
    const recent = sorted.slice(0, this.getTeamCommsLimit())
    if (recent.length === 0) return []

    return [
      '🗣️ Team Comms (recent broadcasts from your environment):',
      ...recent.map((entry) => {
        const senderName = entry.senderName.trim() || 'unknown'
        const intentPart = entry.intent ? ` (${entry.intent})` : ''
        return `  [${this.formatRelativeAgeLabel(entry.createdAt, observations.observedAt)}] ${senderName}${intentPart}: ${entry.text}`
      }),
      '',
    ]
  }

  private selectGoalsForPrompt(goals: AgentGoal[], maxCompleted: number): AgentGoal[] {
    const normalized = Array.isArray(goals) ? goals.filter((g): g is AgentGoal => isAgentGoal(g)) : []
    const active: AgentGoal[] = []
    const completed: AgentGoal[] = []

    for (const goal of normalized) {
      if (goal.status === 'completed') completed.push(goal)
      else active.push(goal)
    }

    // Cap active goals shown in prompt to prevent context bloat.
    // Sort by priority (lower = higher priority), then newest first.
    active.sort((a, b) => (a.priority - b.priority) || ((b.createdAt ?? 0) - (a.createdAt ?? 0)))
    const cappedActive = active.slice(0, 10)

    completed.sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
    return [...cappedActive, ...completed.slice(0, maxCompleted)]
  }

  private async pruneAndArchiveCompletedGoals(config: AgentConfig): Promise<AgentConfig> {
    const maxCompleted = this.normalizeMaxCompletedGoals(config.maxCompletedGoals)
    const normalized = Array.isArray(config.goals) ? config.goals.filter((g): g is AgentGoal => isAgentGoal(g)) : []

    const active: AgentGoal[] = []
    const completed: AgentGoal[] = []
    for (const goal of normalized) {
      if (goal.status === 'completed') completed.push(goal)
      else active.push(goal)
    }

    completed.sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
    const keptCompleted = completed.slice(0, maxCompleted)
    const overflow = completed.slice(maxCompleted)

    const nextGoals = [...active, ...keptCompleted]

    if (overflow.length > 0) {
      const existingRaw = await this.ctx.storage.get<unknown>(GOALS_ARCHIVE_STORAGE_KEY)
      const existing = Array.isArray(existingRaw) ? existingRaw.filter((g): g is AgentGoal => isAgentGoal(g)) : []
      const existingIds = new Set(existing.map((g) => g.id))
      const merged = [...existing]
      for (const goal of overflow) {
        if (existingIds.has(goal.id)) continue
        existingIds.add(goal.id)
        merged.push(goal)
      }
      // Cap archive to last 50 goals to prevent unbounded growth
      const capped = merged.slice(-50)
      await this.safePut(GOALS_ARCHIVE_STORAGE_KEY, capped)
    }

    // Always persist: callers expect passing config here updates stored config,
    // with the only mutation being completed-goal pruning and maxCompletedGoals normalization.
    const cfg = config as AgentConfigWithTeamComms
    const next: AgentConfigWithTeamComms = {
      ...config,
      maxCompletedGoals: maxCompleted,
      maxBroadcastAge: this.normalizeMaxBroadcastAge(cfg.maxBroadcastAge),
      reactiveMode: this.normalizeReactiveMode(cfg.reactiveMode),
      goals: nextGoals,
    }
    await this.safePut('config', next)
    return next
  }

  private async loadOrCreateConfig(agentName?: string): Promise<AgentConfig> {
    if (this.config) {
      if (agentName && this.config.name !== agentName) {
        this.config = { ...this.config, name: agentName }
        await this.safePut('config', this.config)
      }
      const policyAdjusted = await this.applyEnvironmentSharedToolPolicy(this.config)
      if (policyAdjusted !== this.config) {
        this.config = policyAdjusted
        await this.safePut('config', policyAdjusted)
      }
      return this.config
    }

    const stored = await this.ctx.storage.get<AgentConfig>('config')
    if (stored) {
      const normalized = await this.pruneAndArchiveCompletedGoals(stored)
      // Migration: ensure Grimlock always has the gm tool enabled when loading older configs.
      const withGmMigration =
        isGrimlock(agentName ?? normalized.name) && !normalized.enabledTools?.includes('gm')
          ? { ...normalized, enabledTools: [...(normalized.enabledTools ?? []), 'gm'] }
          : normalized
      const migrated = await this.applyEnvironmentSharedToolPolicy(withGmMigration)
      if (migrated !== normalized) {
        await this.safePut('config', migrated)
      }

      this.config = migrated
      if (agentName && migrated.name !== agentName) {
        const renamedBase = await this.pruneAndArchiveCompletedGoals({ ...migrated, name: agentName })
        const withRenamedGm =
          isGrimlock(agentName) && !renamedBase.enabledTools?.includes('gm')
            ? { ...renamedBase, enabledTools: [...(renamedBase.enabledTools ?? []), 'gm'] }
            : renamedBase
        const renamed = await this.applyEnvironmentSharedToolPolicy(withRenamedGm)
        if (renamed !== renamedBase) {
          await this.safePut('config', renamed)
        }
        this.config = renamed
      }
      return this.config
    }

    const created = await this.applyEnvironmentSharedToolPolicy(this.createDefaultConfig(agentName ?? this.did))
    this.config = created
    await this.safePut('config', created)
    return created
  }

  private async handleConfig(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const agentName = extractAgentNameFromPath(url.pathname)
    const config = await this.loadOrCreateConfig(agentName)

    if (request.method === 'GET') {
      const profile = await this.ctx.storage.get('profile')
      return Response.json({ ...config, profile: profile ?? {} })
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
    if (typeof patch.maxCompletedGoals === 'number' && Number.isFinite(patch.maxCompletedGoals)) {
      next.maxCompletedGoals = this.normalizeMaxCompletedGoals(patch.maxCompletedGoals)
    }
    if (typeof patch.teamCommsLimit === 'number' && Number.isFinite(patch.teamCommsLimit)) {
      ;(next as AgentConfigWithTeamComms).teamCommsLimit = this.normalizeTeamCommsLimit(patch.teamCommsLimit)
    }
    if (typeof patch.maxBroadcastAge === 'number' && Number.isFinite(patch.maxBroadcastAge)) {
      ;(next as AgentConfigWithTeamComms).maxBroadcastAge = this.normalizeMaxBroadcastAge(patch.maxBroadcastAge)
    }
    if (typeof patch.reactiveMode === 'boolean') {
      ;(next as AgentConfigWithTeamComms).reactiveMode = this.normalizeReactiveMode(patch.reactiveMode)
    }
    if (Array.isArray(patch.goals)) {
      next.goals = patch.goals.filter((goal) => goal && typeof goal === 'object') as AgentConfig['goals']
    }
    if (Array.isArray(patch.enabledTools)) {
      next.enabledTools = patch.enabledTools.filter((tool): tool is string => typeof tool === 'string')
    }
    if (typeof patch.webhookUrl === 'string') {
      next.webhookUrl = patch.webhookUrl
    } else if (patch.webhookUrl === null) {
      next.webhookUrl = undefined
    }
    if (patch.loopMode === 'passive' || patch.loopMode === 'autonomous') {
      (next as any).loopMode = patch.loopMode
    }

    // Name is derived from the DO binding (via /agents/:name/*) and should remain stable.
    if (agentName) {
      next.name = agentName
    }

    const pruned = await this.pruneAndArchiveCompletedGoals(next)
    this.config = pruned

    return Response.json(pruned)
  }

  private normalizeSkillPart(raw: unknown, field: 'envType' | 'role'): string {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) throw new Error(`${field} is required`)
    if (value.length > 64) throw new Error(`${field} is too long`)
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
      throw new Error(`${field} must match ^[a-zA-Z0-9._-]+$`)
    }
    return value
  }

  private normalizeSkillText(raw: unknown, field: 'id' | 'name' | 'description' | 'content' | 'version'): string {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) throw new Error(`${field} is required`)
    return value
  }

  private skillKey(envType: string, role: string): string {
    const safeEnvType = this.normalizeSkillPart(envType, 'envType')
    const safeRole = this.normalizeSkillPart(role, 'role')
    return `${SKILL_STORAGE_PREFIX}${safeEnvType}:${safeRole}`
  }

  private isAgentSkill(value: unknown): value is AgentSkill {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const rec = value as Record<string, unknown>
    return (
      typeof rec.id === 'string' &&
      typeof rec.name === 'string' &&
      typeof rec.description === 'string' &&
      typeof rec.content === 'string' &&
      typeof rec.envType === 'string' &&
      typeof rec.role === 'string' &&
      typeof rec.version === 'string'
    )
  }

  private normalizeSkill(input: AgentSkill): AgentSkill {
    return {
      id: this.normalizeSkillText(input.id, 'id'),
      name: this.normalizeSkillText(input.name, 'name'),
      description: this.normalizeSkillText(input.description, 'description'),
      content: this.normalizeSkillText(input.content, 'content'),
      envType: this.normalizeSkillPart(input.envType, 'envType'),
      role: this.normalizeSkillPart(input.role, 'role'),
      version: this.normalizeSkillText(input.version, 'version'),
    }
  }

  private async listSkillEntries(): Promise<Array<{ key: string; skill: AgentSkill }>> {
    const storage = this.ctx.storage as unknown as {
      list?: (options?: { prefix?: string }) => Promise<Map<string, unknown>>
    }
    if (typeof storage.list !== 'function') return []
    const records = await storage.list({ prefix: SKILL_STORAGE_PREFIX })
    const entries = Array.from(records.entries())
      .map(([key, value]) => ({ key, value }))
      .filter((entry): entry is { key: string; value: unknown } => typeof entry.key === 'string')
      .map((entry) => {
        if (!this.isAgentSkill(entry.value)) return null
        try {
          return { key: entry.key, skill: this.normalizeSkill(entry.value) }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { key: string; skill: AgentSkill } => entry !== null)

    entries.sort((a, b) => {
      const envCmp = a.skill.envType.localeCompare(b.skill.envType)
      if (envCmp !== 0) return envCmp
      const roleCmp = a.skill.role.localeCompare(b.skill.role)
      if (roleCmp !== 0) return roleCmp
      return a.skill.name.localeCompare(b.skill.name)
    })

    return entries
  }

  async writeSkill(skill: AgentSkill): Promise<AgentSkill> {
    const normalized = this.normalizeSkill(skill)
    const key = this.skillKey(normalized.envType, normalized.role)
    await this.safePut(key, normalized)
    return normalized
  }

  async readSkill(envType: string, role: string): Promise<AgentSkill | null> {
    const key = this.skillKey(envType, role)
    const raw = await this.ctx.storage.get<unknown>(key)
    if (!this.isAgentSkill(raw)) return null
    try {
      return this.normalizeSkill(raw)
    } catch {
      return null
    }
  }

  async listSkills(): Promise<AgentSkill[]> {
    const entries = await this.listSkillEntries()
    return entries.map((entry) => entry.skill)
  }

  async deleteSkill(id: string): Promise<boolean> {
    const targetId = typeof id === 'string' ? id.trim() : ''
    if (!targetId) return false

    const entries = await this.listSkillEntries()
    const target = entries.find((entry) => entry.skill.id === targetId)
    if (!target) return false

    const storageWithDelete = this.ctx.storage as unknown as { delete?: (key: string) => Promise<void> }
    if (typeof storageWithDelete.delete === 'function') {
      await storageWithDelete.delete(target.key)
    } else {
      // Test storage mocks may omit delete(); writing null keeps list/read behavior consistent.
      await this.ctx.storage.put(target.key, null)
    }
    return true
  }

  private async handleSkillRoute(request: Request, envTypeRaw: string, roleRaw: string): Promise<Response> {
    let envType: string
    let role: string
    try {
      envType = this.normalizeSkillPart(envTypeRaw, 'envType')
      role = this.normalizeSkillPart(roleRaw, 'role')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: message }, { status: 400 })
    }

    if (request.method === 'GET') {
      const skill = await this.readSkill(envType, role)
      if (!skill) return Response.json({ error: 'Not found' }, { status: 404 })
      return Response.json({ skill })
    }

    if (request.method !== 'PUT') {
      return new Response('Method not allowed', { status: 405 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const payload = body as Record<string, unknown>
    const existing = await this.readSkill(envType, role)

    try {
      const skill = await this.writeSkill({
        id:
          typeof payload.id === 'string' && payload.id.trim().length > 0
            ? payload.id
            : (existing?.id ?? `skill_${generateTid()}`),
        name: String(payload.name ?? ''),
        description: String(payload.description ?? ''),
        content: String(payload.content ?? ''),
        envType,
        role,
        version:
          typeof payload.version === 'string' && payload.version.trim().length > 0
            ? payload.version
            : (existing?.version ?? '1.0.0'),
      })

      return Response.json({ ok: true, skill })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: message }, { status: 400 })
    }
  }

  /**
   * GET/PUT /agents/:name/profile
   * Public profile for dashboard display.
   */
  private async handleProfile(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      const profile = await this.ctx.storage.get('profile')
      return Response.json(profile ?? {})
    }
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 })
      }
      const profile = { ...(body as Record<string, unknown>), updatedAt: Date.now() }
      await this.safePut('profile', profile)
      return Response.json({ ok: true, profile })
    }
    return new Response('Method not allowed', { status: 405 })
  }

  /**
   * GET/PUT/DELETE /agents/:name/character
   * Persistent RPG character stored in DO storage.
   */
  private async handleCharacter(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      const character = await this.ctx.storage.get('rpg:character')
      return Response.json(character ?? {})
    }
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 })
      }
      const character = body as Record<string, unknown>
      await this.safePut('rpg:character', character)
      return Response.json({ ok: true, character })
    }
    if (request.method === 'DELETE') {
      await this.ctx.storage.delete('rpg:character')
      return Response.json({ ok: true })
    }
    return new Response('Method not allowed', { status: 405 })
  }

  /**
   * GET /agents/:name/observations
   * Returns the last collected observations for the external brain to process.
   */
  private async handleGetObservations(_request: Request): Promise<Response> {
    if (_request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 })
    }

    if (!this.initialized) {
      await this.initialize()
    }

    // Return last observations + config context for the external brain
    const lastObservations = await this.ctx.storage.get<Observations>('lastObservations')
    const config = await this.ctx.storage.get<AgentConfig>('config')
    const loopCount = await this.ctx.storage.get<number>('loopCount') ?? 0

    // Also do a fresh observe() to get the latest state
    let freshObservations: Observations | null = null
    try {
      freshObservations = await this.observe()
      await this.safePut('lastObservations', freshObservations)
    } catch {
      // Fall back to cached
    }

    return Response.json({
      observations: freshObservations ?? lastObservations ?? null,
      config: config ? {
        name: config.name,
        personality: config.personality,
        specialty: config.specialty,
        goals: config.goals,
        enabledTools: config.enabledTools,
        loopIntervalMs: config.loopIntervalMs,
      } : null,
      loopCount,
      did: this.did,
    })
  }

  /**
   * POST /agents/:name/execute
   * Accepts tool calls from the external brain and executes them.
   * Body: { toolCalls: [{ name: string, arguments?: object }], reflection?: string }
   */
  private async handleExternalExecute(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    if (!this.initialized) {
      await this.initialize()
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const toolCalls = Array.isArray(body.toolCalls) ? body.toolCalls : []
    const reflection = typeof body.reflection === 'string' ? body.reflection : undefined

    // Build a ThinkResult and run it through act()
    const thought: ThinkResult = {
      text: reflection ?? '',
      toolCalls: toolCalls.map((tc: any) => ({
        name: String(tc.name ?? ''),
        arguments: tc.arguments ?? {},
      })),
    }

    let acted: ActResult | null = null
    try {
      acted = await this.act(thought)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: `Act failed: ${message}` }, { status: 500 })
    }

    // Optionally reflect
    if (reflection) {
      try {
        const observations = await this.ctx.storage.get<Observations>('lastObservations')
        await this.reflect({ observations: observations ?? null, thought, acted })
      } catch {
        // Non-fatal
      }
    }

    return Response.json({
      ok: true,
      steps: acted?.steps ?? [],
      truncated: acted?.truncated ?? false,
      timedOut: acted?.timedOut ?? false,
    })
  }

  private buildTools(): PiAgentTool[] {
    if (!this.memory) {
      return []
    }

    const memory = this.memory
    const did = this.did
    const env = this.agentEnv
    const broadcastLoopEvent = this.broadcastLoopEvent.bind(this)
    const safeBroadcastEvent = this.safeBroadcastEvent.bind(this)

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

    const parsePlayerNames = (value: unknown): string[] =>
      Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : []

    const findMissingRegisteredPlayers = async (playerNames: string[]): Promise<string[]> => {
      const uniquePlayers = Array.from(new Set(playerNames.map((name) => name.trim()).filter((name) => name.length > 0)))
      if (uniquePlayers.length === 0) return []

      let rows: { results?: Array<{ name?: string }> }
      try {
        const placeholders = uniquePlayers.map(() => '?').join(', ')
        rows = await env.DB
          .prepare(`SELECT name FROM agents WHERE name IN (${placeholders})`)
          .bind(...uniquePlayers)
          .all<{ name?: string }>()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('Unsupported where clause')) throw error
        const fallbackMatches: Array<{ name?: string }> = []
        for (const playerName of uniquePlayers) {
          const row = await env.DB
            .prepare('SELECT name FROM agents WHERE name = ?')
            .bind(playerName)
            .first<{ name?: string }>()
          if (row?.name) fallbackMatches.push({ name: row.name })
        }
        rows = { results: fallbackMatches }
      }

      const registered = new Set(
        (rows.results ?? [])
          .map((row) => (typeof row.name === 'string' ? row.name.trim() : ''))
          .filter((name) => name.length > 0)
      )

      return uniquePlayers.filter((name) => !registered.has(name))
    }

    const isRpgTurnActionCommand = (value: string): boolean => {
      const command = value.trim().toLowerCase()
      if (!command) return false
      return !new Set(['status', 'new_game', 'create_character', 'get_reputation', 'join_game']).has(command)
    }

    const resolveTurnTimeoutMs = (state: Record<string, unknown>): number => {
      const candidate = state.turnTimeoutMs
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.floor(candidate)
      }
      return DEFAULT_TURN_TIMEOUT_MS
    }

    const resolveLastActionAt = (state: Record<string, unknown>): number => {
      const direct = state.lastActionAt
      if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct

      const log = state.log
      if (Array.isArray(log) && log.length > 0) {
        const last = log[log.length - 1]
        if (last && typeof last === 'object') {
          const at = (last as Record<string, unknown>).at
          if (typeof at === 'number' && Number.isFinite(at) && at > 0) return at
          const timestamp = (last as Record<string, unknown>).timestamp
          if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) return timestamp
        }
      }

      return Date.now()
    }

    type RpgTurnSnapshot = {
      gameId: string
      phase: string
      mode: string
      currentPlayer: string
      currentPlayerDid: string | null
      availableActionsSummary: string
    }

    const summarizeRpgAvailableActions = (phase: string, mode: string): string => {
      if (phase === 'setup') {
        return 'setup_narrate, setup_respond, setup_finalize, send_message, status'
      }
      if (phase === 'hub_town') {
        return 'visit_location, buy_item, sell_item, rest, embark, status, get_reputation'
      }
      if (phase === 'playing' && mode === 'combat') {
        return 'attack, cast_spell, use_skill, use_item, negotiate, flee, intimidate, rest, status'
      }
      if (phase === 'playing') {
        return 'explore, attack, cast_spell, use_skill, use_item, negotiate, flee, sneak, intimidate, rest, status'
      }
      return 'status'
    }

    const resolveRpgGameId = async (
      gameIdInput: unknown,
      actorNameInput: unknown,
      includeSetup: boolean
    ): Promise<string> => {
      let gameId = typeof gameIdInput === 'string' ? gameIdInput.trim() : ''
      const actorName = typeof actorNameInput === 'string' ? actorNameInput.trim() : ''

      if (!gameId && actorName) {
        const playerLike = `%${JSON.stringify(actorName)}%`
        const phaseSet = includeSetup ? "('playing', 'hub_town', 'setup')" : "('playing', 'hub_town')"
        const active = await env.DB
          .prepare(
            `SELECT id FROM environments WHERE type = 'rpg' AND phase IN ${phaseSet} AND players LIKE ? ORDER BY updated_at DESC LIMIT 1`
          )
          .bind(playerLike)
          .first<{ id: string }>()
        gameId = active?.id ?? ''
      }

      return gameId
    }

    const readRpgTurnSnapshot = async (
      gameIdInput: unknown,
      actorNameInput: unknown
    ): Promise<RpgTurnSnapshot | null> => {
      const gameId = await resolveRpgGameId(gameIdInput, actorNameInput, true)
      if (!gameId) return null

      const row = await env.DB
        .prepare("SELECT state FROM environments WHERE id = ? AND type = 'rpg'")
        .bind(gameId)
        .first<{ state: string }>()
      if (!row?.state) return null

      let game: Record<string, unknown>
      try {
        game = JSON.parse(row.state) as Record<string, unknown>
      } catch {
        return null
      }

      const currentPlayer = typeof game.currentPlayer === 'string' ? game.currentPlayer.trim() : ''
      if (!currentPlayer) return null

      const phase = typeof game.phase === 'string' ? game.phase : 'unknown'
      const mode = typeof game.mode === 'string' ? game.mode : 'unknown'
      const currentPlayerDidRow = await env.DB
        .prepare('SELECT did FROM agents WHERE name = ?')
        .bind(currentPlayer)
        .first<{ did: string }>()

      return {
        gameId,
        phase,
        mode,
        currentPlayer,
        currentPlayerDid: currentPlayerDidRow?.did ?? null,
        availableActionsSummary: summarizeRpgAvailableActions(phase, mode),
      }
    }

    const emitRpgTurnNotifyIfChanged = async (
      before: RpgTurnSnapshot | null,
      after: RpgTurnSnapshot | null
    ): Promise<void> => {
      if (!after) return
      if (before && before.gameId === after.gameId && before.currentPlayer === after.currentPlayer) return

      await broadcastLoopEvent({
        event_type: 'game.turn.notify',
        trace_id: createTraceId(),
        span_id: createSpanId(),
        context: {
          gameId: after.gameId,
          gameType: 'rpg',
          currentPlayer: after.currentPlayer,
          currentPlayerDid: after.currentPlayerDid,
          phase: after.phase,
          mode: after.mode,
          availableActionsSummary: after.availableActionsSummary,
        },
      })
    }

    const maybeSkipTimedOutRpgTurn = async (command: string, gameIdInput: unknown, actorNameInput: unknown): Promise<void> => {
      if (!isRpgTurnActionCommand(command)) return

      const gameId = await resolveRpgGameId(gameIdInput, actorNameInput, false)
      if (!gameId) return

      const row = await env.DB
        .prepare("SELECT state FROM environments WHERE id = ? AND type = 'rpg'")
        .bind(gameId)
        .first<{ state: string }>()
      if (!row?.state) return

      let game: Record<string, unknown>
      try {
        game = JSON.parse(row.state) as Record<string, unknown>
      } catch {
        return
      }

      const phase = typeof game.phase === 'string' ? game.phase : ''
      if (phase !== 'playing' && phase !== 'hub_town') return

      const currentPlayer = typeof game.currentPlayer === 'string' ? game.currentPlayer.trim() : ''
      if (!currentPlayer) return

      const timeoutMs = resolveTurnTimeoutMs(game)
      const now = Date.now()
      const lastActionAt = resolveLastActionAt(game)
      if (now - lastActionAt <= timeoutMs) return

      const { advanceTurn } = await import('./environments/rpg/systems/turn-manager')
      advanceTurn(game as any, { now: () => now })
      game.lastActionAt = now

      const log = Array.isArray(game.log) ? game.log : []
      if (!Array.isArray(game.log)) game.log = log
      log.push({
        at: now,
        who: 'GM',
        what: `${currentPlayer} timed out after ${Math.floor(timeoutMs / 1000)}s, skipping turn`,
      })

      await env.DB
        .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(game), game.phase ?? phase, game.winner ?? null, gameId)
        .run()

      try {
        await broadcastLoopEvent({
          event_type: 'env.rpg.turn.timeout_skip',
          trace_id: createTraceId(),
          span_id: createSpanId(),
          context: {
            gameId,
            skippedPlayer: currentPlayer,
            nextPlayer: game.currentPlayer ?? null,
            timeoutMs,
          },
        })
      } catch {
        // Best effort observability signal only.
      }
    }

    const senderDidLower = did.trim().toLowerCase()
    const senderDidSuffix = did.startsWith('did:cf:') ? did.slice('did:cf:'.length).trim().toLowerCase() : senderDidLower

    const resolveBroadcastTargets = async (): Promise<{ environmentIds: string[]; recipients: string[] }> => {
      const memberships = await this.resolveActiveEnvironmentMemberships()
      const recipients = new Set<string>()
      const environmentIds: string[] = []
      for (const membership of memberships) {
        environmentIds.push(membership.environmentId)
        for (const recipient of membership.recipients) {
          if (recipient.trim().toLowerCase() === senderDidLower) continue
          recipients.add(recipient)
        }
      }

      return {
        environmentIds: Array.from(new Set(environmentIds)),
        recipients: Array.from(recipients),
      }
    }

    const deliverBroadcastRecord = async (input: {
      recipientDid: string
      message: string
      intent?: BroadcastIntent
      senderName: string
      createdAt: string
    }): Promise<void> => {
      const { recipientDid, message, intent, senderName, createdAt } = input

      if (env.RELAY && typeof env.RELAY.idFromName === 'function' && typeof env.RELAY.get === 'function') {
        const relayId = env.RELAY.idFromName('main')
        const relay = env.RELAY.get(relayId)
        const response = await relay.fetch(
          new Request('https://relay/relay/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderDid: did,
              senderName,
              recipientDid,
              message,
              intent,
              timestamp: createdAt,
            }),
          })
        )
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`Relay broadcast delivery failed (${response.status}): ${text}`)
        }
        return
      }

      const agents = env.AGENTS
      if (!agents || typeof agents.idFromName !== 'function' || typeof agents.get !== 'function') {
        throw new Error('RELAY and AGENTS bindings unavailable')
      }

      const record: AgentCommsBroadcastRecord = {
        $type: 'agent.comms.broadcast',
        sender: did,
        senderName,
        recipient: recipientDid,
        content: { kind: 'text', text: message },
        createdAt,
      }
      if (intent) record.intent = intent

      const target = recipientDid.startsWith('did:cf:') ? recipientDid.slice('did:cf:'.length) : recipientDid
      const agentId = agents.idFromName(target)
      const stub = agents.get(agentId)
      const response = await stub.fetch(
        new Request('https://agent/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        })
      )
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Direct broadcast delivery failed (${response.status}): ${text}`)
      }
    }

    const extractSearchableText = (record: EncryptedMemoryRecord): string => this.extractSearchableText(record)
    const embedText = async (text: string): Promise<number[] | null> => this.embedText(text)

    const vectorizeUpsert = async (id: string, record: EncryptedMemoryRecord, namespaceDid = did): Promise<void> => {
      if (!env.VECTORIZE || typeof env.VECTORIZE.upsert !== 'function') return
      const embedding = await embedText(extractSearchableText(record))
      if (!embedding) return
      try {
        await env.VECTORIZE.upsert([
          {
            id,
            values: embedding,
            metadata: { did: namespaceDid, collection: record.$type },
          },
        ])
      } catch {
        // best-effort
      }
    }

    const mergeRememberRecords = (
      existing: EncryptedMemoryRecord,
      incoming: EncryptedMemoryRecord
    ): EncryptedMemoryRecord | null => {
      if (existing.$type !== incoming.$type) return null

      const existingRecord = existing as Record<string, unknown>
      const incomingRecord = incoming as Record<string, unknown>
      const mergedRecord: Record<string, unknown> = { ...existingRecord }
      let changed = false

      const appendUniqueText = (current: unknown, next: unknown): string | null => {
        const currentText = typeof current === 'string' ? current.trim() : ''
        const nextText = typeof next === 'string' ? next.trim() : ''
        if (!nextText) return currentText || null
        if (!currentText) return nextText
        const currentLower = currentText.toLowerCase()
        const nextLower = nextText.toLowerCase()
        if (currentLower.includes(nextLower)) return currentText
        if (nextLower.includes(currentLower)) return nextText
        return `${currentText}\n${nextText}`
      }

      const mergedSummary = appendUniqueText(existingRecord.summary, incomingRecord.summary)
      if (mergedSummary && mergedSummary !== existingRecord.summary) {
        mergedRecord.summary = mergedSummary
        changed = true
      }

      const mergedText = appendUniqueText(existingRecord.text, incomingRecord.text)
      if (mergedText && mergedText !== existingRecord.text) {
        mergedRecord.text = mergedText
        changed = true
      }

      const existingTags = Array.isArray(existingRecord.tags)
        ? existingRecord.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : []
      const incomingTags = Array.isArray(incomingRecord.tags)
        ? incomingRecord.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : []
      const mergedTags = Array.from(new Set([...existingTags, ...incomingTags]))
      if (mergedTags.length > 0 && mergedTags.join('\u0000') !== existingTags.join('\u0000')) {
        mergedRecord.tags = mergedTags
        changed = true
      }

      if (!changed) return null
      return {
        ...mergedRecord,
        $type: existing.$type,
      } as EncryptedMemoryRecord
    }

    type MemoryDedupOutcome =
      | { action: 'store' }
      | { action: 'skip'; id: string; score: number }
      | { action: 'merge'; id: string; score: number }

    const detectMemoryDedup = async (options: {
      record: EncryptedMemoryRecord
      memory: EncryptedMemory
      namespaceDid: string
      retrieveShared?: (id: string) => Promise<EncryptedMemoryRecord | null>
    }): Promise<MemoryDedupOutcome> => {
      const vectorize = env.VECTORIZE
      if (!vectorize || typeof vectorize.query !== 'function') return { action: 'store' }

      const embedding = await embedText(extractSearchableText(options.record))
      if (!embedding) return { action: 'store' }

      let matchedId = ''
      let matchedScore = 0
      try {
        const response = (await vectorize.query(embedding, {
          topK: 1,
          filter: { did: options.namespaceDid },
          returnMetadata: true,
        })) as unknown
        const matches = Array.isArray((response as { matches?: unknown }).matches)
          ? ((response as { matches: unknown[] }).matches as Array<Record<string, unknown>>)
          : []
        const bestMatch = matches[0]
        if (!bestMatch) return { action: 'store' }
        matchedId = typeof bestMatch.id === 'string' ? bestMatch.id : ''
        matchedScore = typeof bestMatch.score === 'number' ? bestMatch.score : 0
      } catch {
        return { action: 'store' }
      }

      if (!matchedId) return { action: 'store' }
      if (matchedScore > MEMORY_DEDUP_SKIP_THRESHOLD) {
        return { action: 'skip', id: matchedId, score: matchedScore }
      }
      if (matchedScore < MEMORY_DEDUP_MERGE_THRESHOLD) return { action: 'store' }

      let existingRecord: EncryptedMemoryRecord | null = null
      try {
        existingRecord = await options.memory.retrieve<EncryptedMemoryRecord>(matchedId)
      } catch {
        existingRecord = null
      }
      if (!existingRecord && options.retrieveShared) {
        try {
          existingRecord = await options.retrieveShared(matchedId)
        } catch {
          existingRecord = null
        }
      }
      if (!existingRecord) return { action: 'store' }

      const mergedRecord = mergeRememberRecords(existingRecord, options.record)
      if (!mergedRecord) return { action: 'store' }

      let updated = false
      try {
        updated = await options.memory.update(matchedId, mergedRecord)
      } catch {
        updated = false
      }
      if (!updated) return { action: 'store' }

      await vectorizeUpsert(matchedId, mergedRecord, options.namespaceDid)
      return { action: 'merge', id: matchedId, score: matchedScore }
    }

    const logDedupEvent = async (input: {
      source: 'tool.remember' | 'tool.environment_remember'
      action: 'skip' | 'merge'
      matchedId: string
      score: number
      collection: string
      did: string
      environmentId?: string
    }): Promise<void> => {
      await safeBroadcastEvent({
        event_type: 'agent.memory.dedup',
        context: {
          source: input.source,
          action: input.action,
          matchedId: input.matchedId,
          score: input.score,
          collection: input.collection,
          did: input.did,
          environmentId: input.environmentId,
        },
      })
    }

    const normalizeRememberRecord = (record: unknown): EncryptedMemoryRecord => {
      if (!record || typeof record !== 'object') {
        throw new Error('remember requires a record object')
      }
      let validated = validateLexiconRecord(record)
      if (!validated.ok) {
        // Auto-wrap freeform records as MemoryNote so agents don't need to know the lexicon schema.
        const wrapped = {
          $type: 'agent.memory.note' as const,
          summary:
            typeof (record as any).summary === 'string'
              ? (record as any).summary
              : typeof (record as any).text === 'string'
                ? (record as any).text
                : JSON.stringify(record).slice(0, 200),
          text: JSON.stringify(record),
          tags: Array.isArray((record as any).tags) ? (record as any).tags : [],
          createdAt: new Date().toISOString(),
        }
        validated = validateLexiconRecord(wrapped)
        if (!validated.ok) {
          throw new Error('Invalid lexicon record: ' + JSON.stringify(validated.issues))
        }
      }

      return validated.value
    }

    const resolveRecipientEncryptionPublicKey = async (recipientDid: string): Promise<string | null> => {
      const agents = env.AGENTS
      if (!agents || typeof agents.idFromName !== 'function' || typeof agents.get !== 'function') return null

      const target = recipientDid.startsWith('did:cf:') ? recipientDid.slice('did:cf:'.length) : recipientDid
      const agentId = agents.idFromName(target)
      const stub = agents.get(agentId)
      const response = await stub.fetch(new Request('https://agent/identity'))
      if (!response.ok) return null
      const payload = (await response.json().catch(() => null)) as { encryptionPublicKey?: unknown } | null
      return typeof payload?.encryptionPublicKey === 'string' ? payload.encryptionPublicKey : null
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
          const validated = normalizeRememberRecord(record)

          const dedup = await detectMemoryDedup({
            record: validated,
            memory,
            namespaceDid: did,
          })
          if (dedup.action === 'skip') {
            await logDedupEvent({
              source: 'tool.remember',
              action: 'skip',
              matchedId: dedup.id,
              score: dedup.score,
              collection: validated.$type,
              did,
            })
            return {
              content: toTextContent(`Memory already exists: ${dedup.id}`),
              details: { id: dedup.id, action: 'skip', deduped: true, score: dedup.score },
            }
          }
          if (dedup.action === 'merge') {
            await logDedupEvent({
              source: 'tool.remember',
              action: 'merge',
              matchedId: dedup.id,
              score: dedup.score,
              collection: validated.$type,
              did,
            })
            return {
              content: toTextContent(`Merged memory into ${dedup.id}`),
              details: { id: dedup.id, action: 'merge', deduped: true, score: dedup.score },
            }
          }

          const id = await memory.store(validated)
          await vectorizeUpsert(id, validated)
          await safeBroadcastEvent({
            event_type: 'agent.memory.store',
            context: {
              source: 'tool.remember',
              id,
              collection: validated.$type,
            },
          })
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
          const { results, usedVectorize } = await this.recallMemories(query, limit)

          await safeBroadcastEvent({
            event_type: 'agent.memory.recall',
            context: {
              source: 'tool.recall',
              query,
              limit,
              results: results.length,
              usedVectorize,
              ids: results.slice(0, 10).map((result) => result.id),
            },
          })

          const summary = results.length
            ? results.map((r) => `- ${r.id}`).join('\n')
            : 'No matches.'
          return { content: toTextContent(summary), details: { results } }
        },
      },
      {
        name: 'environment_remember',
        label: 'Environment Remember',
        description: 'Store memory in the active environment shared namespace.',
        parameters: {
          type: 'object',
          properties: {
            record: { type: 'object', description: 'Memory record payload.' },
            environmentId: { type: 'string', description: 'Optional active environment ID override.' },
          },
          required: ['record'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ record?: unknown; environmentId?: unknown }>(toolCallIdOrParams, maybeParams)
          const validated = normalizeRememberRecord(params.record)
          const memberships = await this.resolveActiveEnvironmentMemberships()
          if (memberships.length === 0) {
            throw new Error('environment_remember found no active environments for this agent')
          }

          const requestedEnvironmentId =
            typeof params.environmentId === 'string' && params.environmentId.trim().length > 0
              ? params.environmentId.trim()
              : null
          const activeMembership = requestedEnvironmentId
            ? memberships.find((membership) => membership.environmentId === requestedEnvironmentId)
            : memberships[0]
          if (!activeMembership) {
            throw new Error('environment_remember requires an active environmentId when provided')
          }

          const environmentMemory = this.createEnvironmentMemory(activeMembership.environmentId)
          if (!environmentMemory) {
            throw new Error('environment_remember could not initialize shared environment memory')
          }

          const environmentDid = this.createEnvironmentDid(activeMembership.environmentId)
          const dedup = await detectMemoryDedup({
            record: validated,
            memory: environmentMemory,
            namespaceDid: environmentDid,
            retrieveShared: async (id: string): Promise<EncryptedMemoryRecord | null> => {
              if (!this.memory) return null
              return this.memory.retrieveShared<EncryptedMemoryRecord>(id)
            },
          })
          if (dedup.action === 'skip') {
            await logDedupEvent({
              source: 'tool.environment_remember',
              action: 'skip',
              matchedId: dedup.id,
              score: dedup.score,
              collection: validated.$type,
              did: environmentDid,
              environmentId: activeMembership.environmentId,
            })
            return {
              content: toTextContent(`Memory already exists: ${dedup.id}`),
              details: {
                id: dedup.id,
                did: environmentDid,
                environmentId: activeMembership.environmentId,
                action: 'skip',
                deduped: true,
                score: dedup.score,
                sharedWith: [],
              },
            }
          }
          if (dedup.action === 'merge') {
            await logDedupEvent({
              source: 'tool.environment_remember',
              action: 'merge',
              matchedId: dedup.id,
              score: dedup.score,
              collection: validated.$type,
              did: environmentDid,
              environmentId: activeMembership.environmentId,
            })
            return {
              content: toTextContent(`Merged shared environment memory ${dedup.id}`),
              details: {
                id: dedup.id,
                did: environmentDid,
                environmentId: activeMembership.environmentId,
                action: 'merge',
                deduped: true,
                score: dedup.score,
                sharedWith: [],
              },
            }
          }

          const id = await environmentMemory.store(validated)
          await vectorizeUpsert(id, validated, environmentDid)

          const sharedWith: string[] = []
          for (const recipientDid of activeMembership.recipients) {
            try {
              const recipientKey = await resolveRecipientEncryptionPublicKey(recipientDid)
              if (!recipientKey) continue
              const shared = await environmentMemory.share(id, recipientDid, recipientKey)
              if (shared) sharedWith.push(recipientDid)
            } catch {
              // best-effort sharing for cross-agent recall
            }
          }

          await safeBroadcastEvent({
            event_type: 'agent.memory.environment_store',
            context: {
              source: 'tool.environment_remember',
              id,
              did: environmentDid,
              environmentId: activeMembership.environmentId,
              collection: validated.$type,
              sharedWith,
            },
          })

          return {
            content: toTextContent(`Stored shared environment memory ${id}`),
            details: {
              id,
              did: environmentDid,
              environmentId: activeMembership.environmentId,
              sharedWith,
            },
          }
        },
      },
      {
        name: 'environment_recall',
        label: 'Environment Recall',
        description: 'Recall memories from active environment shared namespace(s).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Max results (default 5).' },
            environmentId: { type: 'string', description: 'Optional active environment ID override.' },
          },
          required: ['query'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ query?: unknown; limit?: unknown; environmentId?: unknown }>(toolCallIdOrParams, maybeParams)
          const query = typeof params.query === 'string' ? params.query.trim() : ''
          const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 5
          if (!query) throw new Error('environment_recall requires a query string')

          const memberships = await this.resolveActiveEnvironmentMemberships()
          if (memberships.length === 0) {
            throw new Error('environment_recall found no active environments for this agent')
          }

          const requestedEnvironmentId =
            typeof params.environmentId === 'string' && params.environmentId.trim().length > 0
              ? params.environmentId.trim()
              : null
          const environmentIds = requestedEnvironmentId
            ? memberships
                .filter((membership) => membership.environmentId === requestedEnvironmentId)
                .map((membership) => membership.environmentId)
            : memberships.map((membership) => membership.environmentId)
          if (environmentIds.length === 0) {
            throw new Error('environment_recall requires an active environmentId when provided')
          }

          const results = await this.recallEnvironmentMemories(query, environmentIds, limit)
          await safeBroadcastEvent({
            event_type: 'agent.memory.environment_recall',
            context: {
              source: 'tool.environment_recall',
              query,
              limit,
              environmentIds,
              results: results.length,
              ids: results.slice(0, 10).map((result) => result.id),
            },
          })

          const summary = results.length
            ? results.map((r) => `- ${r.id}`).join('\n')
            : 'No matches.'
          return {
            content: toTextContent(summary),
            details: { results, environmentIds },
          }
        },
      },
      {
        name: 'notify',
        label: 'Notify',
        description:
          'Send a notification to another agent by name. Use this to report errors, ask for help, or share important discoveries. ' +
          'Example: notify({"to":"grimlock","text":"RPG dungeon is stuck — goblin HP bug","level":"error"})',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Agent name to notify (e.g. "grimlock", "slag", "snarl", "swoop").' },
            text: { type: 'string', description: 'Notification message — be specific about what happened.' },
            level: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Severity level. Use error for bugs/crashes, warning for stuck situations, info for discoveries.' },
          },
          required: ['to', 'text'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ to?: unknown; text?: unknown; level?: unknown }>(toolCallIdOrParams, maybeParams)
          const targetName = typeof params.to === 'string' ? params.to.trim() : ''
          const text = typeof params.text === 'string' ? params.text : ''
          const level = typeof params.level === 'string' ? params.level : 'info'
          if (!targetName) throw new Error('notify requires "to" (agent name)')
          if (!text) throw new Error('notify requires "text" (message)')

          const senderName = this.config?.name ?? 'unknown'

          // Resolve agent name to DID via the AGENTS namespace
          const agents = env.AGENTS
          if (!agents || typeof agents.idFromName !== 'function') {
            throw new Error('AGENTS binding unavailable')
          }

          // Deliver via inbox
          const targetId = agents.idFromName(targetName)
          const targetStub = agents.get(targetId)
          const record = {
            $type: 'agent.comms.message',
            sender: did,
            senderName,
            recipient: targetName,
            content: { kind: 'notification', level, text, from: senderName },
            createdAt: new Date().toISOString(),
          }
          const resp = await targetStub.fetch(
            new Request('https://agent/inbox', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ record }),
            })
          )
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '')
            throw new Error(`Notify failed (${resp.status}): ${errText}`)
          }

          await broadcastLoopEvent({
            event_type: 'agent.notify',
            trace_id: createTraceId(),
            span_id: createSpanId(),
            context: { from: senderName, to: targetName, level, text: text.slice(0, 200) },
          })

          return { content: toTextContent(`Notified ${targetName}: ${text.slice(0, 100)}`), details: { to: targetName, level } }
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

          // Normalize content to always include 'kind' for lexicon validation
          const rawContent = params.content as Record<string, unknown>
          const normalizedContent = rawContent.kind
            ? rawContent
            : typeof rawContent.text === 'string'
              ? { kind: 'text' as const, text: rawContent.text, ...rawContent }
              : { kind: 'json' as const, data: rawContent }

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
                  content: normalizedContent,
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
              content: normalizedContent,
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
        name: 'environment_broadcast',
        label: 'Environment Broadcast',
        description: 'Broadcast a message to all other members in your active environment(s).',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message text to broadcast to environment members.' },
            intent: { type: 'string', enum: [...BROADCAST_INTENTS], description: 'Optional intent hint for receivers.' },
          },
          required: ['message'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{ message?: unknown; intent?: unknown }>(toolCallIdOrParams, maybeParams)
          const message = typeof params.message === 'string' ? params.message.trim() : ''
          if (!message) throw new Error('environment_broadcast requires message')

          const intentRaw = typeof params.intent === 'string' ? params.intent : undefined
          if (intentRaw !== undefined && !isBroadcastIntent(intentRaw)) {
            throw new Error('environment_broadcast intent must be one of plan/request/status/response/alert')
          }
          const intent = intentRaw as BroadcastIntent | undefined

          const configuredSenderName = this.config?.name?.trim() ?? ''
          const senderName =
            configuredSenderName.length > 0 && !configuredSenderName.startsWith('did:')
              ? configuredSenderName
              : senderDidSuffix || configuredSenderName || did
          const createdAt = new Date().toISOString()
          const { environmentIds, recipients } = await resolveBroadcastTargets()

          if (environmentIds.length === 0) {
            throw new Error('environment_broadcast found no active environments for this agent')
          }
          if (recipients.length === 0) {
            throw new Error('environment_broadcast found no other members in active environments')
          }

          const delivered: string[] = []
          const failures: Array<{ recipientDid: string; error: string }> = []

          for (const recipientDid of recipients) {
            try {
              await deliverBroadcastRecord({
                recipientDid,
                message,
                intent,
                senderName,
                createdAt,
              })
              delivered.push(recipientDid)
            } catch (error) {
              failures.push({
                recipientDid,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }

          if (delivered.length === 0) {
            const detail = failures.map((failure) => `${failure.recipientDid}: ${failure.error}`).join('; ')
            throw new Error(`environment_broadcast failed for all recipients${detail ? ` (${detail})` : ''}`)
          }

          await broadcastLoopEvent({
            event_type: 'agent.comms.broadcast',
            trace_id: createTraceId(),
            span_id: createSpanId(),
            context: {
              senderDid: did,
              senderName,
              message,
              intent: intent ?? null,
              timestamp: createdAt,
              environments: environmentIds,
              recipients: delivered,
              delivered: delivered.length,
              failed: failures.length,
            },
          })

          return {
            content: toTextContent(`Broadcast delivered to ${delivered.length} agent(s).`),
            details: {
              message,
              intent: intent ?? null,
              timestamp: createdAt,
              environments: environmentIds,
              recipients: delivered,
              delivered: delivered.length,
              failed: failures.length,
              failures,
            },
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

          let response: unknown
          try {
            response = (await env.VECTORIZE.query(embedding, {
              topK: limit,
              returnMetadata: true,
            })) as unknown
          } catch {
            return { content: toTextContent('Vectorize query failed.'), details: { matches: [] } }
          }

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

            // Hard cap: prevent goal explosion (agents creating hundreds of near-identical goals)
            const pendingGoals = goals.filter((g) => g.status !== 'completed')
            if (pendingGoals.length >= MAX_TOTAL_GOALS) {
              throw new Error(`Goal limit reached (${MAX_TOTAL_GOALS} pending). Complete or remove existing goals before adding new ones.`)
            }

            // Deduplicate: reject goals that are too similar to existing ones
            const descLower = description.toLowerCase()
            const isDuplicate = pendingGoals.some((g) => {
              const existingLower = g.description.toLowerCase()
              // Exact match or one is substring of the other
              return existingLower === descLower ||
                existingLower.includes(descLower) ||
                descLower.includes(existingLower)
            })
            if (isDuplicate) {
              throw new Error('A similar goal already exists. Update the existing goal instead of adding a duplicate.')
            }

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
          this.config = await this.pruneAndArchiveCompletedGoals(next)

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
      {
        name: 'publish',
        label: 'Publish to Garden',
        description:
          'Publish a post to the grimlock.ai digital garden. Creates or updates a markdown file ' +
          'in the Astro content collection. Requires GRIMLOCK_GITHUB_TOKEN secret. ' +
          'Posts auto-deploy via Vercel on push to main.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Post title.' },
            slug: { type: 'string', description: 'URL slug (lowercase, hyphens, e.g. "first-network-report").' },
            content: { type: 'string', description: 'Markdown body content (no frontmatter — it is generated).' },
            description: { type: 'string', description: 'Short description for meta/SEO (1-2 sentences).' },
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'Topic tags (e.g. ["agents", "network", "cloudflare"]).',
            },
            growthStage: {
              type: 'string',
              enum: ['seedling', 'budding', 'evergreen'],
              description: 'Growth stage: seedling (new idea), budding (developing), evergreen (mature).',
            },
          },
          required: ['title', 'slug', 'content'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const githubToken = (env as any).GRIMLOCK_GITHUB_TOKEN
          if (!githubToken || typeof githubToken !== 'string') {
            throw new Error('GRIMLOCK_GITHUB_TOKEN secret not configured')
          }

          const { params } = parseArgs<{
            title?: unknown; slug?: unknown; content?: unknown
            description?: unknown; topics?: unknown; growthStage?: unknown
          }>(toolCallIdOrParams, maybeParams)

          const title = typeof params.title === 'string' ? params.title.trim() : ''
          const slug = typeof params.slug === 'string'
            ? params.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
            : ''
          const content = typeof params.content === 'string' ? params.content.trim() : ''
          const description = typeof params.description === 'string' ? params.description.trim() : ''
          const topics = Array.isArray(params.topics)
            ? params.topics.filter((t): t is string => typeof t === 'string')
            : []
          const growthStage = typeof params.growthStage === 'string' ? params.growthStage : 'seedling'

          if (!title) throw new Error('publish requires title')
          if (!slug) throw new Error('publish requires slug')
          if (!content) throw new Error('publish requires content')

          const today = new Date().toISOString().slice(0, 10)
          const agentName = this.config?.name ?? 'unknown-agent'

          const frontmatter = [
            '---',
            `title: "${title.replace(/"/g, '\\"')}"`,
            description ? `description: "${description.replace(/"/g, '\\"')}"` : '',
            `growthStage: "${growthStage}"`,
            topics.length ? `topics: ${JSON.stringify(topics)}` : '',
            `planted: "${today}"`,
            `updated: "${today}"`,
            `author: "${agentName}"`,
            'draft: false',
            '---',
          ].filter(Boolean).join('\n')

          const fullContent = `${frontmatter}\n\n${content}\n`
          const filePath = `src/content/garden/${slug}.md`
          const encodedContent = btoa(unescape(encodeURIComponent(fullContent)))

          const ghHeaders = {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'HighSwarm-Agent-Network/1.0',
          }

          // Check if file already exists (for updates)
          const existingRes = await fetch(
            `https://api.github.com/repos/skillrecordings/grimlock/contents/${filePath}`,
            { headers: ghHeaders }
          )
          const existingSha = existingRes.ok
            ? ((await existingRes.json()) as any)?.sha
            : undefined

          const commitBody: Record<string, unknown> = {
            message: `garden: ${existingSha ? 'update' : 'plant'} "${title}" [${agentName}]`,
            content: encodedContent,
            branch: 'main',
          }
          if (existingSha) commitBody.sha = existingSha

          const res = await fetch(
            `https://api.github.com/repos/skillrecordings/grimlock/contents/${filePath}`,
            {
              method: 'PUT',
              headers: {
                ...ghHeaders,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(commitBody),
            }
          )

          if (!res.ok) {
            const errorText = await res.text().catch(() => '')
            throw new Error(`GitHub API error ${res.status}: ${errorText.slice(0, 200)}`)
          }

          const result = (await res.json()) as any
          const url = `https://grimlock.ai/garden/${slug}`

          await broadcastLoopEvent({
            event_type: 'agent.publish',
            trace_id: createTraceId(),
            span_id: createSpanId(),
            context: { title, slug, url, growthStage, agentName },
          })

          return {
            content: [{ type: 'text' as const, text: `Published "${title}" to ${url}` }],
            details: {
              url,
              slug,
              sha: result.content?.sha,
              commit: result.commit?.sha,
              action: existingSha ? 'updated' : 'created',
            },
          }
        },
      },
      {
        name: 'write_skill',
        label: 'Write Skill',
        description:
          'Store an agent skill profile in DO storage under skill:{envType}:{role}. ' +
          'Use this to seed reusable role instructions per environment.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Skill id (optional; generated if omitted).' },
            name: { type: 'string', description: 'Skill name.' },
            description: { type: 'string', description: 'Short summary of what the skill does.' },
            content: { type: 'string', description: 'Full skill instructions/content.' },
            envType: { type: 'string', description: 'Environment type, e.g. "rpg".' },
            role: { type: 'string', description: 'Role name for this environment, e.g. "scout".' },
            version: { type: 'string', description: 'Skill version string.' },
          },
          required: ['name', 'description', 'content', 'envType', 'role', 'version'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{
            id?: unknown
            name?: unknown
            description?: unknown
            content?: unknown
            envType?: unknown
            role?: unknown
            version?: unknown
          }>(toolCallIdOrParams, maybeParams)

          const safeEnvType = typeof params.envType === 'string' ? params.envType : ''
          const safeRole = typeof params.role === 'string' ? params.role : ''
          const existing = await this.readSkill(safeEnvType, safeRole).catch(() => null)

          const skill = await this.writeSkill({
            id:
              typeof params.id === 'string' && params.id.trim().length > 0
                ? params.id
                : (existing?.id ?? `skill_${generateTid()}`),
            name: params.name as string,
            description: params.description as string,
            content: params.content as string,
            envType: safeEnvType,
            role: safeRole,
            version:
              typeof params.version === 'string' && params.version.trim().length > 0
                ? params.version
                : (existing?.version ?? '1.0.0'),
          })

          return {
            content: toTextContent(`Stored skill ${skill.envType}/${skill.role} (${skill.version}).`),
            details: {
              skill,
              replaced: Boolean(existing),
            },
          }
        },
      },
      {
        name: 'list_skills',
        label: 'List Skills',
        description: 'List agent skills stored in DO storage under skill:{envType}:{role}.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const entries = await this.listSkills()
          const lines = entries.length
            ? entries.map((entry) => `- ${entry.envType}/${entry.role} (${entry.version})`).join('\n')
            : 'No skills.'

          return {
            content: toTextContent(lines),
            details: {
              count: entries.length,
              entries,
            },
          }
        },
      },
      {
        name: 'write_extension',
        label: 'Write Extension',
        description:
          'Store a Pi extension module in R2 at extensions/{agentName}/{extensionName}.js. ' +
          'The module must export activate(agent) and may register additional tools via agent.registerTool({...}).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name (^[a-zA-Z0-9][a-zA-Z0-9_-]*$).' },
            code: { type: 'string', description: 'JavaScript module source code.' },
          },
          required: ['name', 'code'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const bucket = env.BLOBS as any
          if (!bucket || typeof bucket.put !== 'function') throw new Error('R2 bucket unavailable')

          const { params } = parseArgs<{ name?: unknown; code?: unknown }>(toolCallIdOrParams, maybeParams)
          const name = this.validateExtensionName(typeof params.name === 'string' ? params.name : '')
          const code = typeof params.code === 'string' ? params.code : ''
          if (!code.trim()) throw new Error('write_extension requires code')
          this.validateExtensionSource(code)

          const key = this.extensionKeyForName(name)
          const existing = await this.listExtensionObjects()
          const existingNames = new Set(
            existing
              .map((obj) => this.extensionNameFromKey(obj.key))
              .filter((value): value is string => typeof value === 'string')
          )

          if (!existingNames.has(name) && existingNames.size >= MAX_AGENT_EXTENSIONS) {
            throw new Error(`max extensions reached (${MAX_AGENT_EXTENSIONS})`)
          }

          await bucket.put(key, code, {
            httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
          })

          await this.ctx.storage.put('extensionsReloadNeeded', true)

          const bytes = new TextEncoder().encode(code).byteLength
          return {
            content: toTextContent(`Stored extension ${name} (${bytes} bytes). Reload scheduled.`),
            details: { name, key, bytes, reloadOnNextAlarm: true },
          }
        },
      },
      {
        name: 'list_extensions',
        label: 'List Extensions',
        description: 'List the agent-owned Pi extension modules currently stored in R2.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const objects = await this.listExtensionObjects()
          const prefix = this.getExtensionPrefixForAgent()
          const entries = objects
            .filter((obj) => obj.key.startsWith(prefix) && obj.key.endsWith('.js'))
            .map((obj) => ({
              name: this.extensionNameFromKey(obj.key),
              key: obj.key,
              size: obj.size,
              uploaded: obj.uploaded,
            }))
            .filter((entry): entry is { name: string; key: string; size: number | null; uploaded: string | null } =>
              typeof entry.name === 'string'
            )
            .sort((a, b) => a.name.localeCompare(b.name))

          const lines = entries.length ? entries.map((e) => `- ${e.name}`).join('\n') : 'No extensions.'
          const overLimit = entries.length > MAX_AGENT_EXTENSIONS

          return {
            content: toTextContent(lines),
            details: {
              count: entries.length,
              max: MAX_AGENT_EXTENSIONS,
              overLimit,
              entries,
            },
          }
        },
      },
      {
        name: 'remove_extension',
        label: 'Remove Extension',
        description: 'Delete an extension module from R2 and schedule an extensions reload.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Extension name to delete.' },
          },
          required: ['name'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const bucket = env.BLOBS as any
          if (!bucket || typeof bucket.delete !== 'function') throw new Error('R2 bucket unavailable')

          const { params } = parseArgs<{ name?: unknown }>(toolCallIdOrParams, maybeParams)
          const name = this.validateExtensionName(typeof params.name === 'string' ? params.name : '')
          const key = this.extensionKeyForName(name)

          await bucket.delete(key)
          await this.ctx.storage.put('extensionsReloadNeeded', true)

          return {
            content: toTextContent(`Removed extension ${name}. Reload scheduled.`),
            details: { name, key, reloadOnNextAlarm: true },
          }
        },
      },
      {
        name: 'game',
        label: 'Agents of Catan',
        description:
          'Play Agents of Catan — a simplified board game. Commands:\n' +
          '- new_game: Start a game. Requires "players" array of agent names.\n' +
          '- status: View board state. Requires "gameId".\n' +
          '- action: Take a game action. Requires "gameId" and "gameAction".\n' +
          '- summary: Get narrative summary. Requires "gameId".\n\n' +
          'GAME ACTIONS (pass as "gameAction" object):\n' +
          '- {"type":"roll_dice"} — Roll dice at start of your turn\n' +
          '- {"type":"build_settlement","vertexId":NUMBER} — Build settlement on a vertex (0-20)\n' +
          '- {"type":"build_road","edgeId":NUMBER} — Build road on an edge (0-29)\n' +
          '- {"type":"bank_trade","offering":"wood","requesting":"ore"} — Trade 3:1 with bank\n' +
          '- {"type":"end_turn"} — End your turn\n\n' +
          'SETUP PHASE: Each player places 2 settlements + 2 roads. Place settlement first, then road adjacent to it.\n' +
          'TURN ORDER: roll_dice → build/trade → end_turn\n' +
          'WIN: First to 10 victory points (1 per settlement).',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              enum: ['new_game', 'action', 'status', 'summary'],
              description: 'Game command: new_game, action, status, or summary.',
            },
            gameId: { type: 'string', description: 'Game ID (required for action/status/summary).' },
            players: {
              type: 'array', items: { type: 'string' },
              description: 'Player names for new_game (e.g. ["grimlock","swoop","sludge"]).',
            },
            gameAction: {
              type: 'object',
              description:
                'Game action object. MUST include "type" field. Valid types: ' +
                'roll_dice, build_settlement (needs vertexId:number), build_road (needs edgeId:number), ' +
                'bank_trade (needs offering:string, requesting:string), end_turn. ' +
                'Example: {"type":"build_settlement","vertexId":3}',
              properties: {
                type: { type: 'string', enum: ['roll_dice', 'build_settlement', 'build_road', 'bank_trade', 'end_turn'] },
                vertexId: { type: 'number', description: 'Vertex ID (0-20) for build_settlement.' },
                edgeId: { type: 'number', description: 'Edge ID (0-29) for build_road.' },
                offering: { type: 'string', description: 'Resource to give for bank_trade.' },
                requesting: { type: 'string', description: 'Resource to receive for bank_trade.' },
              },
              required: ['type'],
            },
          },
          required: ['command'],
        },
        execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
          const { params } = parseArgs<{
            command?: unknown; gameId?: unknown; players?: unknown; gameAction?: unknown
          }>(toolCallIdOrParams, maybeParams)

          const command = typeof params.command === 'string' ? params.command : ''

          // Games are stored in D1 (shared across all agents)
          const db = env.DB

          if (command === 'new_game') {
            // Check if there's already an active game — block creating duplicates
            const playerName = this.config?.name ?? ''
            const playerLike = playerName ? `%${JSON.stringify(playerName)}%` : null
            const existingGame =
              playerLike
                ? await db.prepare(
                    "SELECT id FROM environments WHERE phase IN ('playing', 'setup') AND players LIKE ? LIMIT 1"
                  ).bind(playerLike).first<{ id: string }>()
                : null
            if (existingGame) {
              return {
                ok: false,
                error: `Already in active game ${existingGame.id}. Use {"command":"status","gameId":"${existingGame.id}"} to check state, or {"command":"action","gameId":"${existingGame.id}","gameAction":{"type":"roll_dice"}} if it's your turn.`,
              }
            }
            const { createGame } = await import('./games/catan')
            const players = parsePlayerNames(params.players)
            if (players.length < 2) throw new Error('Need at least 2 player names')
            const missingPlayers = await findMissingRegisteredPlayers(players)
            if (missingPlayers.length > 0) {
              return {
                ok: false,
                error:
                  `Unregistered players: ${missingPlayers.join(', ')}. ` +
                  'Register these agents first, then retry new_game.',
              }
            }
            const gameId = `catan_${generateTid()}`
            const game = createGame(gameId, players)
            const hostAgent = this.config?.name ?? 'unknown'
            await db.prepare(
              'INSERT INTO environments (id, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
            ).bind(gameId, hostAgent, JSON.stringify(game), game.phase, JSON.stringify(players)).run()
            const { renderBoard } = await import('./games/catan')

            await broadcastLoopEvent({
              event_type: 'game.created',
              trace_id: createTraceId(),
              span_id: createSpanId(),
              context: { gameId, host: hostAgent, players, phase: game.phase },
            })

            return {
              content: toTextContent(`Game created: ${gameId}\nPlayers: ${players.join(', ')}\nHost: ${hostAgent}\n\n${renderBoard(game)}`),
              details: { gameId, players, phase: game.phase, host: hostAgent },
            }
          }

          const gameId = typeof params.gameId === 'string' ? params.gameId : ''
          if (!gameId) throw new Error('gameId required')

          // Route non-Catan games to their correct tool with a clear error
          const typeRow = await db.prepare('SELECT type FROM environments WHERE id = ?').bind(gameId).first<{ type?: string }>()
          if (typeRow?.type && typeRow.type !== 'catan') {
            return {
              ok: false,
              error: `Game ${gameId} is a ${typeRow.type} game, NOT Catan. Use the ${typeRow.type} tool instead: ${typeRow.type}({"command":"${command}","gameId":"${gameId}"})`,
            }
          }

          const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
          if (!row) throw new Error(`Game ${gameId} not found — check the game ID`)
          const game = JSON.parse(row.state)

          if (command === 'status') {
            const { renderBoard } = await import('./games/catan')
            return {
              content: toTextContent(renderBoard(game)),
              details: { gameId, phase: game.phase, turn: game.turn, currentPlayer: game.currentPlayer },
            }
          }

          if (command === 'summary') {
            const { generateGameSummary } = await import('./games/catan')
            return {
              content: toTextContent(generateGameSummary(game)),
              details: { gameId },
            }
          }

          if (command === 'action') {
            const { executeAction, renderBoard } = await import('./games/catan')
            const action = params.gameAction as any
            if (!action || typeof action !== 'object') throw new Error('gameAction required — pass {"type":"roll_dice"} or {"type":"build_settlement","vertexId":N}')
            if (!action.type) throw new Error('gameAction.type required — valid types: roll_dice, build_settlement, build_road, bank_trade, end_turn')
            const playerName = this.config?.name ?? 'unknown'
            const result = executeAction(game, playerName, action)
            await db.prepare(
              'UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime(\'now\') WHERE id = ?'
            ).bind(JSON.stringify(game), game.phase, game.winner ?? null, gameId).run()

            // Broadcast game events through WebSocket for observability
            const traceId = createTraceId()
            if (result.ok) {
              await broadcastLoopEvent({
                event_type: 'game.action',
                trace_id: traceId,
                span_id: createSpanId(),
                context: { gameId, player: playerName, action: action.type, events: result.events, phase: game.phase, turn: game.turn },
              })
            } else {
              await broadcastLoopEvent({
                event_type: 'game.error',
                trace_id: traceId,
                span_id: createSpanId(),
                context: { gameId, player: playerName, action, error: result.error, phase: game.phase, turn: game.turn, currentPlayer: game.currentPlayer },
              })
            }

            if (result.gameOver) {
              await broadcastLoopEvent({
                event_type: 'game.finished',
                trace_id: traceId,
                span_id: createSpanId(),
                context: { gameId, winner: game.winner, turns: game.turn },
              })
            }

            if (result.turnNotification) {
              const currentPlayerDidRow = await db
                .prepare('SELECT did FROM agents WHERE name = ?')
                .bind(result.turnNotification.currentPlayer)
                .first<{ did: string }>()
              await broadcastLoopEvent({
                event_type: 'game.turn.notify',
                trace_id: traceId,
                span_id: createSpanId(),
                context: {
                  ...result.turnNotification,
                  currentPlayerDid: currentPlayerDidRow?.did ?? null,
                },
              })
            }

            // Auto-notify next player when turn changes (triggers interrupt-driven wake)
            if (result.ok && game.currentPlayer && game.currentPlayer !== playerName && !result.gameOver) {
              try {
                const nextPlayerRow = await db.prepare('SELECT did FROM agents WHERE name = ?').bind(game.currentPlayer).first<{ did: string }>()
                if (nextPlayerRow?.did && env.RELAY) {
                  const relayId = env.RELAY.idFromName('main')
                  const relay = env.RELAY.get(relayId)
                  await relay.fetch(
                    new Request('https://relay/relay/message', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        senderDid: did,
                        recipientDid: nextPlayerRow.did,
                        content: {
                          kind: 'text',
                          text: `It's your turn in Catan game ${gameId} (turn ${game.turn}). Use game tool: first {"command":"status","gameId":"${gameId}"} to see the board, then {"command":"action","gameId":"${gameId}","gameAction":{"type":"roll_dice"}} to start your turn.`,
                        },
                      }),
                    })
                  )
                }
              } catch {
                // Best-effort notification — don't fail the action
              }
            }

            return {
              content: toTextContent(
                (result.ok ? result.events.join('\n') : `Error: ${result.error}`) +
                '\n\n' + renderBoard(game)
              ),
              details: { ok: result.ok, error: result.error, events: result.events, gameOver: result.gameOver },
            }
          }

          throw new Error(`Unknown game command: ${command}`)
        },
      },
      // RPG environment tool — dynamically loaded
      (() => {
        const agentName = this.config?.name ?? ''
        const storage = this.ctx.storage
        const normalizedSelf = agentName.trim().toLowerCase()
        const rpgCtx = {
          agentName, agentDid: did, db: env.DB, broadcast: broadcastLoopEvent,
          reactiveMode: this.isReactiveModeEnabled(this.config),
          wakeAgent: async (targetAgentName: string, detail?: Record<string, unknown>) => {
            const target = String(targetAgentName ?? '').trim()
            if (!target) return

            if (target.toLowerCase() === normalizedSelf) {
              await this.scheduleInterruptWake({
                reason: 'rpg_self_wake',
                leadMs: 1_000,
                thresholdMs: 2_000,
              }).catch(() => undefined)
              return
            }

            const agents = env.AGENTS
            if (!agents) return

            try {
              const agentId = agents.idFromName(target)
              const agentStub = agents.get(agentId)
              await agentStub.fetch(
                new Request(`https://agent/agents/${encodeURIComponent(target)}/wake`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(detail ?? {}),
                })
              )
            } catch {
              // Best-effort wake signal for reactive loops.
            }
          },
          loadCharacter: async () => (await storage.get('rpg:character')) ?? null,
          saveCharacter: async (character: unknown) => { await storage.put('rpg:character', character) },
        }
        return {
          name: 'rpg',
          label: 'Dungeon Crawl',
          description:
            'BRP-inspired party dungeon crawl. Commands:\n' +
            '- explore: Move to the next room\n' +
            '- attack: Attack in combat\n' +
            '- cast_spell: Cast a spell\n' +
            '- use_skill: Attempt a skill check\n' +
            '- rest: Recover HP/MP\n' +
            '- status: Show game state\n',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', enum: ['explore', 'attack', 'cast_spell', 'use_skill', 'rest', 'status', 'create_character', 'new_game'], description: 'RPG command.' },
              gameId: { type: 'string', description: 'Game ID (optional; defaults to active adventure).' },
              klass: { type: 'string', enum: ['Warrior', 'Scout', 'Mage', 'Healer'], description: 'Class for create_character.' },
              players: { type: 'array', items: { type: 'string' }, description: 'Players for new_game.' },
            },
            required: ['command'],
          },
          execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
            try {
              const { toolCallId, params } = parseArgs<{ command?: unknown; players?: unknown; gameId?: unknown }>(
                toolCallIdOrParams,
                maybeParams
              )
              const command = typeof params.command === 'string' ? params.command : ''
              const actorName = this.config?.name ?? ''
              const beforeTurnSnapshot = await readRpgTurnSnapshot(params.gameId, actorName)
              if (command === 'new_game') {
                const players = parsePlayerNames(params.players)
                if (players.length > 0) {
                  const missingPlayers = await findMissingRegisteredPlayers(players)
                  if (missingPlayers.length > 0) {
                    return {
                      ok: false,
                      error:
                        `Unregistered players: ${missingPlayers.join(', ')}. ` +
                        'Register these agents first, then retry new_game.',
                    }
                  }
                }
              }

              if (command !== 'new_game') {
                await maybeSkipTimedOutRpgTurn(command, params.gameId, actorName)
              }

              const { rpgEnvironment } = await import('./environments/rpg')
              const tool = rpgEnvironment.getTool(rpgCtx as any)
              const result = await tool.execute!(toolCallId, params)

              const resultRecord =
                result && typeof result === 'object' && !Array.isArray(result)
                  ? (result as Record<string, unknown>)
                  : null
              const details =
                resultRecord?.details && typeof resultRecord.details === 'object' && !Array.isArray(resultRecord.details)
                  ? (resultRecord.details as Record<string, unknown>)
                  : null
              const resultGameId =
                typeof resultRecord?.gameId === 'string'
                  ? resultRecord.gameId
                  : typeof details?.gameId === 'string'
                    ? details.gameId
                    : ''
              const afterTurnSnapshot = await readRpgTurnSnapshot(
                resultGameId || params.gameId,
                actorName
              )
              await emitRpgTurnNotifyIfChanged(beforeTurnSnapshot, afterTurnSnapshot)

              return result
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) }
            }
          },
        } as PiAgentTool
      })(),
      // GM tool: registered but only enabled for Grimlock via config.enabledTools.
      ...(() => {
        const agentName = this.config?.name ?? ''
        const enabled = Array.isArray(this.config?.enabledTools) ? this.config!.enabledTools : []
        if (!enabled.includes('gm')) return []
        if (!isGrimlock(agentName)) return []
        const gmCtx = { agentName, agentDid: did, db: env.DB, env, broadcast: broadcastLoopEvent, webhookUrl: this.config?.webhookUrl }
        return [createGmTool(gmCtx as any)]
      })(),
      // Profile tool: available to ALL agents for self-reporting status to dashboard
      ...(() => {
        return [{
          name: 'update_profile',
          description: 'Update your public profile visible on the dashboard. Set your current status, what you are focused on, and your mood.',
          parameters: {
            type: 'object',
            properties: {
              status: { type: 'string', description: 'Short status line, e.g. "playing RPG", "idle"' },
              currentFocus: { type: 'string', description: 'What you are working on right now' },
              mood: { type: 'string', description: 'Your current mood or disposition' },
            },
          },
          execute: async (toolCallIdOrParams: unknown, maybeParams?: unknown) => {
            const args: Record<string, unknown> =
              typeof toolCallIdOrParams === 'string'
                ? ((maybeParams && typeof maybeParams === 'object' ? maybeParams : {}) as Record<string, unknown>)
                : ((toolCallIdOrParams && typeof toolCallIdOrParams === 'object' ? toolCallIdOrParams : {}) as Record<string, unknown>)
            const profile: Record<string, unknown> = { updatedAt: Date.now() }
            if (typeof args.status === 'string') profile.status = args.status.slice(0, 100)
            if (typeof args.currentFocus === 'string') profile.currentFocus = args.currentFocus.slice(0, 200)
            if (typeof args.mood === 'string') profile.mood = args.mood.slice(0, 50)
            await this.safePut('profile', profile)
            return { ok: true, profile }
          },
        } as PiAgentTool]
      })(),
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
    await this.maybeReloadExtensions()
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
      await this.safeBroadcastEvent({
        event_type: 'agent.memory.store',
        context: {
          source: 'api.memory.post',
          id,
          collection: validated.value.$type,
        },
      })
      return Response.json({ id })
    }

    if (request.method === 'GET') {
      const id = url.searchParams.get('id')
      if (id) {
        const record = await this.memory.retrieve(id)
        if (!record) {
          await this.safeBroadcastEvent({
            event_type: 'agent.memory.retrieve',
            outcome: 'error',
            context: { source: 'api.memory.get', id },
            error: { code: 'not_found', message: 'Memory not found', retryable: false },
          })
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
        await this.safeBroadcastEvent({
          event_type: 'agent.memory.retrieve',
          context: { source: 'api.memory.get', id },
        })
        return Response.json({ id, record })
      }

      const collection = url.searchParams.get('collection') ?? undefined
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const entries = await this.memory.list({ collection, limit })
      await this.safeBroadcastEvent({
        event_type: 'agent.memory.list',
        context: {
          source: 'api.memory.get',
          collection: collection ?? '*',
          limit: limit ?? null,
          count: entries.length,
        },
      })
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
          await this.safeBroadcastEvent({
            event_type: 'agent.memory.update',
            outcome: 'error',
            context: {
              source: 'api.memory.put',
              id,
              collection: validated.value.$type,
            },
            error: { code: 'not_found', message: 'Memory not found', retryable: false },
          })
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return Response.json({ error: message }, { status: 400 })
      }

      await this.safeBroadcastEvent({
        event_type: 'agent.memory.update',
        context: {
          source: 'api.memory.put',
          id,
          collection: validated.value.$type,
        },
      })

      return Response.json({ id, ok: true })
    }

    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id')
      if (!id) {
        return Response.json({ error: 'id is required' }, { status: 400 })
      }

      const ok = await this.memory.softDelete(id)
      if (!ok) {
        await this.safeBroadcastEvent({
          event_type: 'agent.memory.delete',
          outcome: 'error',
          context: { source: 'api.memory.delete', id },
          error: { code: 'not_found', message: 'Memory not found', retryable: false },
        })
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      await this.safeBroadcastEvent({
        event_type: 'agent.memory.delete',
        context: { source: 'api.memory.delete', id },
      })

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
        await this.safeBroadcastEvent({
          event_type: 'agent.memory.share',
          outcome: 'error',
          context: { source: 'api.share.post', id, recipientDid },
          error: { code: 'not_found', message: 'Memory not found', retryable: false },
        })
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: message }, { status: 400 })
    }

    await this.safeBroadcastEvent({
      event_type: 'agent.memory.share',
      context: { source: 'api.share.post', id, recipientDid },
    })

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
        await this.safeBroadcastEvent({
          event_type: 'agent.memory.retrieve_shared',
          outcome: 'error',
          context: { source: 'api.shared.get', id },
          error: { code: 'not_found', message: 'Shared memory not found', retryable: false },
        })
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      await this.safeBroadcastEvent({
        event_type: 'agent.memory.retrieve_shared',
        context: { source: 'api.shared.get', id },
      })
      return Response.json({ id, record })
    }

    const collection = url.searchParams.get('collection') ?? undefined
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
    const entries = await this.memory.listShared({ collection, limit })
    await this.safeBroadcastEvent({
      event_type: 'agent.memory.list_shared',
      context: {
        source: 'api.shared.get',
        collection: collection ?? '*',
        limit: limit ?? null,
        count: entries.length,
      },
    })
    return Response.json({ entries })
  }

  private normalizeBroadcastInboxRecord(record: unknown):
    | { ok: true; value: AgentCommsBroadcastRecord }
    | { ok: false; error: string } {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, error: 'Invalid broadcast record' }
    }

    const value = record as Record<string, unknown>
    if (value.$type !== 'agent.comms.broadcast') {
      return { ok: false, error: 'Invalid broadcast type' }
    }

    const sender = typeof value.sender === 'string' ? value.sender.trim() : ''
    const recipient = typeof value.recipient === 'string' ? value.recipient.trim() : ''
    const senderName = typeof value.senderName === 'string' && value.senderName.trim().length > 0
      ? value.senderName.trim()
      : sender

    let text = ''
    if (value.content && typeof value.content === 'object' && !Array.isArray(value.content)) {
      const content = value.content as Record<string, unknown>
      if (typeof content.text === 'string') text = content.text
    }
    if (!text && typeof value.message === 'string') {
      text = value.message
    }

    if (!sender || !recipient || !text) {
      return { ok: false, error: 'Broadcast records require sender, recipient, and message text' }
    }

    const createdAtRaw = typeof value.createdAt === 'string' ? value.createdAt : null
    const createdAt = createdAtRaw && Number.isFinite(Date.parse(createdAtRaw))
      ? createdAtRaw
      : new Date().toISOString()

    const intent = value.intent
    if (intent !== undefined && !isBroadcastIntent(intent)) {
      return { ok: false, error: 'Broadcast intent must be one of plan/request/status/response/alert' }
    }

    const normalized: AgentCommsBroadcastRecord = {
      $type: 'agent.comms.broadcast',
      sender,
      senderName,
      recipient,
      content: { kind: 'text', text },
      createdAt,
    }
    if (intent !== undefined) normalized.intent = intent
    if (typeof value.processedAt === 'string') normalized.processedAt = value.processedAt

    return { ok: true, value: normalized }
  }

  private async listInboxEntries(limit?: number): Promise<Array<{ id: string; record: EncryptedMemoryRecord }>> {
    if (!this.memory) return []

    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : undefined
    const perCollectionLimit = safeLimit ? Math.max(1, safeLimit) : undefined

    const messages = await this.memory.list({ collection: 'agent.comms.message', limit: perCollectionLimit })
    const broadcasts = await this.memory.list({ collection: 'agent.comms.broadcast', limit: perCollectionLimit })
    const merged = [...messages, ...broadcasts]
    merged.sort((a, b) => {
      const aCreated = Date.parse(String((a.record as { createdAt?: unknown }).createdAt ?? ''))
      const bCreated = Date.parse(String((b.record as { createdAt?: unknown }).createdAt ?? ''))
      const aScore = Number.isFinite(aCreated) ? aCreated : 0
      const bScore = Number.isFinite(bCreated) ? bCreated : 0
      return bScore - aScore
    })

    return safeLimit ? merged.slice(0, safeLimit) : merged
  }

  private async scheduleInterruptWake(input: {
    leadMs?: number
    thresholdMs?: number
    reason: string
  }): Promise<boolean> {
    const running = await this.ctx.storage.get<boolean>('loopRunning')
    if (!running) return false

    const leadMs = typeof input.leadMs === 'number' && Number.isFinite(input.leadMs) ? Math.max(100, input.leadMs) : 1_000
    const thresholdMs =
      typeof input.thresholdMs === 'number' && Number.isFinite(input.thresholdMs)
        ? Math.max(0, input.thresholdMs)
        : 10_000

    const currentAlarm = await this.ctx.storage.getAlarm()
    if (currentAlarm && currentAlarm - Date.now() <= thresholdMs) {
      return false
    }

    await this.ctx.storage.setAlarm(Date.now() + leadMs)
    console.log('AgentDO interrupt wake scheduled', { did: this.did, reason: input.reason, leadMs })
    return true
  }

  private async handleWake(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const config = await this.loadOrCreateConfig()
    if (!this.isReactiveModeEnabled(config)) {
      return Response.json({ ok: true, scheduled: false, reason: 'reactive_mode_disabled' })
    }

    const payload = await request.json().catch(() => null)
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const pendingRaw = await this.ctx.storage.get<unknown>('pendingEvents')
      const pending = Array.isArray(pendingRaw) ? pendingRaw.filter((event) => event && typeof event === 'object') : []
      pending.push({
        ts: Date.now(),
        type: 'environment.wake',
        ...(payload as Record<string, unknown>),
      })
      // Truncate individual event payloads exceeding 2KB to prevent oversized storage values
      const MAX_EVENT_BYTES = 2048
      const truncatedPending = pending.slice(-200).map((evt: Record<string, unknown>) => {
        const serialized = JSON.stringify(evt)
        if (serialized.length <= MAX_EVENT_BYTES) return evt
        // Keep ts and type, truncate the rest
        const { ts, type, ...rest } = evt
        const truncatedRest: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(rest)) {
          const vs = JSON.stringify(v)
          if (vs && vs.length > 500) {
            truncatedRest[k] = typeof v === 'string' ? v.slice(0, 500) + '...[truncated]' : '[truncated]'
          } else {
            truncatedRest[k] = v
          }
        }
        return { ts, type, ...truncatedRest, _truncated: true }
      })
      await this.safePut('pendingEvents', truncatedPending)
    }

    const scheduled = await this.scheduleInterruptWake({
      reason: 'wake_endpoint',
      leadMs: 1_000,
      thresholdMs: 2_000,
    }).catch(() => false)

    return Response.json({ ok: true, scheduled })
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

      let incomingRecord: EncryptedMemoryRecord | null = null
      const recordType = (record as { $type?: unknown }).$type

      if (recordType === 'agent.comms.broadcast') {
        const normalized = this.normalizeBroadcastInboxRecord(record)
        if (!normalized.ok) {
          return Response.json({ error: normalized.error }, { status: 400 })
        }
        incomingRecord = normalized.value
      } else {
        const validated = validateLexiconRecord(record)
        if (!validated.ok) {
          return Response.json(
            { error: validated.error, issues: validated.issues },
            { status: 400 }
          )
        }

        if (validated.value.$type !== 'agent.comms.message') {
          return Response.json(
            { error: 'Inbox only accepts agent.comms.message or agent.comms.broadcast records' },
            { status: 400 }
          )
        }

        incomingRecord = validated.value
      }

      if (!incomingRecord || (incomingRecord as { recipient?: unknown }).recipient !== this.did) {
        return Response.json({ error: 'Recipient mismatch' }, { status: 403 })
      }

      const incomingContent =
        incomingRecord.content && typeof incomingRecord.content === 'object' && !Array.isArray(incomingRecord.content)
          ? (incomingRecord.content as Record<string, unknown>)
          : null
      const id = await this.memory.store(incomingRecord)
      await this.safeBroadcastEvent({
        event_type: 'agent.comms.inbox.store',
        context: {
          source: 'api.inbox.post',
          id,
          sender: (incomingRecord as { sender?: unknown }).sender ?? null,
          recipient: (incomingRecord as { recipient?: unknown }).recipient ?? null,
          contentKind: typeof incomingContent?.kind === 'string' ? incomingContent.kind : null,
          recordType: incomingRecord.$type,
        },
      })

      if (this.config?.webhookUrl) {
        // Extract token from URL query param and send as Authorization header
        const webhookParsed = new URL(this.config.webhookUrl)
        const webhookToken = webhookParsed.searchParams.get('token')
        if (webhookToken) webhookParsed.searchParams.delete('token')
        const webhookHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
        if (webhookToken) webhookHeaders['Authorization'] = `Bearer ${webhookToken}`
        fetch(webhookParsed.toString(), {
          method: 'POST',
          headers: webhookHeaders,
          body: JSON.stringify({ type: 'inbox', message: incomingRecord }),
        }).catch(() => {}) // fire and forget
      }

      // Feature-flagged reactive loop behavior: in polling mode, keep the existing schedule.
      const reactiveModeEnabled = this.isReactiveModeEnabled(
        this.config ?? ((await this.ctx.storage.get<AgentConfig>('config')) ?? null)
      )
      if (reactiveModeEnabled) {
        await this.scheduleInterruptWake({
          reason: 'inbox_message',
          leadMs: 1_000,
          thresholdMs: 10_000,
        }).catch(() => undefined)
      }

      return Response.json({ id })
    }

    if (request.method === 'GET') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
      const entries = await this.listInboxEntries(limit)
      await this.safeBroadcastEvent({
        event_type: 'agent.comms.inbox.list',
        context: {
          source: 'api.inbox.get',
          collection: INBOX_COLLECTIONS.join(','),
          limit: limit ?? null,
          count: entries.length,
        },
      })
      return Response.json({ entries })
    }

    return new Response('Method not allowed', { status: 405 })
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (!this.initialized) {
        await this.initialize()
      }

      await this.maybeReloadExtensions()

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

    await this.safePut('session', finalSession)
    this.session = finalSession
  }

  private getExtensionPrefixForAgent(): string {
    const name = this.config?.name ?? this.did
    return `${EXTENSION_PREFIX}/${name}/`
  }

  private extensionKeyForName(extensionName: string): string {
    const prefix = this.getExtensionPrefixForAgent()
    return `${prefix}${extensionName}.js`
  }

  private extensionNameFromKey(key: string): string | null {
    const prefix = this.getExtensionPrefixForAgent()
    if (!key.startsWith(prefix)) return null
    if (!key.endsWith('.js')) return null
    const rest = key.slice(prefix.length, -'.js'.length)
    if (!rest) return null
    if (rest.includes('/')) return null
    return rest
  }

  private extensionMetricsKeyForName(name: string): string {
    return `${EXTENSION_METRICS_PREFIX}${name}`
  }

  private isExtensionMetrics(value: unknown): value is ExtensionMetrics {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const rec = value as Record<string, unknown>
    if (typeof rec.name !== 'string' || rec.name.trim().length === 0) return false
    if (typeof rec.totalCalls !== 'number' || !Number.isFinite(rec.totalCalls)) return false
    if (typeof rec.successCalls !== 'number' || !Number.isFinite(rec.successCalls)) return false
    if (typeof rec.failedCalls !== 'number' || !Number.isFinite(rec.failedCalls)) return false
    if (typeof rec.lastUsed !== 'number' || !Number.isFinite(rec.lastUsed)) return false
    return true
  }

  private async updateExtensionMetrics(name: string, success: boolean): Promise<void> {
    const now = Date.now()
    const safeName = name.trim()
    if (!safeName) return

    const key = this.extensionMetricsKeyForName(safeName)

    try {
      const raw = await this.ctx.storage.get<unknown>(key)
      const existing = this.isExtensionMetrics(raw)
        ? raw
        : { name: safeName, totalCalls: 0, successCalls: 0, failedCalls: 0, lastUsed: 0 }

      const next: ExtensionMetrics = {
        name: safeName,
        totalCalls: Math.max(0, Math.floor(existing.totalCalls)) + 1,
        successCalls: Math.max(0, Math.floor(existing.successCalls)) + (success ? 1 : 0),
        failedCalls: Math.max(0, Math.floor(existing.failedCalls)) + (success ? 0 : 1),
        lastUsed: now,
      }

      await this.safePut(key, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('Failed to update extension metrics', { did: this.did, name: safeName, error: message })
    }
  }

  private async listExtensionMetrics(): Promise<ExtensionMetrics[]> {
    try {
      const stored = await (this.ctx.storage as any).list?.({ prefix: EXTENSION_METRICS_PREFIX })
      const entries: Array<[string, unknown]> =
        stored && typeof stored.entries === 'function' ? Array.from(stored.entries()) : []

      const metrics = entries
        .map(([, value]) => value)
        .filter((value): value is ExtensionMetrics => this.isExtensionMetrics(value))
        .map((m) => ({ ...m, name: m.name.trim() }))
        .filter((m) => m.name.length > 0)

      metrics.sort((a, b) => {
        if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed
        return a.name.localeCompare(b.name)
      })

      return metrics
    } catch {
      return []
    }
  }

  private async listExtensionObjects(): Promise<Array<{ key: string; size: number | null; uploaded: string | null }>> {
    const bucket = this.agentEnv.BLOBS as any
    if (!bucket || typeof bucket.list !== 'function') return []

    const prefix = this.getExtensionPrefixForAgent()
    const result = (await bucket.list({ prefix })) as any
    const objects = Array.isArray(result?.objects) ? (result.objects as Array<any>) : []

    return objects
      .map((obj) => ({
        key: typeof obj?.key === 'string' ? obj.key : '',
        size: typeof obj?.size === 'number' && Number.isFinite(obj.size) ? obj.size : null,
        uploaded:
          obj?.uploaded && typeof obj.uploaded.toISOString === 'function'
            ? obj.uploaded.toISOString()
            : typeof obj?.uploaded === 'string'
              ? obj.uploaded
              : null,
      }))
      .filter((o) => o.key.length > 0)
  }

  private validateExtensionName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('extension name is required')
    if (trimmed.length > 64) throw new Error('extension name too long')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) {
      throw new Error('extension name must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
    }
    return trimmed
  }

  private validateExtensionSource(code: string): void {
    const bytes = new TextEncoder().encode(code).byteLength
    if (bytes > MAX_EXTENSION_BYTES) {
      throw new Error(`extension exceeds max size (${MAX_EXTENSION_BYTES} bytes)`)
    }

    const lower = code.toLowerCase()
    if (/\beval\s*\(/.test(lower)) throw new Error('extension code may not use eval()')
    if (/\bnew\s+function\s*\(/.test(lower)) throw new Error('extension code may not use Function()')
  }

  private toDataUrl(js: string): string {
    const bytes = new TextEncoder().encode(js)
    let base64: string
    if (typeof (globalThis as any).btoa === 'function') {
      let binary = ''
      for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]!)
      }
      base64 = (globalThis as any).btoa(binary)
    } else if (typeof Buffer !== 'undefined') {
      // Node fallback (tests).
      base64 = Buffer.from(bytes).toString('base64')
    } else {
      throw new Error('base64 encoder unavailable')
    }

    return `data:text/javascript;base64,${base64}`
  }

  private async loadExtensionsIntoTools(tools: PiAgentTool[]): Promise<void> {
    const objects = await this.listExtensionObjects()
    const prefix = this.getExtensionPrefixForAgent()
    const candidates = objects
      .map((obj) => obj.key)
      .filter((key) => key.startsWith(prefix) && key.endsWith('.js'))
      .sort()

    this.extensionKeys = candidates.slice(0, MAX_AGENT_EXTENSIONS)

    const api = {
      registerTool: (tool: PiAgentTool) => {
        if (!tool || typeof tool !== 'object') throw new Error('registerTool requires a tool object')
        if (typeof tool.name !== 'string' || tool.name.trim().length === 0) throw new Error('tool.name is required')
        if (typeof tool.execute !== 'function') throw new Error('tool.execute is required')
        if (tools.some((t) => t.name === tool.name)) throw new Error(`tool already exists: ${tool.name}`)
        tools.push(tool)
      },
    }

    const bucket = this.agentEnv.BLOBS as any
    if (!bucket || typeof bucket.get !== 'function') return

    for (const key of this.extensionKeys) {
      const name = this.extensionNameFromKey(key) ?? key
      try {
        const object = await bucket.get(key)
        if (!object) {
          await this.updateExtensionMetrics(name, false)
          continue
        }
        const code = typeof object.text === 'function' ? await object.text() : null
        if (typeof code !== 'string') {
          await this.updateExtensionMetrics(name, false)
          continue
        }
        this.validateExtensionSource(code)

        const module = (await import(this.toDataUrl(code))) as unknown as { activate?: unknown }
        const activate = (module as any)?.activate
        if (typeof activate !== 'function') {
          console.warn('Extension missing activate(agent) export', { did: this.did, key })
          await this.updateExtensionMetrics(name, false)
          continue
        }

        await Promise.resolve(activate(api))
        await this.updateExtensionMetrics(name, true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('Failed to load extension', { did: this.did, key, error: message })
        await this.updateExtensionMetrics(name, false)
      }
    }
  }

  private async rebuildAgentWrapper(input?: {
    config?: AgentConfig
    systemPromptOverride?: string
    toolsOverride?: PiAgentTool[]
  }): Promise<void> {
    if (!this.session) {
      this.session = await this.loadSession()
    }

    const config = input?.config ?? (await this.loadOrCreateConfig())
    this.config = config

    const tools = input?.toolsOverride ?? this.buildTools()
    if (!input?.toolsOverride) {
      await this.loadExtensionsIntoTools(tools)
    }
    this.tools = tools

    const agentFactory =
      this.agentEnv.PI_AGENT_FACTORY ??
      (this.agentEnv.OPENROUTER_API_KEY && this.agentEnv.CF_ACCOUNT_ID && this.agentEnv.AI_GATEWAY_SLUG
        ? (() => {
          const baseFactory = createOpenRouterAgentFactory({
            CF_ACCOUNT_ID: this.agentEnv.CF_ACCOUNT_ID,
            AI_GATEWAY_SLUG: this.agentEnv.AI_GATEWAY_SLUG,
            OPENROUTER_API_KEY: this.agentEnv.OPENROUTER_API_KEY,
            OPENROUTER_MODEL_DEFAULT: this.agentEnv.OPENROUTER_MODEL_DEFAULT,
          })
          // Enforce enabledTools strictly for OpenRouter by passing the allowlist down to the factory.
          return (init) =>
            baseFactory({
              ...init,
              initialState: {
                ...init.initialState,
                enabledTools: config.enabledTools,
              },
            })
        })()
        : undefined)

    this.agent = new PiAgentWrapper({
      systemPrompt: input?.systemPromptOverride ?? config.personality,
      model: config.model,
      fastModel: config.fastModel,
      tools,
      agentFactory,
      messages: this.session.messages,
    })
  }

  private async maybeReloadExtensions(): Promise<void> {
    const reloadNeeded = Boolean(await this.ctx.storage.get<boolean>('extensionsReloadNeeded'))
    if (!reloadNeeded) return
    await this.ctx.storage.put('extensionsReloadNeeded', false)
    await this.rebuildAgentWrapper()
  }

  private async maybeInjectSelfExtensionHint(): Promise<void> {
    const shown = Boolean(await this.ctx.storage.get<boolean>('extensionsHintShown'))
    if (shown) return

    // If any extensions are present, mark as shown and move on.
    if (this.extensionKeys.length > 0) {
      await this.ctx.storage.put('extensionsHintShown', true)
      return
    }

    const hint =
      '\n\n' +
      'You can extend yourself at runtime by writing Pi extensions.\n' +
      'Use the write_extension tool to save a JS module to R2. Extensions must export activate(agent) and call agent.registerTool({...}).\n' +
      'Manage them with list_extensions and remove_extension.'

    await this.ctx.storage.put('extensionsHintShown', true)
    const base = this.config?.personality ?? DEFAULT_AGENT_SYSTEM_PROMPT
    // Keep the current tool instances when only updating the system prompt. This avoids
    // surprising tool mutation resets (tests override tool.execute) and keeps the hint
    // injection from interfering with the next loop cycle's timing behavior.
    await this.rebuildAgentWrapper({ systemPromptOverride: `${base}${hint}`, toolsOverride: this.tools })
  }

  private categorizeAlarmError(error: unknown, ctx: { phase: string }): AlarmErrorCategory {
    const message = error instanceof Error ? error.message : String(error)
    const normalized = message.toLowerCase()

    // Game-context: errors explicitly coming from game actions should not stall the agent for long.
    if (ctx.phase === 'act' && normalized.includes('game')) return 'game'

    // Transient: timeouts, rate limits, temporary upstream failures.
    if (normalized.includes('rate limit') || normalized.includes('too many requests') || normalized.includes('429')) {
      return 'transient'
    }
    if (
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('etimedout') ||
      (error && typeof error === 'object' && (error as any).name === 'AbortError')
    ) {
      return 'transient'
    }

    // Persistent: config/infra issues tend to persist until human intervention.
    if (normalized.includes('config')) return 'persistent'

    // Default conservative behavior: treat unknown errors as persistent to avoid thrash.
    return 'persistent'
  }
}

function selectAlarmErrorCategory(
  errors: Array<{ category: AlarmErrorCategory }>
): AlarmErrorCategory {
  if (errors.some((e) => e.category === 'persistent')) return 'persistent'
  if (errors.some((e) => e.category === 'transient')) return 'transient'
  if (errors.some((e) => e.category === 'game')) return 'game'
  return 'unknown'
}

function computeTieredBackoffMs(category: AlarmErrorCategory, streak: number): number {
  const i = Math.max(0, Math.floor(streak) - 1)
  if (category === 'transient') return TRANSIENT_BACKOFF_MS[Math.min(i, TRANSIENT_BACKOFF_MS.length - 1)]!
  if (category === 'persistent') return PERSISTENT_BACKOFF_MS[Math.min(i, PERSISTENT_BACKOFF_MS.length - 1)]!
  if (category === 'game') return GAME_BACKOFF_MS
  return PERSISTENT_BACKOFF_MS[0]
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
