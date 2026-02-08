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

describe('RelayDO', () => {
  it('registers agents and serves their public keys', async () => {
    const { state } = createState()
    const { RelayDO } = await import('./relay')
    const relay = new RelayDO(state as never, {} as never)

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
    const relay = new RelayDO(state as never, {} as never)

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
    const relay = new RelayDO(state as never, {} as never)

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
})
