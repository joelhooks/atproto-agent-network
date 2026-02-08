import { describe, expect, it, vi } from 'vitest'

import {
  exportPublicKey,
  generateEd25519Keypair,
  generateX25519Keypair,
} from '../../../packages/core/src/crypto'

vi.mock('cloudflare:workers', () => {
  class DurableObject {
    protected ctx: unknown
    protected env: unknown

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  }

  return { DurableObject }
})

class FakeStorage {
  private readonly store = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, structuredClone(value))
  }

  async list(options: { prefix?: string } = {}): Promise<Map<string, unknown>> {
    const prefix = options.prefix ?? ''
    const entries = new Map<string, unknown>()
    for (const [key, value] of this.store.entries()) {
      if (!key.startsWith(prefix)) continue
      entries.set(key, structuredClone(value))
    }
    return entries
  }
}

function createState() {
  const storage = new FakeStorage()
  const state = {
    storage,
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([] as WebSocket[]),
  }

  return { state, storage }
}

function createSocket(sub: { collections: string[]; dids: string[] }) {
  let attachment = sub
  return {
    deserializeAttachment: () => attachment,
    serializeAttachment: (next: unknown) => {
      attachment = next as { collections: string[]; dids: string[] }
    },
    send: vi.fn(),
  } as unknown as WebSocket
}

const dummyAgents = {
  idFromName: (name: string) => name,
  get: (_id: string) => ({ fetch: vi.fn() }),
}

describe('RelayDO', () => {
  it('registers agents and serves their public keys', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const did = 'did:cf:test-agent'
    const encryption = await exportPublicKey((await generateX25519Keypair()).publicKey)
    const signing = await exportPublicKey((await generateEd25519Keypair()).publicKey)

    const register = await relay.fetch(
      new Request('https://example.com/relay/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did,
          publicKeys: { encryption, signing },
          metadata: { name: 'test' },
        }),
      })
    )

    expect(register.status).toBe(200)
    await expect(register.json()).resolves.toMatchObject({ ok: true, did })

    const list = await relay.fetch(new Request('https://example.com/relay/agents'))
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      agents: [
        expect.objectContaining({
          did,
          publicKeys: { encryption, signing },
        }),
      ],
    })

    const keyLookup = await relay.fetch(
      new Request(`https://example.com/relay/keys/${encodeURIComponent(did)}`)
    )
    expect(keyLookup.status).toBe(200)
    await expect(keyLookup.json()).resolves.toMatchObject({
      did,
      publicKeys: { encryption, signing },
    })
  })

  it('returns 404 for unknown public keys', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const response = await relay.fetch(
      new Request('https://example.com/relay/keys/did%3Acf%3Amissing')
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Not found',
    })
  })

  it('returns 500 JSON when a route handler throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { state, storage } = createState()
    storage.put = vi.fn(async () => {
      throw new Error('db down')
    })

    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const did = 'did:cf:test-agent'
    const encryption = await exportPublicKey((await generateX25519Keypair()).publicKey)
    const signing = await exportPublicKey((await generateEd25519Keypair()).publicKey)

    const response = await relay.fetch(
      new Request('https://example.com/relay/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did,
          publicKeys: { encryption, signing },
        }),
      })
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Internal Server Error',
    })

    expect(consoleSpy).toHaveBeenCalledWith(
      'Unhandled route error',
      expect.objectContaining({ route: 'RelayDO.agents' })
    )
    consoleSpy.mockRestore()
  })

  it('filters emitted events by collection (exact + wildcard prefix)', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const all = createSocket({ collections: ['*'], dids: ['*'] })
    const commsExact = createSocket({ collections: ['agent.comms.message'], dids: ['*'] })
    const commsWildcard = createSocket({ collections: ['agent.comms.*'], dids: ['*'] })
    const memoryWildcard = createSocket({ collections: ['agent.memory.*'], dids: ['*'] })

    state.getWebSockets = vi
      .fn()
      .mockReturnValue([all, commsExact, commsWildcard, memoryWildcard] as WebSocket[])

    const event = {
      did: 'did:cf:alice',
      collection: 'agent.comms.message',
      action: 'create',
      timestamp: Date.now(),
    }

    const response = await relay.fetch(
      new Request('https://example.com/relay/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      })
    )

    expect(response.status).toBe(200)
    expect((all as any).send).toHaveBeenCalledWith(JSON.stringify(event))
    expect((commsExact as any).send).toHaveBeenCalledWith(JSON.stringify(event))
    expect((commsWildcard as any).send).toHaveBeenCalledWith(JSON.stringify(event))
    expect((memoryWildcard as any).send).not.toHaveBeenCalled()
  })

  it('filters emitted events by did (and can combine did + collection filters)', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const all = createSocket({ collections: ['*'], dids: ['*'] })
    const alice = createSocket({ collections: ['*'], dids: ['did:cf:alice'] })
    const bob = createSocket({ collections: ['*'], dids: ['did:cf:bob'] })
    const aliceComms = createSocket({ collections: ['agent.comms.*'], dids: ['did:cf:alice'] })

    state.getWebSockets = vi
      .fn()
      .mockReturnValue([all, alice, bob, aliceComms] as WebSocket[])

    const event = {
      did: 'did:cf:alice',
      collection: 'agent.comms.task',
      action: 'create',
      timestamp: Date.now(),
    }

    const response = await relay.fetch(
      new Request('https://example.com/relay/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      })
    )

    expect(response.status).toBe(200)
    expect((all as any).send).toHaveBeenCalledWith(JSON.stringify(event))
    expect((alice as any).send).toHaveBeenCalledWith(JSON.stringify(event))
    expect((aliceComms as any).send).toHaveBeenCalledWith(JSON.stringify(event))
    expect((bob as any).send).not.toHaveBeenCalled()
  })

  it('filters commit-style events by repo did and op collection paths', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const aliceComms = createSocket({ collections: ['agent.comms.*'], dids: ['did:cf:alice'] })
    const bobComms = createSocket({ collections: ['agent.comms.*'], dids: ['did:cf:bob'] })

    state.getWebSockets = vi.fn().mockReturnValue([aliceComms, bobComms] as WebSocket[])

    const commitEvent = {
      $type: 'com.atproto.sync.subscribeRepos#commit',
      repo: 'did:cf:alice',
      ops: [
        {
          action: 'create',
          path: 'agent.comms.message/3jui7-test',
          cid: 'bafyreibogus',
        },
      ],
    }

    const response = await relay.fetch(
      new Request('https://example.com/relay/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commitEvent),
      })
    )

    expect(response.status).toBe(200)
    expect((aliceComms as any).send).toHaveBeenCalledWith(JSON.stringify(commitEvent))
    expect((bobComms as any).send).not.toHaveBeenCalled()
  })

  it('updates websocket subscription filters via message', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, { AGENTS: dummyAgents } as never)

    const ws = createSocket({ collections: ['*'], dids: ['*'] })

    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'subscribe',
        collections: ['agent.comms.*'],
        dids: ['did:cf:alice'],
      })
    )

    expect(ws.deserializeAttachment()).toEqual({
      collections: ['agent.comms.*'],
      dids: ['did:cf:alice'],
    })
    expect((ws as any).send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'subscribed',
        collections: ['agent.comms.*'],
        dids: ['did:cf:alice'],
      })
    )
  })
})
