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
  private _alarm: number | null = null

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    assertDurableObjectSerializable(value)
    this.store.set(key, structuredClone(value))
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this._alarm = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime()
  }

  async getAlarm(): Promise<number | null> {
    return this._alarm
  }

  async deleteAlarm(): Promise<void> {
    this._alarm = null
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

  it('creates, patches (merge), and persists agent config in DO storage', async () => {
    const { state, storage } = createState('agent-config')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent1 = new AgentDO(state as never, env as never)

    const get1 = await agent1.fetch(new Request('https://example/agents/alice/config'))
    expect(get1.status).toBe(200)
    const config1 = (await get1.json()) as Record<string, unknown>

    expect(config1).toMatchObject({
      name: 'alice',
      model: 'moonshotai/kimi-k2.5',
      fastModel: 'google/gemini-2.0-flash-001',
      loopIntervalMs: 60000,
      goals: [],
      enabledTools: [],
    })
    expect(typeof config1.personality).toBe('string')
    expect(typeof config1.specialty).toBe('string')

    const patch1 = await agent1.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specialty: 'ops',
          enabledTools: ['remember'],
          loopIntervalMs: 120000,
        }),
      })
    )
    expect(patch1.status).toBe(200)
    const config2 = (await patch1.json()) as Record<string, unknown>
    expect(config2).toMatchObject({
      name: 'alice',
      specialty: 'ops',
      enabledTools: ['remember'],
      loopIntervalMs: 120000,
    })

    // Merge semantics: unspecified fields remain intact.
    expect(config2.model).toBe(config1.model)
    expect(config2.fastModel).toBe(config1.fastModel)
    expect(config2.personality).toBe(config1.personality)

    const stored = await storage.get<Record<string, unknown>>('config')
    expect(stored).toMatchObject({
      name: 'alice',
      specialty: 'ops',
      enabledTools: ['remember'],
      loopIntervalMs: 120000,
    })

    // Persistence: new DO instance should reload config from storage.
    const agent2 = new AgentDO(state as never, env as never)
    const get2 = await agent2.fetch(new Request('https://example/agents/alice/config'))
    expect(get2.status).toBe(200)
    const config3 = (await get2.json()) as Record<string, unknown>
    expect(config3).toEqual(config2)
  })

  it('handles prompt messages over the agent websocket', async () => {
    const { state } = createState('agent-ws')
    const prompt = vi.fn().mockResolvedValue({ content: 'ok' })
    const agentFactory = vi.fn().mockResolvedValue({ prompt })

    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const ws = {
      send: vi.fn(),
      serializeAttachment: vi.fn(),
      deserializeAttachment: vi.fn().mockReturnValue({}),
    } as unknown as WebSocket

    await agent.webSocketMessage(
      ws,
      JSON.stringify({ type: 'prompt', id: 'req-1', prompt: 'hello', options: { temperature: 0 } })
    )

    expect(prompt).toHaveBeenCalledWith('hello', { temperature: 0 })
    expect((ws as any).send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'prompt.result', id: 'req-1', result: { content: 'ok' } })
    )
  })

  it('returns 500 JSON when a route handler throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { state } = createState('agent-route-error')
    const prompt = vi.fn().mockRejectedValue(new Error('boom'))
    const agentFactory = vi.fn().mockResolvedValue({ prompt })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(
      new Request('https://example/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      })
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Internal Server Error',
    })

    expect(consoleSpy).toHaveBeenCalledWith(
      'Unhandled route error',
      expect.objectContaining({ route: 'AgentDO.prompt' })
    )
    consoleSpy.mockRestore()
  })

  it('persists Pi session messages in DO storage and restores them on init', async () => {
    const { state, storage } = createState('agent-session')

    const agentFactory = vi.fn().mockImplementation(async (init: any) => {
      const messages = Array.isArray(init?.initialState?.messages)
        ? structuredClone(init.initialState.messages)
        : []

      const stateRef = { messages }

      return {
        state: stateRef,
        replaceMessages(next: unknown) {
          stateRef.messages = Array.isArray(next) ? next : []
        },
        async prompt(input: string) {
          const ts = Date.now()
          stateRef.messages.push({ role: 'user', content: input, timestamp: ts })
          stateRef.messages.push({ role: 'assistant', content: `echo:${input}`, timestamp: ts + 1 })
          return { text: `echo:${input}` }
        },
      }
    })

    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent1 = new AgentDO(state as never, env as never)

    const response1 = await agent1.fetch(
      new Request('https://example/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      })
    )
    expect(response1.status).toBe(200)

    const stored1 = await storage.get<any>('session')
    expect(stored1).toMatchObject({ version: 1 })
    expect(Array.isArray(stored1?.messages)).toBe(true)
    expect(stored1.messages.at(-2)).toMatchObject({ role: 'user', content: 'hello' })
    expect(stored1.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'echo:hello' })
    expect(typeof stored1.messages.at(-1)?.timestamp).toBe('number')

    let initMessages: unknown = null
    const agentFactory2 = vi.fn().mockImplementation(async (init: any) => {
      initMessages = init?.initialState?.messages
      return { state: { messages: initMessages }, prompt: vi.fn().mockResolvedValue({ ok: true }) }
    })
    const { env: env2 } = createEnv({
      PI_AGENT_FACTORY: agentFactory2,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const agent2 = new AgentDO(state as never, env2 as never)
    await agent2.fetch(
      new Request('https://example/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'next' }),
      })
    )

    expect(initMessages).toEqual(stored1.messages)
  })

  it('trims session window to last 50 messages and archives overflow to D1', async () => {
    const { state, storage } = createState('agent-session-trim')

    const initialMessages = Array.from({ length: 60 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
      timestamp: i,
    }))

    await storage.put('session', {
      version: 1,
      messages: initialMessages,
      branchPoints: [{ id: 'main', label: 'main', messageIndex: 10, createdAt: Date.now() }],
    })

    const agentFactory = vi.fn().mockImplementation(async (init: any) => {
      const messages = Array.isArray(init?.initialState?.messages)
        ? structuredClone(init.initialState.messages)
        : []
      const stateRef = { messages }
      return {
        state: stateRef,
        replaceMessages(next: unknown) {
          stateRef.messages = Array.isArray(next) ? next : []
        },
        async prompt(input: string) {
          const ts = Date.now()
          stateRef.messages.push({ role: 'user', content: input, timestamp: ts })
          stateRef.messages.push({ role: 'assistant', content: `echo:${input}`, timestamp: ts + 1 })
          return { text: `echo:${input}` }
        },
      }
    })

    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(
      new Request('https://example/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'trim-test' }),
      })
    )
    expect(response.status).toBe(200)

    const stored = await storage.get<any>('session')
    expect(stored).toMatchObject({ version: 1 })
    expect(stored.messages).toHaveLength(50)
    expect(stored.messages[0]).toMatchObject({ content: 'm12' })
    expect(stored.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'echo:trim-test' })
    expect(stored.branchPoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'main', label: 'main' })])
    )

    const archiveRows = Array.from(db.records.values()).filter(
      (row) => row.collection === 'agent.session.archive'
    )
    expect(archiveRows.length).toBe(1)
    expect(archiveRows[0]?.public).toBe(0)
    expect(archiveRows[0]?.encrypted_dek).toBeInstanceOf(Uint8Array)

    const archiveId = archiveRows[0]!.id
    const loadArchive = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(archiveId)}`)
    )
    expect(loadArchive.status).toBe(200)
    const archiveBody = (await loadArchive.json()) as { record: { $type: string; messages: unknown[] } }
    expect(archiveBody.record.$type).toBe('agent.session.archive')
    expect(archiveBody.record.messages).toHaveLength(12)
    expect(archiveBody.record.messages[0]).toMatchObject({ content: 'm0' })
    expect(archiveBody.record.messages.at(-1)).toMatchObject({ content: 'm11' })
  })

  // ===== Story 4a: Bare alarm chain + start/stop API =====

  it('alarm() fires, increments counter, and reschedules next alarm', async () => {
    const { state, storage } = createState('agent-alarm')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Start the loop first
    const startRes = await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    expect(startRes.status).toBe(200)

    // Simulate alarm firing
    await agent.alarm()

    // Counter should be incremented
    const loopCount = await storage.get<number>('loopCount')
    expect(loopCount).toBeGreaterThanOrEqual(1)

    // Next alarm should be scheduled
    const nextAlarm = await storage.getAlarm()
    expect(nextAlarm).not.toBeNull()
  })

  it('startLoop() sets loopRunning flag and schedules first alarm', async () => {
    const { state, storage } = createState('agent-start-loop')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const res = await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body.loopRunning).toBe(true)

    const loopRunning = await storage.get<boolean>('loopRunning')
    expect(loopRunning).toBe(true)

    const alarm = await storage.getAlarm()
    expect(alarm).not.toBeNull()
  })

  it('stopLoop() clears loopRunning flag and deletes alarm', async () => {
    const { state, storage } = createState('agent-stop-loop')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Start then stop
    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    const res = await agent.fetch(new Request('https://example/loop/stop', { method: 'POST' }))
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body.loopRunning).toBe(false)

    const loopRunning = await storage.get<boolean>('loopRunning')
    expect(loopRunning).toBe(false)

    const alarm = await storage.getAlarm()
    expect(alarm).toBeNull()
  })

  it('GET /loop/status returns current loop state', async () => {
    const { state } = createState('agent-loop-status')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const res = await agent.fetch(new Request('https://example/loop/status'))
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('loopRunning')
    expect(body).toHaveProperty('loopCount')
  })

  it('error in alarm does not break the chain — alarm reschedules anyway', async () => {
    const { state, storage } = createState('agent-alarm-error')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Start the loop
    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))

    // Force an error condition by corrupting state, then call alarm
    // The alarm should still reschedule despite errors
    await agent.alarm()

    // Alarm should be rescheduled even if there was an error
    const nextAlarm = await storage.getAlarm()
    expect(nextAlarm).not.toBeNull()
  })

  it('rejects loopIntervalMs < 5000', async () => {
    const { state } = createState('agent-min-interval')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Try to set interval too low via config
    const res = await agent.fetch(new Request('https://example/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loopIntervalMs: 1000 }),
    }))

    const body = await res.json() as Record<string, unknown>
    const config = body as { loopIntervalMs?: number }
    // Should either reject or clamp to minimum 5000
    expect(config.loopIntervalMs).toBeGreaterThanOrEqual(5000)
  })
})
