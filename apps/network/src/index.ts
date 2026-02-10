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

function parseGamesLimit(value: string | null): number | { error: string } {
  if (value == null || value === '') return 20
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return { error: 'limit must be an integer' }
  if (parsed < 1) return { error: 'limit must be >= 1' }
  if (parsed > 100) return { error: 'limit must be <= 100' }
  return parsed
}

function parseGamesCursor(value: string): { updatedAtRaw: string; updatedAtMs: number; id: string } | null {
  const idx = value.indexOf('|')
  if (idx <= 0 || idx === value.length - 1) return null
  const updatedAtRaw = value.slice(0, idx)
  const id = value.slice(idx + 1)
  const updatedAtMs = parseD1Timestamp(updatedAtRaw)
  if (updatedAtMs == null) return null
  if (!id) return null
  return { updatedAtRaw, updatedAtMs, id }
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
                { status: 'ok', missing: [], uptimeMs },
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

        // Environments (backed by shared D1 games table)
        if (normalizedPathname === '/environments') {
          return withErrorHandling(
            async () => {
              if (request.method === 'GET') {
                const type = url.searchParams.get('type')?.trim()
                const phase = url.searchParams.get('phase')?.trim()
                const player = url.searchParams.get('player')?.trim()

                const sqlParts = [
                  'SELECT id, host_agent, phase, players, winner, created_at, updated_at FROM games WHERE 1=1',
                ]
                const binds: unknown[] = []

                if (type) {
                  sqlParts.push('AND id LIKE ?')
                  binds.push(`${type}_%`)
                }
                if (phase) {
                  sqlParts.push('AND phase = ?')
                  binds.push(phase)
                }
                if (player) {
                  sqlParts.push('AND players LIKE ?')
                  binds.push(`%${player}%`)
                }

                sqlParts.push('ORDER BY updated_at DESC LIMIT 20')

                const rows = await env.DB.prepare(sqlParts.join(' ')).bind(...binds).all()
                const environments = (rows.results ?? []).map((r: any) => ({
                  id: r.id,
                  type: inferEnvironmentTypeFromId(String(r.id)),
                  hostAgent: r.host_agent,
                  phase: r.phase,
                  players: safeJsonParseArray(r.players),
                  winner: r.winner ?? null,
                  createdAt: r.created_at,
                  updatedAt: r.updated_at,
                }))

                return Response.json({ environments })
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

              const result = await tool.execute('http', { command: 'new_game', players })
              const details = (result as any)?.details as Record<string, unknown> | undefined
              const id = typeof details?.gameId === 'string' ? details.gameId : null
              if (!id) {
                return Response.json({ error: 'Environment create failed' }, { status: 502 })
              }

              const row = await env.DB
                .prepare('SELECT id, host_agent, phase, players, winner, created_at, updated_at FROM games WHERE id = ?')
                .bind(id)
                .first()

              if (!row) {
                return Response.json({
                  id,
                  type,
                  hostAgent,
                  players,
                })
              }

              return Response.json({
                id: (row as any).id,
                type,
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
        }

        if (normalizedPathname.startsWith('/environments/')) {
          return withErrorHandling(
            async () => {
              if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

              const envId = normalizedPathname.split('/')[2]
              if (!envId) return Response.json({ error: 'Environment ID required' }, { status: 400 })

              const row = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(envId).first()
              if (!row) return Response.json({ error: 'Environment not found' }, { status: 404 })

              let state: unknown = null
              try {
                state = JSON.parse((row as any).state)
              } catch {
                state = (row as any).state
              }

              return Response.json({
                id: (row as any).id,
                type: inferEnvironmentTypeFromId(String((row as any).id)),
                hostAgent: (row as any).host_agent,
                phase: (row as any).phase,
                players: safeJsonParseArray((row as any).players),
                winner: (row as any).winner ?? null,
                createdAt: (row as any).created_at,
                updatedAt: (row as any).updated_at,
                state,
              })
            },
            { route: 'network.environments.detail', request }
          )
        }

        // Games (shared D1 state)
        if (normalizedPathname === '/games') {
          return withErrorHandling(
            async () => {
              const showAll = url.searchParams.get('all') === 'true'
              const limitParsed = parseGamesLimit(url.searchParams.get('limit'))
              if (typeof limitParsed === 'object') {
                return Response.json({ error: limitParsed.error }, { status: 400 })
              }
              const limit = limitParsed

              const cursorRaw = url.searchParams.get('cursor')
              const cursor = cursorRaw ? parseGamesCursor(cursorRaw) : null
              if (cursorRaw && !cursor) {
                return Response.json({ error: 'Invalid cursor' }, { status: 400 })
              }

              // D1MockDatabase only supports a small SQL subset (no ORs, no >=),
              // so fetch a bounded window and apply the 24h + pagination logic in JS.
              const fetchLimit = Math.min(Math.max(limit * 10, 200), 500)

              const selectCols = 'id, host_agent, phase, players, winner, created_at, updated_at'
              const activeSql = `SELECT ${selectCols} FROM games WHERE phase NOT IN ('finished', 'abandoned', 'setup') ORDER BY updated_at DESC LIMIT ${fetchLimit}`
              const finishedSql = `SELECT ${selectCols} FROM games WHERE phase = 'finished' ORDER BY updated_at DESC LIMIT ${fetchLimit}`
              const allSql = `SELECT ${selectCols} FROM games ORDER BY updated_at DESC LIMIT ${fetchLimit}`

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

                const recentFinished = (finishedRows.results ?? []).filter((r: any) => {
                  const ts = parseD1Timestamp(r.updated_at)
                  return ts != null && ts >= cutoffMs
                })

                rawRows = [...(activeRows.results ?? []), ...recentFinished]
              }

              const enriched = rawRows
                .map((r: any) => {
                  const id = String(r.id ?? '')
                  const updatedAtRaw = r.updated_at
                  const updatedAtMs = parseD1Timestamp(updatedAtRaw) ?? 0
                  return {
                    row: {
                      ...r,
                      id,
                      players: safeJsonParseArray(r.players),
                      type: inferEnvironmentTypeFromId(id),
                    },
                    id,
                    updatedAtRaw: String(updatedAtRaw ?? ''),
                    updatedAtMs,
                  }
                })
                .filter((r) => r.id.length > 0)
                .sort((a, b) => {
                  if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs
                  return b.id.localeCompare(a.id)
                })

              const afterCursor = cursor
                ? enriched.filter((g) => {
                    if (g.updatedAtMs < cursor.updatedAtMs) return true
                    if (g.updatedAtMs > cursor.updatedAtMs) return false
                    return g.id.localeCompare(cursor.id) < 0
                  })
                : enriched

              const pagePlusOne = afterCursor.slice(0, limit + 1)
              const hasMore = pagePlusOne.length > limit
              const page = pagePlusOne.slice(0, limit)

              const last = page.at(-1)
              const nextCursor =
                hasMore && last && last.updatedAtRaw
                  ? `${last.updatedAtRaw}|${last.id}`
                  : undefined

              return Response.json({
                games: page.map((g) => g.row),
                nextCursor,
              })
            },
            { route: 'network.games', request }
          )
        }

        if (normalizedPathname.startsWith('/games/')) {
          return withErrorHandling(
            async () => {
              const gameId = normalizedPathname.split('/')[2]
              if (!gameId) return Response.json({ error: 'Game ID required' }, { status: 400 })
                            // DELETE /games/:id — admin kill game (hard delete from D1, any type)
              if (request.method === 'DELETE') {
                await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gameId).run()
                return Response.json({ ok: true, message: `Game ${gameId} cancelled` })
              }

              // Backward compat: /games/:id GET is a legacy alias for catan environments only.
              if (!gameId.startsWith('catan_')) {
                return Response.json({ error: 'Use /environments/:id for non-catan games' }, { status: 404 })
              }

              const row = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first()
              if (!row) return Response.json({ error: 'Game not found' }, { status: 404 })
              const game = JSON.parse((row as any).state)
              const { renderBoard, generateGameSummary } = await import('./games/catan')

              // ?raw=true returns full game state for visualization
              if (url.searchParams.get('raw') === 'true') {
                return Response.json(game)
              }

              return Response.json({
                id: game.id,
                type: 'catan',
                phase: game.phase,
                turn: game.turn,
                currentPlayer: game.currentPlayer,
                players: game.players?.map((p: any) => ({ name: p.name, victoryPoints: p.victoryPoints, resources: p.resources })),
                winner: game.winner,
                log: game.log?.slice(-20),
                board: renderBoard(game),
                summary: generateGameSummary(game),
              })
            },
            { route: 'network.games.detail', request }
          )
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
