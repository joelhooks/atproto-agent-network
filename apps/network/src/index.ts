/**
 * Agent Network - Cloudflare Worker Entry Point
 * 
 * Routes requests to Agent DOs, Relay DO, or static dashboard.
 */

import { DurableObject } from 'cloudflare:workers'

import { LexiconRecordSchema } from '../../../packages/core/src/lexicons'

import { requireAdminBearerAuth } from './auth'
import { applyCorsHeaders, corsPreflightResponse } from './cors'
import { withErrorHandling } from './http-errors'
import { validateRequestJson } from './http-validation'

const WORKER_STARTED_AT = Date.now()

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
        if (normalizedPathname.startsWith('/agents/')) {
          return withErrorHandling(
            async () => {
              const parts = normalizedPathname.split('/')
              const agentName = parts[2]

              if (!agentName) {
                return new Response('Agent name required', { status: 400 })
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
