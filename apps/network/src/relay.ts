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

type RelayEnv = {
  AGENTS: DurableObjectNamespace
  DB?: D1Database
}

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
  private readonly relayEnv: RelayEnv

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env)
    this.relayEnv = env
  }

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

        // Deliver message (from agent tool) to another agent via the relay.
        if (path === '/message' && request.method === 'POST') {
          return withErrorHandling(
            () => this.handleMessage(request),
            { route: 'RelayDO.message', request }
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

  private async handleMessage(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const senderDid =
      'senderDid' in payload && typeof (payload as { senderDid?: unknown }).senderDid === 'string'
        ? (payload as { senderDid: string }).senderDid
        : null
    const recipientDid =
      'recipientDid' in payload &&
      typeof (payload as { recipientDid?: unknown }).recipientDid === 'string'
        ? (payload as { recipientDid: string }).recipientDid
        : null
    const content =
      'content' in payload && (payload as { content?: unknown }).content && typeof (payload as { content: unknown }).content === 'object'
        ? (payload as { content: Record<string, unknown> }).content
        : null

    if (!senderDid || !recipientDid || !content) {
      return Response.json(
        { error: 'senderDid, recipientDid, and content are required' },
        { status: 400 }
      )
    }

    const record = {
      $type: 'agent.comms.message',
      sender: senderDid,
      recipient: recipientDid,
      content,
      createdAt: new Date().toISOString(),
    }

    // Resolve DID → agent name via D1 registry (DOs are keyed by name, not DID hash)
    let agentName: string
    if (this.relayEnv.DB) {
      const row = await this.relayEnv.DB.prepare('SELECT name FROM agents WHERE did = ?').bind(recipientDid).first<{ name: string }>()
      if (row) {
        agentName = row.name
      } else {
        // Fallback: try using DID hash as name (legacy behavior)
        agentName = recipientDid.startsWith('did:cf:')
          ? recipientDid.slice('did:cf:'.length)
          : recipientDid
      }
    } else {
      agentName = recipientDid.startsWith('did:cf:')
        ? recipientDid.slice('did:cf:'.length)
        : recipientDid
    }

    const agents = this.relayEnv.AGENTS
    const agentId = agents.idFromName(agentName)
    const stub = agents.get(agentId)

    const deliver = await stub.fetch(
      new Request('https://agent/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      })
    )

    if (!deliver.ok) {
      const text = await deliver.text().catch(() => '')
      return Response.json(
        { error: 'Delivery failed', status: deliver.status, body: text },
        { status: 502 }
      )
    }

    // Fanout to firehose subscribers (same matching logic as /emit).
    const event = {
      event_type: 'agent.comms.message',
      did: senderDid,
      agent_did: senderDid,
      record,
    }
    for (const ws of this.ctx.getWebSockets()) {
      const sub = ws.deserializeAttachment() as Subscription
      if (this.matchesSubscription(event, sub)) {
        ws.send(JSON.stringify(event))
      }
    }

    return Response.json({ ok: true })
  }

  private async handleFirehoseSubscription(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Support both our simplified query params and Jetstream-style naming.
    const collections = this.parseFilterList(
      url.searchParams.get('collections') ?? url.searchParams.get('wantedCollections')
    )
    const dids = this.parseFilterList(url.searchParams.get('dids') ?? url.searchParams.get('wantedDids'))
    
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
    const collections = this.normalizeFilterList(sub?.collections)
    const dids = this.normalizeFilterList(sub?.dids)

    const anyCollection = collections.length === 0 || collections.includes('*')
    const anyDid = dids.length === 0 || dids.includes('*')

    if (anyCollection && anyDid) {
      return true
    }

    const eventDids = this.extractEventDids(event)
    const eventCollections = this.extractEventCollections(event)

    const didMatches =
      anyDid || (eventDids.length > 0 && eventDids.some((did) => this.matchesAnyPattern(did, dids)))
    const collectionMatches =
      anyCollection ||
      (eventCollections.length > 0 &&
        eventCollections.some((collection) => this.matchesAnyPattern(collection, collections)))

    return didMatches && collectionMatches
  }

  private parseFilterList(param: string | null): string[] {
    if (!param) return ['*']
    return this.normalizeFilterList(param.split(','))
  }

  private normalizeFilterList(list: unknown): string[] {
    if (!Array.isArray(list)) return ['*']
    const normalized = list
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
    return normalized.length > 0 ? normalized : ['*']
  }

  private extractEventDids(event: unknown): string[] {
    if (!event || typeof event !== 'object') return []
    const e = event as Record<string, unknown>

    const dids: string[] = []
    const push = (value: unknown) => {
      if (typeof value === 'string' && value.length > 0) dids.push(value)
    }

    // Common fields for simplified JSON events and atproto/jetstream-style payloads.
    push(e.did)
    push(e.repo)
    push(e.agent_did)
    push((e as { agentDid?: unknown }).agentDid)

    return Array.from(new Set(dids))
  }

  private extractEventCollections(event: unknown): string[] {
    if (!event || typeof event !== 'object') return []
    const e = event as Record<string, unknown>

    const collections: string[] = []
    const push = (value: unknown) => {
      if (typeof value === 'string' && value.length > 0) collections.push(value)
    }

    // Simplified JSON event shape: { collection }
    push(e.collection)

    // Sometimes the payload is the record itself: { $type: 'agent.*' }
    if (typeof e.$type === 'string' && e.$type.startsWith('agent.')) {
      push(e.$type)
    }

    // Nested record shape: { record: { $type: 'agent.*' } }
    const record = e.record
    if (record && typeof record === 'object') {
      const recordType = (record as { $type?: unknown }).$type
      if (typeof recordType === 'string' && recordType.length > 0) {
        push(recordType)
      }
    }

    // atproto commit event style: { ops: [{ path: 'collection/rkey', ... }] }
    const ops = e.ops
    if (Array.isArray(ops)) {
      for (const op of ops) {
        if (!op || typeof op !== 'object') continue
        const path = (op as { path?: unknown }).path
        if (typeof path !== 'string') continue
        const slash = path.indexOf('/')
        push(slash === -1 ? path : path.slice(0, slash))
      }
    }

    return Array.from(new Set(collections))
  }

  private matchesAnyPattern(value: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.matchesPattern(value, pattern)) return true
    }
    return false
  }

  private matchesPattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (!pattern.includes('*')) return value === pattern

    const first = pattern.indexOf('*')
    const last = pattern.lastIndexOf('*')

    // Fast paths for the common "prefix*" / "*suffix" cases.
    if (first === pattern.length - 1 && last === first) {
      const prefix = pattern.slice(0, -1)
      return value.startsWith(prefix)
    }
    if (first === 0 && last === 0) {
      const suffix = pattern.slice(1)
      return value.endsWith(suffix)
    }

    // General glob matching via a safe regex conversion.
    const escapedParts = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&'))
    const regex = new RegExp(`^${escapedParts.join('.*')}$`)
    return regex.test(value)
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
    try {
      const text =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(new Uint8Array(message))
      const trimmed = text.trim()
      if (!trimmed) return

      let payload: unknown
      try {
        payload = JSON.parse(trimmed) as unknown
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }))
        return
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }))
        return
      }

      const data = payload as Record<string, unknown>
      const type = typeof data.type === 'string' ? data.type : ''

      if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }

      // Allow clients to update filters after connecting.
      if (type && type !== 'subscribe' && type !== 'filters' && type !== 'update') {
        ws.send(JSON.stringify({ type: 'error', error: 'Unsupported message type' }))
        return
      }

      const collections = this.normalizeFilterList(data.collections)
      const dids = this.normalizeFilterList(data.dids)

      ws.serializeAttachment({ collections, dids } satisfies Subscription)
      ws.send(JSON.stringify({ type: 'subscribed', collections, dids }))
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error('RelayDO websocket message error', { error: messageText })
      try {
        ws.send(JSON.stringify({ type: 'error', error: messageText }))
      } catch {
        // Ignore send errors on closed sockets.
      }
    }
  }
  
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // Cleanup subscription
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error('RelayDO websocket error', { error: message })
  }
}
