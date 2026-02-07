/**
 * Agent Network - Cloudflare Worker Entry Point
 * 
 * Routes requests to Agent DOs, Relay DO, or static dashboard.
 */

import { DurableObject } from 'cloudflare:workers'

export interface Env {
  AGENTS: DurableObjectNamespace
  RELAY: DurableObjectNamespace
  DB: D1Database
  BLOBS: R2Bucket
  VECTORIZE: VectorizeIndex
  MESSAGE_QUEUE: Queue
  AI: Ai
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    
    // Dashboard
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      // TODO: Serve dashboard SPA
      return new Response('Dashboard not yet implemented', { status: 501 })
    }
    
    // Relay (firehose, subscriptions)
    if (url.pathname.startsWith('/relay/')) {
      const relayId = env.RELAY.idFromName('main')
      const relay = env.RELAY.get(relayId)
      return relay.fetch(request)
    }
    
    // Agent operations
    if (url.pathname.startsWith('/agents/')) {
      const parts = url.pathname.split('/')
      const agentName = parts[2]
      
      if (!agentName) {
        return new Response('Agent name required', { status: 400 })
      }
      
      const agentId = env.AGENTS.idFromName(agentName)
      const agent = env.AGENTS.get(agentId)
      return agent.fetch(request)
    }
    
    // Admin
    if (url.pathname.startsWith('/admin/')) {
      // TODO: Admin routes
      return new Response('Admin not yet implemented', { status: 501 })
    }
    
    // Well-known (federation discovery)
    if (url.pathname === '/.well-known/agent-network.json') {
      // TODO: Return network identity for federation
      return new Response(JSON.stringify({
        version: '0.0.1',
        status: 'not-yet-implemented'
      }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    return new Response('Not found', { status: 404 })
  },
}

// Durable Objects are defined in separate files
export { AgentDO } from './agent'
export { RelayDO } from './relay'
