/**
 * Agent Network - Cloudflare Worker Entry Point
 * 
 * Routes requests to Agent DOs, Relay DO, or static dashboard.
 */

import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'

import { LexiconRecordSchema } from '../../../packages/core/src/lexicons'
import { createDid } from '../../../packages/core/src/identity'

import { requireAdminBearerAuth } from './auth'
import { applyCorsHeaders, corsPreflightResponse } from './cors'
import './environments/builtins'
import { getEnvironment } from './environments'
import { withErrorHandling } from './http-errors'
import { validateRequestJson } from './http-validation'

const WORKER_STARTED_AT = Date.now()

const DEFAULT_AGENT_MODEL = 'moonshotai/kimi-k2.5'
const DEFAULT_AGENT_FAST_MODEL = 'google/gemini-2.0-flash-001'
const DEFAULT_AGENT_LOOP_INTERVAL_MS = 60_000
const MIN_AGENT_LOOP_INTERVAL_MS = 5_000

const AgentConfigCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required'),
    personality: z.string().trim().min(1, 'personality is required'),
    specialty: z.string().optional().default(''),
    model: z.string().optional().default(DEFAULT_AGENT_MODEL),
    fastModel: z.string().optional().default(DEFAULT_AGENT_FAST_MODEL),
    loopIntervalMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_AGENT_LOOP_INTERVAL_MS)
      .transform((value) => Math.max(MIN_AGENT_LOOP_INTERVAL_MS, value)),
    maxCompletedGoals: z.number().int().min(0).optional(),
    goals: z.array(z.unknown()).optional().default([]),
    enabledTools: z.array(z.string()).optional().default([]),
  })
  .passthrough()

const EnvironmentCreateSchema = z.object({
  type: z.string().trim().min(1, 'type is required'),
  players: z.array(z.string().trim().min(1)).min(2, 'at least 2 players are required'),
})

export interface Env {
  AGENTS: DurableObjectNamespace
  RELAY: DurableObjectNamespace
  DB: D1Database
  BLOBS: R2Bucket
  VECTORIZE: VectorizeIndex
  MESSAGE_QUEUE: Queue
  AI: Ai

  // AI Gateway + OpenRouter (production vars/secrets)
  CF_ACCOUNT_ID: string
  AI_GATEWAY_SLUG: string
  OPENROUTER_API_KEY: string
  OPENROUTER_MODEL_DEFAULT: string
  GRIMLOCK_GITHUB_TOKEN?: string

  // Auth + HTTP
  ADMIN_TOKEN: string
  CORS_ORIGIN?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasMethod(value: unknown, method: string): boolean {
  return typeof (value as Record<string, unknown> | null | undefined)?.[method] === 'function'
}

function listMissingBindings(env: Partial<Env>): string[] {
  const missing: string[] = []

  if (!hasMethod(env.AGENTS, 'idFromName') || !hasMethod(env.AGENTS, 'get')) missing.push('AGENTS')
  if (!hasMethod(env.RELAY, 'idFromName') || !hasMethod(env.RELAY, 'get')) missing.push('RELAY')
  if (!hasMethod(env.DB, 'prepare')) missing.push('DB')
  if (!hasMethod(env.BLOBS, 'get') || !hasMethod(env.BLOBS, 'put')) missing.push('BLOBS')
  if (!hasMethod(env.VECTORIZE, 'query')) missing.push('VECTORIZE')
  if (!hasMethod(env.MESSAGE_QUEUE, 'send')) missing.push('MESSAGE_QUEUE')
  if (!hasMethod(env.AI, 'run')) missing.push('AI')

  if (!isNonEmptyString(env.CF_ACCOUNT_ID)) missing.push('CF_ACCOUNT_ID')
  if (!isNonEmptyString(env.AI_GATEWAY_SLUG)) missing.push('AI_GATEWAY_SLUG')
  if (!isNonEmptyString(env.OPENROUTER_API_KEY)) missing.push('OPENROUTER_API_KEY')
  if (!isNonEmptyString(env.OPENROUTER_MODEL_DEFAULT)) missing.push('OPENROUTER_MODEL_DEFAULT')

  if (!isNonEmptyString(env.ADMIN_TOKEN)) missing.push('ADMIN_TOKEN')

  return missing
}

type AgentRegistryRow = { name: string; did: string; created_at: string }

async function getAgentRegistryRow(db: D1Database, name: string): Promise<AgentRegistryRow | null> {
  const row = await db
    .prepare('SELECT name, did, created_at FROM agents WHERE name = ?')
    .bind(name)
    .first<AgentRegistryRow>()
  return row ?? null
}

async function listAgentRegistryRows(db: D1Database): Promise<AgentRegistryRow[]> {
  const result = await db
    .prepare('SELECT name, did, created_at FROM agents')
    .all<AgentRegistryRow>()
  return result.results ?? []
}

function inferEnvironmentTypeFromId(id: string): string {
  const idx = id.indexOf('_')
  if (idx <= 0) return 'unknown'
  return id.slice(0, idx)
}

function safeJsonParseArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function parseD1Timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null

  const direct = Date.parse(value)
  if (Number.isFinite(direct)) return direct

  // D1/SQLite `datetime('now')` format: `YYYY-MM-DD HH:MM:SS` (UTC).
  if (value.includes(' ') && !value.includes('T')) {
    const normalized = `${value.replace(' ', 'T')}Z`
    const parsed = Date.parse(normalized)
    if (Number.isFinite(parsed)) return parsed
  }

  return null
}

function parseEnvironmentsLimit(value: string | null): number | { error: string } {
  if (value == null || value === '') return 20
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return { error: 'limit must be an integer' }
  if (parsed < 1) return { error: 'limit must be >= 1' }
  if (parsed > 100) return { error: 'limit must be <= 100' }
  return parsed
}

function parseEnvironmentsCursor(value: string): { updatedAtRaw: string; updatedAtMs: number; id: string } | null {
  const idx = value.indexOf('|')
  if (idx <= 0 || idx === value.length - 1) return null
  const updatedAtRaw = value.slice(0, idx)
  const id = value.slice(idx + 1)
  const updatedAtMs = parseD1Timestamp(updatedAtRaw)
  if (updatedAtMs == null) return null
  if (!id) return null
  return { updatedAtRaw, updatedAtMs, id }
}

function mapLegacyGamesAliasPath(pathname: string): string | null {
  if (pathname === '/games') return '/environments'
  if (!pathname.startsWith('/games/')) return null
  const suffix = pathname.slice('/games'.length)
  return `/environments${suffix}`
}

function withDeprecationHeaders(response: Response, replacementPath: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Deprecation', 'true')
  headers.set('Link', `<${replacementPath}>; rel="successor-version"`)
  headers.set('Warning', `299 - "Route deprecated; use ${replacementPath}"`)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

type ParsedToolResult = {
  name: string
  durationMs: number
}

type ParsedLoopStep = {
  timestamp: number | null
  durationMs: number
  toolResults: ParsedToolResult[]
  toolCallNames: string[]
}

type ParsedLoopTranscript = {
  startedAt: number
  totalDurationMs: number
  totalSteps: number
  totalToolCalls: number
  model: string | null
  steps: ParsedLoopStep[]
}

function parseToolResults(value: unknown): ParsedToolResult[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const record = entry as Record<string, unknown>
      const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : null
      if (!name) return null
      const durationMs = readFiniteNumber(record.durationMs) ?? 0
      return { name, durationMs }
    })
    .filter((entry): entry is ParsedToolResult => entry !== null)
}

function parseToolCallNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const response = value as Record<string, unknown>
  if (!Array.isArray(response.toolCalls)) return []

  return response.toolCalls
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const name = (entry as Record<string, unknown>).name
      return typeof name === 'string' && name.length > 0 ? name : null
    })
    .filter((name): name is string => name !== null)
}

function parseLoopStep(value: unknown): ParsedLoopStep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const step = value as Record<string, unknown>

  const durationMs = readFiniteNumber(step.durationMs) ?? 0
  const toolResults = parseToolResults(step.toolResults)
  const toolCallNames = uniqueStrings([
    ...parseToolCallNames(step.modelResponse),
    ...toolResults.map((result) => result.name),
  ])

  return {
    timestamp: readTimestampMs(step.timestamp),
    durationMs,
    toolResults,
    toolCallNames,
  }
}

function parseLoopTranscript(value: unknown): ParsedLoopTranscript | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const transcript = value as Record<string, unknown>

  const stepsRaw = Array.isArray(transcript.steps) ? transcript.steps : []
  const steps = stepsRaw.map(parseLoopStep).filter((step): step is ParsedLoopStep => step !== null)
  if (steps.length === 0 && readFiniteNumber(transcript.totalDurationMs) == null) return null

  const startedAt =
    readTimestampMs(transcript.startedAt) ??
    steps[0]?.timestamp ??
    Date.now()

  const totalDurationMs =
    readFiniteNumber(transcript.totalDurationMs) ??
    steps.reduce((total, step) => total + step.durationMs, 0)

  const totalToolCalls =
    readFiniteNumber(transcript.totalToolCalls) ??
    steps.reduce((total, step) => total + step.toolCallNames.length, 0)

  const totalSteps =
    readFiniteNumber(transcript.totalSteps) ??
    steps.length

  return {
    startedAt,
    totalDurationMs,
    totalToolCalls,
    totalSteps,
    model: typeof transcript.model === 'string' ? transcript.model : null,
    steps,
  }
}

function parseActionOutcomes(value: unknown): Array<{ success: boolean }> {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const success = (entry as Record<string, unknown>).success
      return typeof success === 'boolean' ? { success } : null
    })
    .filter((entry): entry is { success: boolean } => entry !== null)
}

function parseLoopStatus(value: unknown): { loopRunning: boolean; loopCount: number | null; nextAlarm: number | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { loopRunning: false, loopCount: null, nextAlarm: null }
  }

  const status = value as Record<string, unknown>
  return {
    loopRunning: Boolean(status.loopRunning),
    loopCount: readFiniteNumber(status.loopCount),
    nextAlarm: readTimestampMs(status.nextAlarm),
  }
}

function parseLastError(value: unknown): {
  category: string
  ts: number
  streak: number | null
  backoffMs: number | null
  lastPhase: string | null
  lastMessage: string | null
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const category =
    typeof record.category === 'string' && record.category.length > 0
      ? record.category
      : 'unknown'
  const ts = readTimestampMs(record.ts) ?? readTimestampMs(record.timestamp) ?? readTimestampMs(record.at) ?? 0

  return {
    category,
    ts,
    streak: readFiniteNumber(record.streak),
    backoffMs: readFiniteNumber(record.backoffMs),
    lastPhase: typeof record.lastPhase === 'string' ? record.lastPhase : null,
    lastMessage: typeof record.lastMessage === 'string' ? record.lastMessage : null,
  }
}

function buildDecisionTrace(debugPayload: unknown): {
  startedAt: number
  endedAt: number
  totalDurationMs: number
  totalSteps: number
  totalToolCalls: number
  model: string | null
  chain: Array<{
    phase: 'observe' | 'think' | 'act' | 'reflect'
    at: number
    durationMs: number | null
    toolCalls?: string[]
  }>
} | null {
  if (!debugPayload || typeof debugPayload !== 'object' || Array.isArray(debugPayload)) return null
  const debug = debugPayload as Record<string, unknown>
  const transcript = parseLoopTranscript(debug.loopTranscript)
  if (!transcript) return null

  const actDurationMs = transcript.steps.reduce(
    (total, step) => total + step.toolResults.reduce((stepTotal, tool) => stepTotal + tool.durationMs, 0),
    0
  )
  const stepDurationMs = transcript.steps.reduce((total, step) => total + step.durationMs, 0)
  const thinkDurationMs = Math.max(0, stepDurationMs - actDurationMs)
  const totalDurationMs = transcript.totalDurationMs > 0 ? transcript.totalDurationMs : stepDurationMs
  const startedAt = transcript.startedAt
  const endedAt = startedAt + totalDurationMs
  const reflectAt = readTimestampMs((debug.lastReflection as Record<string, unknown> | null | undefined)?.at) ?? endedAt
  const reflectDurationMs = reflectAt > endedAt ? reflectAt - endedAt : 0
  const toolCalls = uniqueStrings(transcript.steps.flatMap((step) => step.toolCallNames))

  return {
    startedAt,
    endedAt,
    totalDurationMs,
    totalSteps: transcript.totalSteps,
    totalToolCalls: transcript.totalToolCalls,
    model: transcript.model,
    chain: [
      { phase: 'observe', at: startedAt, durationMs: null },
      { phase: 'think', at: startedAt, durationMs: thinkDurationMs },
      { phase: 'act', at: startedAt + thinkDurationMs, durationMs: actDurationMs, toolCalls },
      { phase: 'reflect', at: reflectAt, durationMs: reflectDurationMs },
    ],
  }
}

async function fetchAgentJson(agent: DurableObjectStub, path: string): Promise<unknown | null> {
  const response = await agent.fetch(new Request(`https://agent${path}`))
  if (!response.ok) return null
  return response.json().catch(() => null)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(request, env)
    }

    const response = await withErrorHandling(
      async () => {
        const url = new URL(request.url)
        const normalizedPathname = url.pathname.replace(/\/+$/, '')

        if (normalizedPathname === '/health') {
          return withErrorHandling(
            () => {
              const missing = listMissingBindings(env)
              const uptimeMs = Math.max(0, Date.now() - WORKER_STARTED_AT)

              if (missing.length) {
                return Response.json(
                  { status: 'error', missing, uptimeMs },
                  { status: 500, headers: { 'Cache-Control': 'no-store' } }
                )
              }

              return Response.json(
                { status: 'ok', missing: [], uptimeMs, version: 'a721d5a-coerce' },
                { headers: { 'Cache-Control': 'no-store' } }
              )
            },
            { route: 'network.health', request }
          )
        }

        // Public read-only access for agent identity + memory list (GET only)
        // Write operations (POST/PUT/DELETE) and other routes require admin auth
        const isLoopStatusRoute =
          request.method === 'GET' &&
          /^\/agents\/[^/]+\/loop\/status$/.test(normalizedPathname)
        const isAgentReadRoute =
          normalizedPathname.startsWith('/agents/') &&
          request.method === 'GET' &&
          !isLoopStatusRoute &&
          // Internal DO endpoints should never be reachable through the public agent forwarding route.
          !normalizedPathname.includes('/__internal/')
        
        if (!isAgentReadRoute) {
          const auth = requireAdminBearerAuth(request, env)
          if (auth) return auth
        }

        // Dashboard
        if (normalizedPathname === '/dashboard' || normalizedPathname.startsWith('/dashboard/')) {
          return withErrorHandling(
            () => {
              // TODO: Serve dashboard SPA
              return new Response('Dashboard not yet implemented', { status: 501 })
            },
            { route: 'network.dashboard', request }
          )
        }

        // Relay (firehose, subscriptions)
        if (normalizedPathname.startsWith('/relay/')) {
          return withErrorHandling(
            () => {
              const relayId = env.RELAY.idFromName('main')
              const relay = env.RELAY.get(relayId)
              return relay.fetch(request)
            },
            { route: 'network.relay', request }
          )
        }

        // Agent operations
        if (normalizedPathname === '/agents') {
          return withErrorHandling(
            async () => {
              if (request.method === 'GET') {
                const registry = await listAgentRegistryRows(env.DB)

                const agents = await Promise.all(
                  registry.map(async (row) => {
                    try {
                      const agentId = env.AGENTS.idFromName(row.name)
                      const agent = env.AGENTS.get(agentId)

                      const encodedName = encodeURIComponent(row.name)
                      const [identityRes, configRes, loopRes] = await Promise.all([
                        agent.fetch(new Request(`https://agent/agents/${encodedName}/identity`)),
                        agent.fetch(new Request(`https://agent/agents/${encodedName}/config`)),
                        agent.fetch(new Request(`https://agent/agents/${encodedName}/loop/status`)),
                      ])

                      const identity = identityRes.ok ? await identityRes.json().catch(() => null) : null
                      const config = configRes.ok ? await configRes.json().catch(() => null) : null
                      const loop = loopRes.ok ? await loopRes.json().catch(() => null) : null

                      return {
                        name: row.name,
                        did: (identity && typeof identity === 'object' && 'did' in identity ? (identity as any).did : row.did) as string,
                        createdAt:
                          identity && typeof identity === 'object' && 'createdAt' in identity
                            ? (identity as any).createdAt
                            : row.created_at,
                        publicKeys:
                          identity && typeof identity === 'object' && 'publicKeys' in identity ? (identity as any).publicKeys : undefined,
                        config: config ?? undefined,
                        loop: loop ?? undefined,
                      }
                    } catch (error) {
                      const message = error instanceof Error ? error.message : String(error)
                      return { name: row.name, did: row.did, createdAt: row.created_at, error: message }
                    }
                  })
                )

                const showAll = url.searchParams.get('all') === 'true'
                const filtered = showAll
                  ? agents
                  : agents.filter((a) => {
                      const loop = (a as any).loop
                      // Keep agents whose loop is running OR whose status is unknown (no error hiding)
                      return !loop || loop.loopRunning !== false
                    })

                return Response.json({ agents: filtered })
              }

              if (request.method !== 'POST') {
                return new Response('Method not allowed', { status: 405 })
              }

              const validated = await validateRequestJson(request, AgentConfigCreateSchema, {
                invalidBodyError: 'Invalid agent config',
              })
              if (!validated.ok) return validated.response

              const config = validated.data
              const name = config.name

              const existing = await getAgentRegistryRow(env.DB, name)
              if (existing) {
                return Response.json({ error: 'Agent already exists' }, { status: 409 })
              }

              const agentId = env.AGENTS.idFromName(name)
              const agent = env.AGENTS.get(agentId)
              const createdAt = new Date().toISOString()
              const did = createDid(agentId.toString())

              // Registry row first so subsequent reads don't implicitly create unknown agents.
              try {
                await env.DB
                  .prepare('INSERT INTO agents (name, did, created_at) VALUES (?, ?, ?)')
                  .bind(name, did, createdAt)
                  .run()
              } catch (error) {
                // Race-safe: insert may fail on unique constraint.
                const message = error instanceof Error ? error.message : String(error)
                if (message.toLowerCase().includes('unique')) {
                  return Response.json({ error: 'Agent already exists' }, { status: 409 })
                }
                throw error
              }

              let agentResponse: Response
              try {
                agentResponse = await agent.fetch(
                  new Request(`https://agent/agents/${encodeURIComponent(name)}/create`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config),
                  })
                )
              } catch (error) {
                await env.DB.prepare('DELETE FROM agents WHERE name = ?').bind(name).run()
                throw error
              }

              if (!agentResponse.ok) {
                await env.DB.prepare('DELETE FROM agents WHERE name = ?').bind(name).run()
                const text = await agentResponse.text().catch(() => '')
                return new Response(text || 'Agent create failed', { status: 502 })
              }

              const payload = await agentResponse.json().catch(() => null)
              return Response.json(payload)
            },
            { route: 'network.agents.root', request }
          )
        }

        const traceMatch = normalizedPathname.match(/^\/agents\/([^/]+)\/trace$/)
        if (traceMatch) {
          return withErrorHandling(
            async () => {
              if (request.method !== 'GET') {
                return new Response('Method not allowed', { status: 405 })
              }

              const agentName = decodeURIComponent(traceMatch[1] ?? '')
              if (!agentName) {
                return new Response('Agent name required', { status: 400 })
              }

              const registered = await getAgentRegistryRow(env.DB, agentName)
              if (!registered) {
                return Response.json({ error: 'Agent not found' }, { status: 404 })
              }

              const agentId = env.AGENTS.idFromName(agentName)
              const agent = env.AGENTS.get(agentId)
              const debugPayload = await fetchAgentJson(agent, `/agents/${encodeURIComponent(agentName)}/debug`)
              const trace = buildDecisionTrace(debugPayload)
              if (!trace) {
                return Response.json({ error: 'Trace not available' }, { status: 404 })
              }

              return Response.json({
                agent: agentName,
                trace,
              })
            },
            { route: 'network.agents.trace', request }
          )
        }

        if (normalizedPathname.startsWith('/agents/')) {
          return withErrorHandling(
            async () => {
              const parts = normalizedPathname.split('/')
              const agentName = parts[2]

              if (!agentName) {
                return new Response('Agent name required', { status: 400 })
              }

              const registered = await getAgentRegistryRow(env.DB, agentName)
              if (!registered) {
                return Response.json({ error: 'Agent not found' }, { status: 404 })
              }

              const leaf = parts.at(-1)
              let forwardedRequest = request

              // Validate lexicon record request bodies at the Worker boundary so we can
              // return descriptive 400s and forward parsed defaults.
              if ((request.method === 'POST' || request.method === 'PUT') && leaf === 'memory') {
                const validated = await validateRequestJson(request, LexiconRecordSchema)
                if (!validated.ok) {
                  return validated.response
                }

                forwardedRequest = new Request(request.url, {
                  method: request.method,
                  headers: request.headers,
                  body: JSON.stringify(validated.data),
                })
              }

              const agentId = env.AGENTS.idFromName(agentName)
              const agent = env.AGENTS.get(agentId)
              return agent.fetch(forwardedRequest)
            },
            { route: 'network.agents', request }
          )
        }

        // Environments (canonical) + legacy /games aliases.
        if (normalizedPathname === '/environments' || normalizedPathname === '/games') {
          const legacyReplacement = mapLegacyGamesAliasPath(normalizedPathname)
          const isLegacyAlias = legacyReplacement !== null
          if (isLegacyAlias) {
            console.warn(`Route deprecated: ${request.method} ${normalizedPathname} -> ${legacyReplacement}`)
          }

          const result = await withErrorHandling(
            async () => {
              if (request.method === 'DELETE') {
                const updateResult = await env.DB.prepare(
                  "UPDATE environments SET phase = 'abandoned', updated_at = datetime('now') WHERE phase NOT IN ('finished', 'abandoned')"
                ).run()
                const count = updateResult.meta?.changes ?? 0
                return Response.json({ ok: true, message: `Killed ${count} active environment(s)` })
              }

              if (request.method === 'GET') {
                const typeFilter = url.searchParams.get('type')?.trim() ?? ''
                const phaseFilter = url.searchParams.get('phase')?.trim() ?? ''
                const playerFilter = url.searchParams.get('player')?.trim() ?? ''

                const showAll = url.searchParams.get('all') === 'true'
                const limitParsed = parseEnvironmentsLimit(url.searchParams.get('limit'))
                if (typeof limitParsed === 'object') {
                  return Response.json({ error: limitParsed.error }, { status: 400 })
                }
                const limit = limitParsed

                const cursorRaw = url.searchParams.get('cursor')
                const cursor = cursorRaw ? parseEnvironmentsCursor(cursorRaw) : null
                if (cursorRaw && !cursor) {
                  return Response.json({ error: 'Invalid cursor' }, { status: 400 })
                }

                // D1MockDatabase only supports a small SQL subset (no ORs, no >=),
                // so fetch a bounded window and apply 24h + pagination logic in JS.
                const fetchLimit = Math.min(Math.max(limit * 10, 200), 500)
                const selectCols = 'id, type, host_agent, phase, players, winner, created_at, updated_at'
                const activeSql = `SELECT ${selectCols} FROM environments WHERE phase NOT IN ('finished', 'abandoned') ORDER BY updated_at DESC LIMIT ${fetchLimit}`
                const finishedSql = `SELECT ${selectCols} FROM environments WHERE phase = 'finished' ORDER BY updated_at DESC LIMIT ${fetchLimit}`
                const allSql = `SELECT ${selectCols} FROM environments ORDER BY updated_at DESC LIMIT ${fetchLimit}`

                const nowMs = Date.now()
                const cutoffMs = nowMs - 24 * 60 * 60_000

                let rawRows: any[] = []
                if (showAll) {
                  const rows = await env.DB.prepare(allSql).all()
                  rawRows = rows.results ?? []
                } else {
                  const [activeRows, finishedRows] = await Promise.all([
                    env.DB.prepare(activeSql).all(),
                    env.DB.prepare(finishedSql).all(),
                  ])

                  const recentFinished = (finishedRows.results ?? []).filter((row: any) => {
                    const ts = parseD1Timestamp(row.updated_at)
                    return ts != null && ts >= cutoffMs
                  })
                  rawRows = [...(activeRows.results ?? []), ...recentFinished]
                }

                const filtered = rawRows
                  .map((row: any) => {
                    const id = String(row.id ?? '')
                    const type =
                      typeof row.type === 'string' && row.type.trim().length > 0
                        ? row.type
                        : inferEnvironmentTypeFromId(id)
                    const players = safeJsonParseArray(row.players)
                    const updatedAtRaw = String(row.updated_at ?? '')
                    const updatedAtMs = parseD1Timestamp(updatedAtRaw) ?? 0
                    return {
                      id,
                      updatedAtRaw,
                      updatedAtMs,
                      environment: {
                        id,
                        type,
                        hostAgent: row.host_agent,
                        phase: row.phase,
                        players,
                        winner: row.winner ?? null,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at,
                      },
                    }
                  })
                  .filter((entry) => entry.id.length > 0)
                  .filter((entry) => (typeFilter ? entry.environment.type === typeFilter : true))
                  .filter((entry) => (phaseFilter ? entry.environment.phase === phaseFilter : true))
                  .filter((entry) => (playerFilter ? entry.environment.players.includes(playerFilter) : true))
                  .sort((a, b) => {
                    if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs
                    return b.id.localeCompare(a.id)
                  })

                const afterCursor = cursor
                  ? filtered.filter((entry) => {
                      if (entry.updatedAtMs < cursor.updatedAtMs) return true
                      if (entry.updatedAtMs > cursor.updatedAtMs) return false
                      return entry.id.localeCompare(cursor.id) < 0
                    })
                  : filtered

                const pagePlusOne = afterCursor.slice(0, limit + 1)
                const hasMore = pagePlusOne.length > limit
                const page = pagePlusOne.slice(0, limit)
                const last = page.at(-1)
                const nextCursor =
                  hasMore && last && last.updatedAtRaw
                    ? `${last.updatedAtRaw}|${last.id}`
                    : undefined

                return Response.json({
                  environments: page.map((entry) => entry.environment),
                  nextCursor,
                })
              }

              if (request.method !== 'POST') {
                return new Response('Method not allowed', { status: 405 })
              }

              const validated = await validateRequestJson(request, EnvironmentCreateSchema, {
                invalidBodyError: 'Invalid environment create request',
              })
              if (!validated.ok) return validated.response

              const { type, players } = validated.data
              const environment = getEnvironment(type)
              if (!environment) {
                return Response.json({ error: `Unknown environment type: ${type}` }, { status: 404 })
              }

              const hostAgent = players[0] ?? 'unknown'
              const hostDidRow = await env.DB.prepare('SELECT did FROM agents WHERE name = ?')
                .bind(hostAgent)
                .first<{ did: string }>()
                .catch(() => null)
              const hostDid = hostDidRow?.did ?? `did:cf:${hostAgent}`

              const relayId = env.RELAY.idFromName('main')
              const relay = env.RELAY.get(relayId)

              const tool = environment.getTool({
                agentName: hostAgent,
                agentDid: hostDid,
                db: env.DB,
                relay,
                broadcast: async () => {},
              })

              if (typeof tool.execute !== 'function') {
                return Response.json(
                  { error: `Environment type ${type} does not support creation` },
                  { status: 501 }
                )
              }

              const toolResult = await tool.execute('http', { command: 'new_game', players })
              const details = (toolResult as any)?.details as Record<string, unknown> | undefined
              const id = typeof details?.gameId === 'string' ? details.gameId : null
              if (!id) {
                return Response.json({ error: 'Environment create failed' }, { status: 502 })
              }

              const row = await env.DB
                .prepare('SELECT id, type, host_agent, phase, players, winner, created_at, updated_at FROM environments WHERE id = ?')
                .bind(id)
                .first()

              if (!row) {
                return Response.json({ id, type, hostAgent, players })
              }

              const rowType =
                typeof (row as any).type === 'string' && (row as any).type.trim().length > 0
                  ? (row as any).type
                  : inferEnvironmentTypeFromId(String((row as any).id))

              return Response.json({
                id: (row as any).id,
                type: rowType,
                hostAgent: (row as any).host_agent,
                phase: (row as any).phase,
                players: safeJsonParseArray((row as any).players),
                winner: (row as any).winner ?? null,
                createdAt: (row as any).created_at,
                updatedAt: (row as any).updated_at,
              })
            },
            { route: 'network.environments', request }
          )

          return isLegacyAlias ? withDeprecationHeaders(result, '/environments') : result
        }

        if (normalizedPathname.startsWith('/environments/') || normalizedPathname.startsWith('/games/')) {
          const legacyReplacement = mapLegacyGamesAliasPath(normalizedPathname)
          const isLegacyAlias = legacyReplacement !== null
          if (isLegacyAlias) {
            console.warn(`Route deprecated: ${request.method} ${normalizedPathname} -> ${legacyReplacement}`)
          }

          const envId = normalizedPathname.split('/')[2]
          const replacementPath = envId ? `/environments/${envId}` : '/environments/:id'

          const result = await withErrorHandling(
            async () => {
              if (!envId) return Response.json({ error: 'Environment ID required' }, { status: 400 })

              if (request.method === 'DELETE') {
                await env.DB.prepare('DELETE FROM environments WHERE id = ?').bind(envId).run()
                return Response.json({ ok: true, message: `Environment ${envId} deleted` })
              }

              if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

              const row = await env.DB.prepare('SELECT * FROM environments WHERE id = ?').bind(envId).first()
              if (!row) return Response.json({ error: 'Environment not found' }, { status: 404 })

              let state: unknown = null
              try {
                state = JSON.parse((row as any).state)
              } catch {
                state = (row as any).state
              }

              const rowType =
                typeof (row as any).type === 'string' && (row as any).type.trim().length > 0
                  ? (row as any).type
                  : inferEnvironmentTypeFromId(String((row as any).id))
              const players = safeJsonParseArray((row as any).players)

              let debugView: Record<string, unknown> | null = null
              const environment = getEnvironment(rowType)
              if (environment?.debugView) {
                try {
                  const rendered = await environment.debugView({
                    id: String((row as any).id),
                    type: rowType,
                    hostAgent: typeof (row as any).host_agent === 'string' ? (row as any).host_agent : null,
                    phase: typeof (row as any).phase === 'string' ? (row as any).phase : null,
                    players,
                    winner: typeof (row as any).winner === 'string' ? (row as any).winner : null,
                    state,
                  })
                  debugView =
                    rendered && typeof rendered === 'object' && !Array.isArray(rendered)
                      ? (rendered as Record<string, unknown>)
                      : { value: rendered ?? null }
                } catch (error) {
                  debugView = { error: error instanceof Error ? error.message : String(error) }
                }
              }

              return Response.json({
                id: (row as any).id,
                type: rowType,
                hostAgent: (row as any).host_agent,
                phase: (row as any).phase,
                players,
                winner: (row as any).winner ?? null,
                createdAt: (row as any).created_at,
                updatedAt: (row as any).updated_at,
                state,
                debugView,
              })
            },
            { route: 'network.environments.detail', request }
          )

          return isLegacyAlias ? withDeprecationHeaders(result, replacementPath) : result
        }

        // Admin
        if (normalizedPathname.startsWith('/admin/')) {
          return withErrorHandling(
            async () => {
              const authError = requireAdminBearerAuth(request, env)
              if (authError) return authError

              if (normalizedPathname === '/admin/analytics') {
                if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

                const registry = await listAgentRegistryRows(env.DB)

                const agents = await Promise.all(
                  registry.map(async (row) => {
                    try {
                      const agentId = env.AGENTS.idFromName(row.name)
                      const agent = env.AGENTS.get(agentId)

                      const analyticsRes = await agent.fetch(new Request('https://agent/__internal/analytics'))
                      const payload =
                        analyticsRes.ok ? await analyticsRes.json().catch(() => null) : null

                      const loopCount =
                        payload && typeof payload === 'object' && typeof (payload as any).loopCount === 'number'
                          ? (payload as any).loopCount
                          : null
                      const errors =
                        payload &&
                        typeof payload === 'object' &&
                        typeof (payload as any).consecutiveErrors === 'number'
                          ? (payload as any).consecutiveErrors
                          : null
                      const mode =
                        payload && typeof payload === 'object' && typeof (payload as any).alarmMode === 'string'
                          ? (payload as any).alarmMode
                          : null

                      const recentActionsRaw =
                        payload && typeof payload === 'object' ? (payload as any).actionOutcomes : null
                      const recentActions = Array.isArray(recentActionsRaw) ? recentActionsRaw.slice(-10) : []

                      const extensionsRaw =
                        payload && typeof payload === 'object' ? (payload as any).extensionMetrics : null
                      const extensions = Array.isArray(extensionsRaw) ? extensionsRaw : []

                      const lastReflection =
                        payload && typeof payload === 'object' && 'lastReflection' in (payload as any)
                          ? (payload as any).lastReflection ?? null
                          : null

                      return {
                        name: row.name,
                        loopCount,
                        errors,
                        mode,
                        recentActions,
                        extensions,
                        lastReflection,
                      }
                    } catch (error) {
                      const message = error instanceof Error ? error.message : String(error)
                      return {
                        name: row.name,
                        loopCount: null,
                        errors: null,
                        mode: null,
                        recentActions: [],
                        extensions: [],
                        lastReflection: null,
                        error: message,
                      }
                    }
                  })
                )

                return Response.json({ agents })
              }

              if (normalizedPathname === '/admin/errors') {
                if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

                const registry = await listAgentRegistryRows(env.DB)
                const grouped = new Map<
                  string,
                  {
                    category: string
                    lastSeenTs: number
                    agents: Array<{
                      name: string
                      did: string
                      ts: number
                      streak: number | null
                      backoffMs: number | null
                      lastPhase: string | null
                      lastMessage: string | null
                    }>
                  }
                >()

                await Promise.all(
                  registry.map(async (row) => {
                    try {
                      const agentId = env.AGENTS.idFromName(row.name)
                      const agent = env.AGENTS.get(agentId)
                      const payload = await fetchAgentJson(agent, `/agents/${encodeURIComponent(row.name)}/debug`)
                      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return

                      const record = payload as Record<string, unknown>
                      const lastError = parseLastError(record.lastError)
                      if (!lastError) return

                      const category = lastError.category
                      const bucket = grouped.get(category) ?? {
                        category,
                        lastSeenTs: 0,
                        agents: [],
                      }

                      bucket.lastSeenTs = Math.max(bucket.lastSeenTs, lastError.ts)
                      bucket.agents.push({
                        name: row.name,
                        did: row.did,
                        ts: lastError.ts,
                        streak: lastError.streak ?? readFiniteNumber(record.consecutiveErrors),
                        backoffMs: lastError.backoffMs,
                        lastPhase: lastError.lastPhase,
                        lastMessage: lastError.lastMessage,
                      })

                      grouped.set(category, bucket)
                    } catch {
                      // Ignore per-agent failures so one bad DO doesn't block aggregated diagnostics.
                    }
                  })
                )

                const groups = Array.from(grouped.values())
                  .map((entry) => ({
                    category: entry.category,
                    count: entry.agents.length,
                    lastSeenAt: entry.lastSeenTs > 0 ? new Date(entry.lastSeenTs).toISOString() : null,
                    agents: entry.agents.sort((a, b) => {
                      if (a.ts !== b.ts) return b.ts - a.ts
                      return a.name.localeCompare(b.name)
                    }),
                    _lastSeenTs: entry.lastSeenTs,
                  }))
                  .sort((a, b) => {
                    if (a._lastSeenTs !== b._lastSeenTs) return b._lastSeenTs - a._lastSeenTs
                    return a.category.localeCompare(b.category)
                  })
                  .map(({ _lastSeenTs, ...entry }) => entry)

                return Response.json({
                  groups,
                  totalGroups: groups.length,
                  totalErrors: groups.reduce((total, group) => total + group.count, 0),
                })
              }

              if (normalizedPathname === '/admin/loops') {
                if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

                const filterName = url.searchParams.get('agent')?.trim()
                const registry = await listAgentRegistryRows(env.DB)
                const selected = filterName
                  ? registry.filter((row) => row.name === filterName)
                  : registry

                if (filterName && selected.length === 0) {
                  return Response.json({ error: 'Agent not found' }, { status: 404 })
                }

                const agents = await Promise.all(
                  selected.map(async (row) => {
                    try {
                      const agentId = env.AGENTS.idFromName(row.name)
                      const agent = env.AGENTS.get(agentId)
                      const encodedName = encodeURIComponent(row.name)

                      const [loopStatusPayload, debugPayload, analyticsPayload] = await Promise.all([
                        fetchAgentJson(agent, `/agents/${encodedName}/loop/status`),
                        fetchAgentJson(agent, `/agents/${encodedName}/debug`),
                        fetchAgentJson(agent, '/__internal/analytics'),
                      ])

                      const loopStatus = parseLoopStatus(loopStatusPayload)
                      const debugRecord =
                        debugPayload && typeof debugPayload === 'object' && !Array.isArray(debugPayload)
                          ? (debugPayload as Record<string, unknown>)
                          : null
                      const analyticsRecord =
                        analyticsPayload && typeof analyticsPayload === 'object' && !Array.isArray(analyticsPayload)
                          ? (analyticsPayload as Record<string, unknown>)
                          : null

                      const transcript = parseLoopTranscript(debugRecord?.loopTranscript)
                      const outcomes = parseActionOutcomes(analyticsRecord?.actionOutcomes)
                      const successfulOutcomes = outcomes.filter((entry) => entry.success).length
                      const successRate =
                        outcomes.length > 0 ? Number((successfulOutcomes / outcomes.length).toFixed(3)) : null

                      return {
                        name: row.name,
                        did: row.did,
                        loopRunning: loopStatus.loopRunning,
                        loopCount: loopStatus.loopCount,
                        nextAlarm: loopStatus.nextAlarm,
                        avgDurationMs: transcript?.totalDurationMs ?? null,
                        toolCallsPerLoop:
                          transcript?.totalToolCalls ??
                          (loopStatus.loopCount && loopStatus.loopCount > 0
                            ? Number((outcomes.length / loopStatus.loopCount).toFixed(3))
                            : null),
                        successRate,
                        sampleSize: outcomes.length,
                        consecutiveErrors:
                          readFiniteNumber(debugRecord?.consecutiveErrors) ??
                          readFiniteNumber(analyticsRecord?.consecutiveErrors),
                      }
                    } catch (error) {
                      const message = error instanceof Error ? error.message : String(error)
                      return {
                        name: row.name,
                        did: row.did,
                        loopRunning: false,
                        loopCount: null,
                        nextAlarm: null,
                        avgDurationMs: null,
                        toolCallsPerLoop: null,
                        successRate: null,
                        sampleSize: 0,
                        consecutiveErrors: null,
                        error: message,
                      }
                    }
                  })
                )

                agents.sort((a, b) => {
                  const aDuration = a.avgDurationMs ?? -1
                  const bDuration = b.avgDurationMs ?? -1
                  if (aDuration !== bDuration) return bDuration - aDuration
                  return a.name.localeCompare(b.name)
                })

                return Response.json({ agents })
              }

              if (normalizedPathname === '/admin/pipeline-test') {
                if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
                const pipeline = (env as any).O11Y_PIPELINE
                if (!pipeline || typeof pipeline.send !== 'function') {
                  return Response.json({ ok: false, error: 'O11Y_PIPELINE binding missing or has no send()' }, { status: 500 })
                }
                try {
                  await pipeline.send([{ event_type: 'test.pipeline_verify', source: 'admin', _ts: new Date().toISOString() }])
                  return Response.json({ ok: true, message: 'Event sent to pipeline' })
                } catch (err) {
                  return Response.json({ ok: false, error: String(err) }, { status: 500 })
                }
              }

              if (normalizedPathname === '/admin/deploy-finalize') {
                if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
                
                // After a deploy, reset all agent DOs so they pick up new code.
                // This hits each DO's /reset endpoint which clears transient state and re-arms alarms.
                const registry = await listAgentRegistryRows(env.DB)
                const results: Array<{ name: string; ok: boolean; error?: string }> = []
                
                await Promise.all(
                  registry.map(async (row) => {
                    try {
                      const agentId = env.AGENTS.idFromName(row.name)
                      const agent = env.AGENTS.get(agentId)
                      const resetUrl = new URL(`/agents/${row.name}/reset`, request.url)
                      const resp = await agent.fetch(new Request(resetUrl.toString(), { method: 'POST' }))
                      const data = await resp.json().catch(() => null) as any
                      results.push({ name: row.name, ok: data?.ok ?? false })
                    } catch (err) {
                      results.push({ name: row.name, ok: false, error: String(err) })
                    }
                  })
                )
                
                return Response.json({ ok: true, agents: results })
              }

              return new Response('Admin not yet implemented', { status: 501 })
            },
            { route: 'network.admin', request }
          )
        }

        // Well-known (federation discovery)
        if (normalizedPathname === '/.well-known/agent-network.json') {
          return withErrorHandling(
            () => {
              // TODO: Return network identity for federation
              return new Response(
                JSON.stringify({
                  version: '0.0.1',
                  status: 'not-yet-implemented',
                }),
                {
                  headers: { 'Content-Type': 'application/json' },
                }
              )
            },
            { route: 'network.well-known', request }
          )
        }

        return new Response('Not found', { status: 404 })
      },
      { route: 'network.fetch', request }
    )

    return applyCorsHeaders(response, request, env)
  },
}

// Durable Objects are defined in separate files
export { AgentDO } from './agent'
export { RelayDO } from './relay'
