/**
 * Relay Durable Object
 * 
 * Coordinator for the network. Handles:
 * - Agent registry
 * - Public key directory
 * - Event fanout (firehose)
 * - Subscription management
 * - Federation peering
 */

import { DurableObject } from 'cloudflare:workers'

import { withErrorHandling } from './http-errors'

interface Subscription {
  collections: string[]
  dids: string[]
}

interface AgentRegistration {
  did: string
  publicKeys: {
    encryption: string
    signing: string
  }
  metadata?: Record<string, unknown>
  registeredAt: string
}

export class RelayDO extends DurableObject {
  
  async fetch(request: Request): Promise<Response> {
    return withErrorHandling(
      async () => {
        const url = new URL(request.url)
        const path = url.pathname.replace('/relay', '')

        // Firehose subscription
        if (path === '/firehose' && request.headers.get('Upgrade') === 'websocket') {
          return withErrorHandling(
            () => this.handleFirehoseSubscription(request),
            { route: 'RelayDO.firehose', request }
          )
        }

        // Emit event (from agents)
        if (path === '/emit' && request.method === 'POST') {
          return withErrorHandling(
            () => this.handleEmit(request),
            { route: 'RelayDO.emit', request }
          )
        }

        // Agent registry
        if (path === '/agents') {
          return withErrorHandling(
            () => this.handleAgents(request),
            { route: 'RelayDO.agents', request }
          )
        }

        // Public key lookup
        if (path.startsWith('/keys/')) {
          const did = decodeURIComponent(path.replace('/keys/', ''))
          return withErrorHandling(
            () => this.getPublicKey(did),
            { route: 'RelayDO.keys', request }
          )
        }

        // Federation
        if (path === '/federation/peers') {
          return withErrorHandling(
            () => this.listPeers(),
            { route: 'RelayDO.federation.peers', request }
          )
        }

        return new Response('Not found', { status: 404 })
      },
      { route: 'RelayDO.fetch', request }
    )
  }
  
  private async handleFirehoseSubscription(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const collections = url.searchParams.get('collections')?.split(',') || ['*']
    const dids = url.searchParams.get('dids')?.split(',') || ['*']
    
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    
    // Store subscription filters
    server.serializeAttachment({ collections, dids } satisfies Subscription)
    this.ctx.acceptWebSocket(server)
    
    return new Response(null, { status: 101, webSocket: client })
  }
  
  private async handleEmit(request: Request): Promise<Response> {
    const event = await request.json()
    
    // Fan out to matching subscribers
    for (const ws of this.ctx.getWebSockets()) {
      const sub = ws.deserializeAttachment() as Subscription
      
      if (this.matchesSubscription(event, sub)) {
        ws.send(JSON.stringify(event))
      }
    }
    
    return new Response('OK')
  }
  
  private matchesSubscription(event: unknown, sub: Subscription): boolean {
    // TODO: Implement proper filtering
    if (sub.collections.includes('*') && sub.dids.includes('*')) {
      return true
    }
    return false
  }
  
  private async handleAgents(request: Request): Promise<Response> {
    if (request.method === 'POST') {
      const payload = await request.json().catch(() => null)
      if (!payload || typeof payload !== 'object') {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 })
      }

      const did =
        'did' in payload && typeof (payload as { did?: unknown }).did === 'string'
          ? (payload as { did: string }).did
          : null
      const publicKeys =
        'publicKeys' in payload && typeof (payload as { publicKeys?: unknown }).publicKeys === 'object'
          ? (payload as { publicKeys: unknown }).publicKeys
          : null

      const encryption =
        publicKeys &&
        typeof (publicKeys as { encryption?: unknown }).encryption === 'string'
          ? (publicKeys as { encryption: string }).encryption
          : null
      const signing =
        publicKeys &&
        typeof (publicKeys as { signing?: unknown }).signing === 'string'
          ? (publicKeys as { signing: string }).signing
          : null

      if (!did || !encryption || !signing) {
        return Response.json(
          { error: 'did and publicKeys.encryption/signing are required' },
          { status: 400 }
        )
      }

      const metadata =
        'metadata' in payload && payload.metadata && typeof payload.metadata === 'object'
          ? (payload as { metadata: Record<string, unknown> }).metadata
          : undefined

      const registration: AgentRegistration = {
        did,
        publicKeys: { encryption, signing },
        metadata,
        registeredAt: new Date().toISOString(),
      }

      await this.ctx.storage.put(this.agentKey(did), registration)
      return Response.json({ ok: true, did })
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 })
    }

    return this.listAgents()
  }
  
  private async getPublicKey(did: string): Promise<Response> {
    const agent = await this.ctx.storage.get<AgentRegistration>(this.agentKey(did))
    if (!agent) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    return Response.json({
      did: agent.did,
      publicKeys: agent.publicKeys,
    })
  }

  private async listAgents(): Promise<Response> {
    const entries = await this.ctx.storage.list<AgentRegistration>({ prefix: 'agent:' })
    const agents = Array.from(entries.values()).sort((a, b) =>
      b.registeredAt.localeCompare(a.registeredAt)
    )

    return Response.json({ agents })
  }

  private agentKey(did: string): string {
    return `agent:${did}`
  }
  
  private async listPeers(): Promise<Response> {
    // TODO: Return federation peers
    return Response.json({
      peers: [],
      status: 'not-yet-implemented'
    })
  }
  
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Handle subscription updates
  }
  
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // Cleanup subscription
  }
}
