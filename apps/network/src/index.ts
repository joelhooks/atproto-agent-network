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
    goals: z.array(z.unknown()).optional().default([]),
    enabledTools: z.array(z.string()).optional().default([]),
  })
  .passthrough()

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
          !isLoopStatusRoute
        
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

        // Games (shared D1 state)
        if (normalizedPathname === '/games') {
          return withErrorHandling(
            async () => {
              const active = url.searchParams.get('all') === 'true' ? '' : " AND phase != 'finished'"
              const rows = await env.DB.prepare(
                `SELECT id, host_agent, phase, players, winner, created_at, updated_at FROM games WHERE 1=1${active} ORDER BY updated_at DESC LIMIT 20`
              ).all()
              return Response.json({
                games: (rows.results ?? []).map((r: any) => ({
                  ...r,
                  players: r.players ? JSON.parse(r.players) : [],
                })),
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
              const row = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first()
              if (!row) return Response.json({ error: 'Game not found' }, { status: 404 })
              const game = JSON.parse((row as any).state)
              const { renderBoard, generateGameSummary } = await import('./games/catan')
              return Response.json({
                id: game.id,
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
            () => {
              // TODO: Admin routes
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
