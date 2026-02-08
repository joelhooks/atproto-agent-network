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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(request, env)
    }

    const response = await withErrorHandling(
      async () => {
        const url = new URL(request.url)
        const normalizedPathname = url.pathname.replace(/\/+$/, '')

        const auth = requireAdminBearerAuth(request, env)
        if (auth) return auth

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
