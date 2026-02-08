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
  type PiAgentFactory,
  type PiAgentTool,
} from '../../../packages/agent/src'
import {
  exportPublicKey,
  exportCryptoKeyPairJwk,
  generateEd25519Keypair,
  generateX25519Keypair,
  importCryptoKeyPairJwk,
  type StoredCryptoKeyPairJwk,
} from '../../../packages/core/src/crypto'
import { createDid } from '../../../packages/core/src/identity'
import { validateLexiconRecord } from '../../../packages/core/src/validation'
import type { AgentIdentity } from '../../../packages/core/src/types'

import { withErrorHandling } from './http-errors'

interface AgentEnv {
  DB: D1Database
  BLOBS: R2Bucket
  RELAY?: DurableObjectNamespace
  AI?: unknown
  PI_AGENT_FACTORY?: PiAgentFactory
  PI_AGENT_MODEL?: unknown
  PI_SYSTEM_PROMPT?: string
}

interface StoredAgentIdentityV1 {
  version: 1
  did: string
  signingKey: StoredCryptoKeyPairJwk
  encryptionKey: StoredCryptoKeyPairJwk
  createdAt: number
  rotatedAt?: number
}

export class AgentDO extends DurableObject {
  private readonly did: string
  private readonly env: AgentEnv
  private initialized = false
  private initializing: Promise<void> | null = null
  private registeredWithRelay = false
  private identity: AgentIdentity | null = null
  private memory: EncryptedMemory | null = null
  private agent: PiAgentWrapper | null = null

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env)
    this.env = env
    this.did = createDid(ctx.id.toString())
  }
  
  async fetch(request: Request): Promise<Response> {
    return withErrorHandling(
      async () => {
        if (!this.initialized) {
          await this.initialize()
        }

        const url = new URL(request.url)

        // WebSocket for real-time communication
        if (request.headers.get('Upgrade') === 'websocket') {
          return withErrorHandling(
            () => this.handleWebSocket(request),
            { route: 'AgentDO.websocket', request }
          )
        }

        switch (url.pathname.split('/').pop()) {
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
          default:
            return new Response('Not found', { status: 404 })
        }
      },
      { route: 'AgentDO.fetch', request }
    )
  }
  
  private async initialize(): Promise<void> {
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

      this.memory = new EncryptedMemory(this.env.DB, this.env.BLOBS, this.identity)

      const tools = this.buildTools()
      const systemPrompt =
        this.env.PI_SYSTEM_PROMPT ?? 'You are a Pi agent running on the AT Protocol Agent Network.'
      const model = this.env.PI_AGENT_MODEL ?? this.env.AI ?? { provider: 'unknown' }

      this.agent = new PiAgentWrapper({
        systemPrompt,
        model,
        tools,
        agentFactory: this.env.PI_AGENT_FACTORY,
      })

      this.initialized = true
      this.initializing = null
    })()

    await this.initializing
  }

  private buildTools(): PiAgentTool[] {
    if (!this.memory) {
      return []
    }

    const memory = this.memory

    return [
      {
        name: 'remember',
        description: 'Store an encrypted memory record.',
        parameters: {
          type: 'object',
          properties: {
            record: { type: 'object', description: 'Memory record payload.' },
          },
          required: ['record'],
        },
        execute: async (params: { record?: unknown }) => {
          const record =
            params && typeof params === 'object' && 'record' in params
              ? (params as { record?: unknown }).record
              : params
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
          return { id }
        },
      },
      {
        name: 'recall',
        description: 'Retrieve an encrypted memory record by id.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Record id to retrieve.' },
          },
          required: ['id'],
        },
        execute: async (params: { id?: string }) => {
          if (!params?.id) {
            throw new Error('recall requires an id')
          }
          const record = await memory.retrieve(params.id)
          return { record }
        },
      },
    ]
  }
  
  private async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    
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
    const relayNamespace = this.env.RELAY
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

    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload.prompt !== 'string') {
      return Response.json({ error: 'prompt is required' }, { status: 400 })
    }

    const result = await this.agent.prompt(payload.prompt, payload.options)
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
  
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // TODO: Handle incoming WebSocket messages
  }
  
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // TODO: Cleanup
  }
}
