import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../packages/core/src/d1-mock'

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
    assertDurableObjectSerializable(value)
    this.store.set(key, structuredClone(value))
  }
}

function assertDurableObjectSerializable(value: unknown): void {
  const seen = new Set<unknown>()

  function visit(node: unknown, path: string): void {
    if (node === null) return

    const t = typeof node
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
      return
    }
    if (t === 'undefined') return
    if (t === 'symbol' || t === 'function') {
      throw new Error(`Durable Object storage cannot serialize ${t} at ${path}`)
    }

    if (typeof CryptoKey === 'function' && node instanceof CryptoKey) {
      throw new Error(`Durable Object storage cannot serialize CryptoKey at ${path}`)
    }

    if (node instanceof ArrayBuffer) return
    if (node instanceof Uint8Array) return
    if (ArrayBuffer.isView(node)) return
    if (node instanceof Date) return

    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], `${path}[${i}]`)
      }
      return
    }

    if (node instanceof Map) {
      for (const [k, v] of node.entries()) {
        visit(k, `${path}<mapKey>`)
        visit(v, `${path}<mapValue>`)
      }
      return
    }

    if (node instanceof Set) {
      let i = 0
      for (const entry of node.values()) {
        visit(entry, `${path}<set>[${i}]`)
        i += 1
      }
      return
    }

    if (t === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, `${path}.${k}`)
      }
      return
    }

    throw new Error(`Durable Object storage cannot serialize value at ${path}`)
  }

  visit(value, '$')
}

interface RecordRow {
  id: string
  did: string
  collection: string
  rkey: string
  ciphertext: Uint8Array
  encrypted_dek: Uint8Array | null
  nonce: Uint8Array
  public: number
  created_at: string
  updated_at?: string | null
}

function createState(id = 'agent-123') {
  const storage = new FakeStorage()
  const state = {
    id: { toString: () => id },
    storage,
    acceptWebSocket: vi.fn(),
  }

  return { state, storage }
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const db = new D1MockDatabase()
  const env = {
    DB: db,
    BLOBS: {},
    AI: { provider: 'test' },
    ...overrides,
  }

  return { env, db }
}

describe('AgentDO', () => {
  it('creates an identity and exposes public keys', async () => {
    const { state, storage } = createState('agent-identity')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(new Request('https://example/identity'))
    const body = await response.json()
    const stored = await storage.get<Record<string, unknown>>('identity')

    expect(body.did).toBe('did:cf:agent-identity')
    expect(body.publicKeys.encryption).toMatch(/^z/)
    expect(body.publicKeys.signing).toMatch(/^z/)
    expect(stored).toMatchObject({
      version: 1,
      did: 'did:cf:agent-identity',
      signingKey: {
        algorithm: 'Ed25519',
      },
      encryptionKey: {
        algorithm: 'X25519',
      },
    })

    expect(stored?.signingKey).toMatchObject({
      publicJwk: { kty: 'OKP', crv: 'Ed25519' },
      privateJwk: { kty: 'OKP', crv: 'Ed25519' },
    })
    expect(stored?.encryptionKey).toMatchObject({
      publicJwk: { kty: 'OKP', crv: 'X25519' },
      privateJwk: { kty: 'OKP', crv: 'X25519' },
    })
  })

  it('registers with the relay public key directory', async () => {
    const { state } = createState('agent-register')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const relayFetch = vi.fn()
    let relayBody: unknown = null

    relayFetch.mockImplementation(async (req: Request) => {
      relayBody = await req.json()
      return Response.json({ ok: true })
    })

    const relayNamespace = {
      idFromName: vi.fn().mockReturnValue('relay-main'),
      get: vi.fn().mockReturnValue({ fetch: relayFetch }),
    }

    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      RELAY: relayNamespace,
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(new Request('https://example/identity'))
    const body = await response.json()

    expect(relayFetch).toHaveBeenCalledTimes(1)
    expect(relayBody).toMatchObject({
      did: body.did,
      publicKeys: {
        encryption: expect.stringMatching(/^z/),
        signing: expect.stringMatching(/^z/),
      },
    })
  })

  it('reloads the identity from storage', async () => {
    const { state } = createState('agent-reload')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')

    const agent1 = new AgentDO(state as never, env as never)
    const response1 = await agent1.fetch(new Request('https://example/identity'))
    const body1 = await response1.json()

    const agent2 = new AgentDO(state as never, env as never)
    const response2 = await agent2.fetch(new Request('https://example/identity'))
    const body2 = await response2.json()

    expect(body2).toEqual(body1)
  })

  it('forwards prompts to the Pi agent with memory tools', async () => {
    const { state } = createState('agent-prompt')
    const prompt = vi.fn().mockResolvedValue({ content: 'ok' })
    let initConfig: { initialState?: { tools?: Array<{ name: string }> } } | undefined

    const agentFactory = vi.fn().mockImplementation(async (init) => {
      initConfig = init
      return { prompt }
    })

    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      PI_SYSTEM_PROMPT: 'system-test',
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(new Request('https://example/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', options: { temperature: 0 } }),
    }))

    const body = await response.json()
    const toolNames = initConfig?.initialState?.tools?.map((tool) => tool.name) ?? []

    expect(prompt).toHaveBeenCalledWith('hello', { temperature: 0 })
    expect(body).toEqual({ content: 'ok' })
    expect(toolNames).toEqual(expect.arrayContaining(['remember', 'recall']))
  })

  it('stores encrypted memory and retrieves decrypted records', async () => {
    const { state } = createState('agent-memory')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const record = {
      $type: 'agent.memory.note',
      summary: 'Encrypted note',
      text: 'Keep this secret',
      createdAt: new Date().toISOString(),
    }

    const storeResponse = await agent.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }))

    const { id } = await storeResponse.json()
    const row = db.records.get(id)

    expect(id).toContain('did:cf:agent-memory/agent.memory.note/')
    expect(row?.encrypted_dek).toBeInstanceOf(Uint8Array)
    expect(row?.public).toBe(0)

    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    expect(row?.ciphertext).not.toEqual(plaintext)

    const loadResponse = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(id)}`)
    )
    const loaded = await loadResponse.json()

    expect(loaded).toEqual({ id, record })
  })

  it('lists, updates, and soft-deletes memories via the memory API', async () => {
    const { state } = createState('agent-memory-crud')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const note1 = {
      $type: 'agent.memory.note',
      summary: 'First',
      text: 'v1',
      createdAt: new Date().toISOString(),
    }
    const note2 = {
      $type: 'agent.memory.note',
      summary: 'Second',
      text: 'v2',
      createdAt: new Date().toISOString(),
    }
    const message = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:recipient',
      content: { kind: 'text', text: 'hello' },
      createdAt: new Date().toISOString(),
    }

    const store1 = await agent.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note1),
    }))
    const { id: id1 } = (await store1.json()) as { id: string }

    const store2 = await agent.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note2),
    }))
    const { id: id2 } = (await store2.json()) as { id: string }

    const store3 = await agent.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }))
    const { id: msgId } = (await store3.json()) as { id: string }

    const listAll = await agent.fetch(new Request('https://example/memory'))
    expect(listAll.status).toBe(200)
    const allBody = (await listAll.json()) as { entries: Array<{ id: string }> }
    expect(allBody.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([id1, id2, msgId])
    )

    const listNotes = await agent.fetch(
      new Request('https://example/memory?collection=agent.memory.note&limit=1')
    )
    const notesBody = (await listNotes.json()) as { entries: Array<{ id: string }> }
    expect(notesBody.entries.length).toBe(1)
    expect([id1, id2]).toContain(notesBody.entries[0]?.id)

    const updated = { ...note2, summary: 'Second updated', text: 'v2b' }
    const updateResponse = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(id2)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      })
    )
    expect(updateResponse.status).toBe(200)

    const rowAfterUpdate = db.records.get(id2)
    expect(rowAfterUpdate?.updated_at ?? null).not.toBeNull()

    const loadUpdated = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(id2)}`)
    )
    const loadedUpdated = (await loadUpdated.json()) as { id: string; record: unknown }
    expect(loadedUpdated).toEqual({ id: id2, record: updated })

    const deleteResponse = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(id1)}`, {
        method: 'DELETE',
      })
    )
    expect(deleteResponse.status).toBe(200)
    const rowAfterDelete = db.records.get(id1)
    expect(rowAfterDelete?.deleted_at ?? null).not.toBeNull()

    const loadDeleted = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(id1)}`)
    )
    expect(loadDeleted.status).toBe(404)

    const listAfterDelete = await agent.fetch(
      new Request('https://example/memory?collection=agent.memory.note')
    )
    const afterDeleteBody = (await listAfterDelete.json()) as { entries: Array<{ id: string }> }
    expect(afterDeleteBody.entries.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining([id1])
    )
  })

  it('validates lexicon records posted to the memory API', async () => {
    const { state } = createState('agent-memory-invalid')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const invalidRecord = {
      $type: 'agent.memory.note',
      createdAt: new Date().toISOString(),
    }

    const response = await agent.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidRecord),
    }))

    expect(response.status).toBe(400)

    const body = (await response.json()) as { error?: string; issues?: unknown }
    expect(body.error).toBe('Invalid record')
    expect(Array.isArray(body.issues)).toBe(true)
    expect((body.issues as unknown[]).length).toBeGreaterThan(0)
    expect(db.records.size).toBe(0)
  })

  it('validates lexicon records passed to the remember tool', async () => {
    const { state } = createState('agent-remember-invalid')
    const prompt = vi.fn().mockResolvedValue({ ok: true })
    let initConfig:
      | { initialState?: { tools?: Array<{ name: string; execute?: (params: unknown) => unknown }> } }
      | undefined

    const agentFactory = vi.fn().mockImplementation(async (init) => {
      initConfig = init
      return { prompt }
    })

    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(
      new Request('https://example/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'init tools' }),
      })
    )

    const rememberTool = initConfig?.initialState?.tools?.find((tool) => tool.name === 'remember')
    expect(rememberTool).toBeTruthy()
    expect(typeof rememberTool?.execute).toBe('function')

    const invalidRecord = {
      $type: 'agent.memory.note',
      createdAt: new Date().toISOString(),
    }

    await expect(rememberTool!.execute!({ record: invalidRecord })).rejects.toThrow()
    expect(db.records.size).toBe(0)
  })

  it('stores the parsed lexicon record (defaults applied) from the remember tool', async () => {
    const { state } = createState('agent-remember-defaults')
    const prompt = vi.fn().mockResolvedValue({ ok: true })
    let initConfig:
      | { initialState?: { tools?: Array<{ name: string; execute?: (params: unknown) => unknown }> } }
      | undefined

    const agentFactory = vi.fn().mockImplementation(async (init) => {
      initConfig = init
      return { prompt }
    })

    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(
      new Request('https://example/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'init tools' }),
      })
    )

    const rememberTool = initConfig?.initialState?.tools?.find((tool) => tool.name === 'remember')
    expect(rememberTool).toBeTruthy()
    expect(typeof rememberTool?.execute).toBe('function')

    const messageRecord = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:recipient',
      content: { kind: 'text', text: 'hello' },
      createdAt: new Date().toISOString(),
    }

    const result = (await rememberTool!.execute!({ record: messageRecord })) as { id: string }
    expect(result.id).toContain('did:cf:agent-remember-defaults/agent.comms.message/')

    const loadResponse = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(result.id)}`)
    )
    const loaded = (await loadResponse.json()) as { record: Record<string, unknown> }

    expect(loaded.record.priority).toBe(3)
  })

  it('shares encrypted records between agents via /share and /shared', async () => {
    const aliceState = createState('agent-alice-share').state
    const bobState = createState('agent-bob-share').state
    const intruderState = createState('agent-intruder-share').state

    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const alice = new AgentDO(aliceState as never, env as never)
    const bob = new AgentDO(bobState as never, env as never)
    const intruder = new AgentDO(intruderState as never, env as never)

    const bobIdentityResponse = await bob.fetch(new Request('https://example/identity'))
    expect(bobIdentityResponse.status).toBe(200)
    const bobIdentity = (await bobIdentityResponse.json()) as {
      did: string
      publicKeys: { encryption: string }
    }

    const record = {
      $type: 'agent.memory.note',
      summary: 'Shared via HTTP',
      text: 'hello bob',
      createdAt: new Date().toISOString(),
    }

    const storeResponse = await alice.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }))
    expect(storeResponse.status).toBe(200)
    const { id } = (await storeResponse.json()) as { id: string }

    expect(db.records.has(id)).toBe(true)

    // Not shared yet
    const loadSharedBefore = await bob.fetch(
      new Request(`https://example/shared?id=${encodeURIComponent(id)}`)
    )
    expect(loadSharedBefore.status).toBe(404)

    // Share from Alice -> Bob
    const shareResponse = await alice.fetch(new Request('https://example/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        recipientDid: bobIdentity.did,
        recipientPublicKey: bobIdentity.publicKeys.encryption,
      }),
    }))

    expect(shareResponse.status).toBe(200)

    // Intruder can't fetch
    const intruderResponse = await intruder.fetch(
      new Request(`https://example/shared?id=${encodeURIComponent(id)}`)
    )
    expect(intruderResponse.status).toBe(404)

    // Bob can fetch the shared record
    const loadShared = await bob.fetch(
      new Request(`https://example/shared?id=${encodeURIComponent(id)}`)
    )
    expect(loadShared.status).toBe(200)
    await expect(loadShared.json()).resolves.toEqual({ id, record })

    // And list it
    const listShared = await bob.fetch(new Request('https://example/shared'))
    expect(listShared.status).toBe(200)
    const listBody = (await listShared.json()) as { entries: Array<{ id: string; record: unknown }> }
    expect(listBody.entries).toEqual([{ id, record }])
  })

  it('receives comms messages via /inbox and stores them encrypted', async () => {
    const { state } = createState('agent-inbox')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const message = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:agent-inbox',
      content: { kind: 'text', text: 'hello inbox' },
      createdAt: new Date().toISOString(),
    }

    const postResponse = await agent.fetch(new Request('https://example/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }))
    expect(postResponse.status).toBe(200)

    const { id } = (await postResponse.json()) as { id: string }
    expect(id).toContain('did:cf:agent-inbox/agent.comms.message/')

    const storedRecord = { ...message, priority: 3 }
    const row = db.records.get(id)
    expect(row?.encrypted_dek).toBeInstanceOf(Uint8Array)
    expect(row?.public).toBe(0)

    const plaintext = new TextEncoder().encode(JSON.stringify(storedRecord))
    expect(row?.ciphertext).not.toEqual(plaintext)

    const listResponse = await agent.fetch(new Request('https://example/inbox'))
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toEqual({
      entries: [{ id, record: storedRecord }],
    })
  })

  it('rejects /inbox messages that target a different recipient DID', async () => {
    const { state } = createState('agent-inbox-mismatch')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const message = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:someone-else',
      content: { kind: 'text', text: 'wrong recipient' },
      createdAt: new Date().toISOString(),
    }

    const response = await agent.fetch(new Request('https://example/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Recipient mismatch',
    })
    expect(db.records.size).toBe(0)
  })

  it('validates lexicon records posted to /inbox', async () => {
    const { state } = createState('agent-inbox-invalid')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const invalidRecord = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:agent-inbox-invalid',
      createdAt: new Date().toISOString(),
    }

    const response = await agent.fetch(new Request('https://example/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidRecord),
    }))

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string; issues?: unknown }
    expect(body.error).toBe('Invalid record')
    expect(Array.isArray(body.issues)).toBe(true)
    expect((body.issues as unknown[]).length).toBeGreaterThan(0)
    expect(db.records.size).toBe(0)
  })
})
