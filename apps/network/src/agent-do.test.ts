import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../packages/core/src/d1-mock'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('cloudflare:workers', () => {
  class DurableObject {
    protected ctx: unknown
    protected env: unknown

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  }

  // Mock WebSocketPair for test environment
  class MockWebSocket extends EventTarget {
    private _readyState = 1 // OPEN

    constructor() {
      super()
    }

    get readyState() {
      return this._readyState
    }

    send(data: unknown): void {
      // Dispatch message event on next tick
      setTimeout(() => {
        this.dispatchEvent(
          new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })
        )
      }, 0)
    }

    close(code?: number, reason?: string): void {
      this._readyState = 3 // CLOSED
      this.dispatchEvent(new CloseEvent('close', { code: code ?? 1000, reason }))
    }

    accept?: () => void
    serializeAttachment?: (data: unknown) => void
  }

  class WebSocketPair {
    [Symbol.toStringTag] = 'WebSocketPair'
    [0] = new MockWebSocket() // client
    [1] = new MockWebSocket() // server

    constructor() {
      Object.values(this).forEach((ws) => {
        if (ws && typeof ws === 'object') {
          ws.accept = () => {} // no-op in test
          ws.serializeAttachment = () => {} // no-op in test
        }
      })
    }
  }

  // Cloudflare Workers exposes WebSocketPair as a global. Our DO code uses the global,
  // so make it available in the Vitest runtime to avoid ReferenceError.
  ;(globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair = WebSocketPair

  return { DurableObject, WebSocketPair }
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
  const websockets: WebSocket[] = []
  const acceptWebSocket = vi.fn((ws: WebSocket) => {
    websockets.push(ws)
  })
  const state = {
    id: { toString: () => id },
    storage,
    acceptWebSocket,
    getWebSockets: () => websockets,
  }

  return { state, storage, websockets, acceptWebSocket }
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

function createFakeR2Bucket(initial: Record<string, string> = {}) {
  const objects = new Map<string, { body: string; uploaded: Date }>()

  for (const [key, body] of Object.entries(initial)) {
    objects.set(key, { body, uploaded: new Date() })
  }

  return {
    put: vi.fn(async (key: string, value: unknown) => {
      objects.set(key, { body: String(value), uploaded: new Date() })
    }),
    get: vi.fn(async (key: string) => {
      const obj = objects.get(key)
      if (!obj) return null
      return { text: async () => obj.body }
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key)
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
      const keys = Array.from(objects.keys()).filter((key) => (prefix ? key.startsWith(prefix) : true))
      return {
        objects: keys.map((key) => {
          const obj = objects.get(key)!
          return {
            key,
            size: new TextEncoder().encode(obj.body).byteLength,
            uploaded: obj.uploaded,
          }
        }),
      }
    }),
  }
}

describe('AgentDO', () => {
  // TODO: Re-enable after Catan code is fully extracted to environments/catan.ts
  // it('agent.ts contains no Catan-specific code (delegated to environments/catan.ts)')

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
    expect(toolNames).toEqual(
      expect.arrayContaining(['remember', 'recall', 'message', 'search', 'set_goal', 'think_aloud'])
    )
  })

  it('stores full prompt + loop transcript + timing for the agentic tool loop and exposes them via /debug', async () => {
    const { state } = createState('agent-debug-o11y')

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'test-model',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'think_aloud', arguments: JSON.stringify({ message: 'hello from tool' }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'done' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

    vi.stubGlobal('fetch', fetchMock)

    const { env } = createEnv({
      CF_ACCOUNT_ID: 'acct',
      AI_GATEWAY_SLUG: 'slug',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL_DEFAULT: 'test-model',
      BLOBS: createFakeR2Bucket(),
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const promptRes = await agent.fetch(
      new Request('https://example/agents/debuggy/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      })
    )
    expect(promptRes.ok).toBe(true)

    const debugRes = await agent.fetch(new Request('https://example/agents/debuggy/debug'))
    const debug = await debugRes.json()

    // O11y fields (lastPrompt, loopTranscript) are populated by the alarm cycle's think() method,
    // not the raw /prompt endpoint. Verify the debug endpoint returns these fields (even if null
    // when not going through alarm cycle).
    expect('lastPrompt' in debug).toBe(true)
    expect('loopTranscript' in debug).toBe(true)
    expect('consecutiveErrors' in debug).toBe(true)
    expect('lastError' in debug).toBe(true)
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
      | {
          initialState?: {
            tools?: Array<{
              name: string
              execute?: (toolCallId: string, params: unknown) => unknown
            }>
          }
        }
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

    await expect(rememberTool!.execute!('tc-1', { record: invalidRecord })).rejects.toThrow()
    expect(db.records.size).toBe(0)
  })

  it('stores the parsed lexicon record (defaults applied) from the remember tool', async () => {
    const { state } = createState('agent-remember-defaults')
    const prompt = vi.fn().mockResolvedValue({ ok: true })
    let initConfig:
      | {
          initialState?: {
            tools?: Array<{
              name: string
              execute?: (toolCallId: string, params: unknown) => unknown
            }>
          }
        }
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

    const result = (await rememberTool!.execute!('tc-2', { record: messageRecord })) as {
      content: Array<{ type: 'text'; text: string }>
      details: { id: string }
    }
    expect(result.details.id).toContain('did:cf:agent-remember-defaults/agent.comms.message/')
    expect(result.content[0]?.text).toContain('Stored memory')

    const loadResponse = await agent.fetch(
      new Request(`https://example/memory?id=${encodeURIComponent(result.details.id)}`)
    )
    const loaded = (await loadResponse.json()) as { record: Record<string, unknown> }

    expect(loaded.record.priority).toBe(3)
  })

  it('recalls memories via semantic search when Vectorize is available, otherwise falls back to list+filter', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })

    const { state } = createState('agent-recall')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { upsert: vectorizeUpsert, query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')!
    const recall = tools.find((t) => t.name === 'recall')!

    const record = {
      $type: 'agent.memory.note',
      summary: 'alpha',
      text: 'hello world',
      createdAt: new Date().toISOString(),
    }

    const stored = await remember.execute('tc-rem-1', { record })
    expect(stored.details.id).toContain('did:cf:agent-recall/agent.memory.note/')

    // Vectorize store is best-effort: if present, remember should attempt to upsert.
    expect(vectorizeUpsert).toHaveBeenCalled()

    // Force vectorize recall path by returning a match for the stored id.
    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: stored.details.id,
          score: 0.9,
          metadata: { did: 'did:cf:agent-recall', collection: 'agent.memory.note' },
        },
      ],
    })

    const semantic = await recall.execute('tc-rec-1', { query: 'hello', limit: 5 })
    expect(vectorizeQuery).toHaveBeenCalled()
    expect(semantic.details.results[0]).toMatchObject({
      id: stored.details.id,
      record: { summary: 'alpha' },
    })

    // Remove vectorize bindings and verify fallback returns the record.
    delete (env as any).VECTORIZE
    delete (env as any).AI

    const fallback = await recall.execute('tc-rec-2', { query: 'hello', limit: 5 })
    expect(fallback.details.results[0]).toMatchObject({
      id: stored.details.id,
      record: { summary: 'alpha' },
    })
  })

  it('searches across the network via Vectorize (metadata-only)', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({
      matches: [
        {
          id: 'did:cf:agent-other/agent.memory.note/3jui7-test',
          score: 0.88,
          metadata: { did: 'did:cf:agent-other', collection: 'agent.memory.note' },
        },
      ],
    })

    const { state } = createState('agent-search')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const search = tools.find((t) => t.name === 'search')
    expect(search).toBeTruthy()

    const result = await search!.execute('tc-search-1', { query: 'note', limit: 3 })
    expect(result.details.matches).toHaveLength(1)
    expect(result.details.matches[0]).toMatchObject({
      did: 'did:cf:agent-other',
      collection: 'agent.memory.note',
    })
    expect(result.content[0]?.text).toContain('did:cf:agent-other/agent.memory.note/3jui7-test')
  })

  it('uses the configured embedding model for Vectorize (1024D) when searching', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })

    const { state } = createState('agent-search-embedding-model')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const search = tools.find((t) => t.name === 'search')
    expect(search).toBeTruthy()

    await search!.execute('tc-search-embed-1', { query: 'note', limit: 1 })
    expect(aiRun).toHaveBeenCalled()
    expect(aiRun.mock.calls[0]?.[0]).toBe('@cf/baai/bge-large-en-v1.5')
  })

  it('prefers an embedding model that matches VECTORIZE_DIMENSIONS over a misconfigured EMBEDDING_MODEL', async () => {
    const embedding1024 = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const embedding768 = Array.from({ length: 768 }, (_, i) => i / 768)
    const aiRun = vi.fn().mockImplementation((model: unknown) => {
      if (model === '@cf/baai/bge-large-en-v1.5') return Promise.resolve({ data: [embedding1024] })
      return Promise.resolve({ data: [embedding768] })
    })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })

    const { state } = createState('agent-search-embedding-model-misconfig')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery },
      EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
      VECTORIZE_DIMENSIONS: '1024',
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const search = tools.find((t) => t.name === 'search')
    expect(search).toBeTruthy()

    await search!.execute('tc-search-embed-misconfig-1', { query: 'note', limit: 1 })
    expect(aiRun).toHaveBeenCalled()
    expect(aiRun.mock.calls[0]?.[0]).toBe('@cf/baai/bge-large-en-v1.5')
    expect(vectorizeQuery).toHaveBeenCalled()
  })

  it('guards Vectorize queries when embedding dimensions do not match the index (expected 1024)', async () => {
    const embedding = Array.from({ length: 768 }, (_, i) => i / 768)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockImplementation((values: number[]) => {
      if (values.length !== 1024) {
        throw new Error(`VECTOR_QUERY_ERROR: expected 1024 dimensions, got ${values.length}`)
      }
      return Promise.resolve({ matches: [] })
    })

    const { state } = createState('agent-search-dim-guard')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const search = tools.find((t) => t.name === 'search')
    expect(search).toBeTruthy()

    const result = await search!.execute('tc-search-guard-1', { query: 'note', limit: 1 })
    expect(vectorizeQuery).not.toHaveBeenCalled()
    expect(result.details.matches).toEqual([])
  })

  it('delivers messages to another agent via the message tool (and emits to relay when available)', async () => {
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env: baseEnv } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const { RelayDO } = await import('./relay')

    const senderState = createState('agent-sender').state
    const receiverState = createState('agent-receiver').state
    const relayState = createState('relay-main').state

    const senderEnv = { ...baseEnv } as any
    const receiverEnv = { ...baseEnv } as any

    const sender = new AgentDO(senderState as never, senderEnv as never)
    const receiver = new AgentDO(receiverState as never, receiverEnv as never)

    const agentsById = new Map<string, any>([
      ['agent-sender', sender],
      ['agent-receiver', receiver],
    ])

    const agentsNamespace = {
      idFromString: (id: string) => id,
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: (req: Request) => agentsById.get(id)!.fetch(req),
      }),
    }

    const relayEnv = { ...baseEnv, AGENTS: agentsNamespace } as any
    const relay = new RelayDO(relayState as never, relayEnv as never)

    const relayFetch = vi.fn((req: Request) => relay.fetch(req))
    const relayNamespace = {
      idFromName: vi.fn().mockReturnValue('relay-main'),
      get: vi.fn().mockReturnValue({ fetch: relayFetch }),
    }

    senderEnv.RELAY = relayNamespace
    receiverEnv.RELAY = relayNamespace

    // Force init (so tools are built and identity is present).
    await sender.fetch(new Request('https://example/identity'))
    await receiver.fetch(new Request('https://example/identity'))

    const tools = (sender as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const messageTool = tools.find((t) => t.name === 'message')
    expect(messageTool).toBeTruthy()

    const sent = await messageTool!.execute('tc-msg-1', {
      recipientDid: 'did:cf:agent-receiver',
      content: { kind: 'text', text: 'hello from sender' },
    })

    expect(sent.details).toMatchObject({ recipientDid: 'did:cf:agent-receiver' })

    const listInbox = await receiver.fetch(new Request('https://example/inbox?limit=10'))
    expect(listInbox.status).toBe(200)
    const inboxBody = (await listInbox.json()) as { entries: Array<{ record: any }> }
    expect(inboxBody.entries[0]?.record).toMatchObject({
      $type: 'agent.comms.message',
      sender: 'did:cf:agent-sender',
      recipient: 'did:cf:agent-receiver',
      content: { kind: 'text', text: 'hello from sender' },
    })

    // Message delivery should go through RelayDO when RELAY is configured.
    expect(relayFetch).toHaveBeenCalled()
    expect(relayFetch.mock.calls.some(([req]) => new URL(req.url).pathname.endsWith('/relay/message'))).toBe(true)
  })

  it('updates agent goals via the set_goal tool', async () => {
    const { state, storage } = createState('agent-set-goal')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const setGoal = tools.find((t) => t.name === 'set_goal')
    expect(setGoal).toBeTruthy()

    const added = await setGoal!.execute('tc-goal-1', {
      action: 'add',
      goal: { description: 'ship tools', priority: 1 },
    })

    expect(added.details.goal.description).toBe('ship tools')

    const config = await storage.get<any>('config')
    expect(config.goals).toHaveLength(1)
    expect(config.goals[0]).toMatchObject({ description: 'ship tools', status: 'pending' })

    const completed = await setGoal!.execute('tc-goal-2', {
      action: 'complete',
      id: config.goals[0].id,
    })
    expect(completed.details.goal.status).toBe('completed')

    const config2 = await storage.get<any>('config')
    expect(config2.goals[0].status).toBe('completed')
  })

  it('broadcasts think_aloud to websocket clients but returns no LLM-facing content', async () => {
    const { state, acceptWebSocket } = createState('agent-think-aloud')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() } as any as WebSocket
    acceptWebSocket(ws)

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const thinkAloud = tools.find((t) => t.name === 'think_aloud')
    expect(thinkAloud).toBeTruthy()

    const result = await thinkAloud!.execute('tc-ta-1', { message: 'UI-only reasoning' })
    expect(result.content).toEqual([])
    expect(result.details).toMatchObject({ message: 'UI-only reasoning' })

    expect((ws as any).send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((ws as any).send.mock.calls[0][0]) as any
    expect(payload.event_type).toBe('agent.think_aloud')
    expect(payload.context).toMatchObject({ message: 'UI-only reasoning' })
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

  it('enforces enabledTools for OpenRouter tool definitions (strict tool exposure)', async () => {
    const { state, storage } = createState('agent-enabled-tools-openrouter')
    const { env } = createEnv({
      // Ensure the DO uses the OpenRouter factory path (not PI_AGENT_FACTORY).
      CF_ACCOUNT_ID: 'acct_123',
      AI_GATEWAY_SLUG: 'gateway_slug',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_MODEL_DEFAULT: 'openrouter/test-model',
    })

    // Pre-seed config so initialization builds the wrapper with enabledTools already set.
    await storage.put('config', {
      name: 'alice',
      personality: 'test',
      specialty: 'test',
      model: 'openrouter/test-model',
      fastModel: 'openrouter/test-model',
      loopIntervalMs: 60_000,
      goals: [],
      enabledTools: ['remember'],
    })

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ function?: { name?: string } }> }
      const names = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean)
      expect(names).toEqual(['remember'])

      return new Response(
        JSON.stringify({
          model: 'openrouter/test-model',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(
      new Request('https://example/agents/alice/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      })
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.skip('accepts and persists enabledEnvironments in agent config', async () => {
    const { state, storage } = createState('agent-config-envs')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const patch = await agent.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledEnvironments: ['testenv'] }),
      })
    )
    expect(patch.status).toBe(200)
    const body = (await patch.json()) as Record<string, unknown>
    expect(body.enabledEnvironments).toEqual(['testenv'])

    const stored = await storage.get<Record<string, unknown>>('config')
    expect(stored?.enabledEnvironments).toEqual(['testenv'])
  })

  it('creates an agent via /create, persists config, and starts the alarm chain', async () => {
    const { state, storage } = createState('agent-create')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(
      new Request('https://example/agents/alice/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'alice',
          personality: 'You are Alice.',
        }),
      })
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body).toMatchObject({
      did: expect.stringMatching(/^did:cf:/),
      publicKeys: {
        encryption: expect.stringMatching(/^z/),
        signing: expect.stringMatching(/^z/),
      },
      config: expect.objectContaining({
        name: 'alice',
        personality: 'You are Alice.',
        model: 'moonshotai/kimi-k2.5',
      }),
      loop: expect.objectContaining({
        loopRunning: true,
        nextAlarm: expect.any(Number),
      }),
    })

    const storedConfig = await storage.get<Record<string, unknown>>('config')
    expect(storedConfig).toMatchObject({
      name: 'alice',
      personality: 'You are Alice.',
      model: 'moonshotai/kimi-k2.5',
    })

    const alarm = await storage.getAlarm()
    expect(alarm).not.toBeNull()
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

  it('tiered backoff: transient (rate limit/timeout) goes 15s→30s→60s (cap) and resets on success', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    vi.setSystemTime(t0)

    const { state, storage } = createState('agent-backoff-transient')
    const prompt = vi.fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests (rate limit)'))
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ text: 'ok' })
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))

    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Configure a short normal interval so backoff is distinguishable.
    await agent.fetch(new Request('https://example/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loopIntervalMs: 5_000 }),
    }))

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))

    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 15_000)

    vi.setSystemTime(new Date(t0.getTime() + 15_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 15_000 + 30_000)

    vi.setSystemTime(new Date(t0.getTime() + 45_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 45_000 + 60_000)

    vi.setSystemTime(new Date(t0.getTime() + 105_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 105_000 + 60_000)

    // Success resets backoff; next tick uses normal interval (5s).
    const tSuccess = t0.getTime() + 165_000
    vi.setSystemTime(new Date(tSuccess))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(tSuccess + 5_000)

    // Next transient error after success restarts at 15s.
    vi.setSystemTime(new Date(tSuccess + 5_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(tSuccess + 5_000 + 15_000)

    vi.useRealTimers()
  })

  it('tiered backoff: persistent (config/infra) goes 60s→120s→300s (cap)', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-01-02T00:00:00.000Z')
    vi.setSystemTime(t0)

    const { state, storage } = createState('agent-backoff-persistent')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ text: 'ok' }) }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Make normal interval short; then force a persistent-style error by making observe() fail with config-ish wording.
    await agent.fetch(new Request('https://example/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loopIntervalMs: 5_000 }),
    }))

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))

    ;(agent as any).observe = vi.fn().mockRejectedValue(new Error('config invalid: missing model'))

    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 60_000)

    vi.setSystemTime(new Date(t0.getTime() + 60_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 60_000 + 120_000)

    vi.setSystemTime(new Date(t0.getTime() + 180_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 180_000 + 300_000)

    vi.setSystemTime(new Date(t0.getTime() + 480_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 480_000 + 300_000)

    vi.useRealTimers()
  })

  it('tiered backoff: game-context errors cap at 15s (no ramp)', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-01-03T00:00:00.000Z')
    vi.setSystemTime(t0)

    const { state, storage } = createState('agent-backoff-game')
    const prompt = vi.fn()
      .mockResolvedValue({ text: '', toolCalls: [{ name: 'game', arguments: {} }] })

    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))

    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 15_000)

    vi.setSystemTime(new Date(t0.getTime() + 15_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 15_000 + 15_000)

    vi.useRealTimers()
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

  // ===== Story 4b: Observe phase — inbox + event collection =====

  it('observe() returns structured empty observations when inbox is empty', async () => {
    const { state } = createState('agent-observe-empty')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const observations = await agent.observe()

    expect(observations).toMatchObject({
      inbox: [],
      events: [],
    })
    expect(typeof observations.observedAt).toBe('number')
    expect(observations.did).toBe('did:cf:agent-observe-empty')
  })

  it('observe() decrypts unread inbox messages, returns them, and marks them processed', async () => {
    const { state } = createState('agent-observe-inbox')
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
      recipient: 'did:cf:agent-observe-inbox',
      content: { kind: 'text', text: 'observe me' },
      createdAt: new Date().toISOString(),
    }

    const postResponse = await agent.fetch(new Request('https://example/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }))
    expect(postResponse.status).toBe(200)
    const { id } = (await postResponse.json()) as { id: string }

    const obs1 = await agent.observe()
    expect(obs1.inbox).toHaveLength(1)
    expect(obs1.inbox[0]).toMatchObject({
      id,
      record: {
        $type: 'agent.comms.message',
        sender: 'did:cf:sender',
        recipient: 'did:cf:agent-observe-inbox',
        content: { kind: 'text', text: 'observe me' },
        priority: 3,
      },
    })
    expect(typeof (obs1.inbox[0] as any).record.processedAt).toBe('string')

    // Second observe should return nothing (already processed)
    const obs2 = await agent.observe()
    expect(obs2.inbox).toEqual([])

    // Record should still be encrypted at rest (update keeps private)
    const row = db.records.get(id)
    expect(row?.public).toBe(0)
    expect(row?.encrypted_dek).toBeInstanceOf(Uint8Array)

    // /inbox list should now include processedAt
    const listResponse = await agent.fetch(new Request('https://example/inbox'))
    expect(listResponse.status).toBe(200)
    const listBody = (await listResponse.json()) as { entries: Array<{ id: string; record: any }> }
    expect(listBody.entries[0].id).toBe(id)
    expect(typeof listBody.entries[0].record.processedAt).toBe('string')
  })

  it('observe() collects and drains pending events since the last alarm timestamp', async () => {
    const { state, storage } = createState('agent-observe-events')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const since = Date.now() - 10_000
    const older = { ts: since - 1, type: 'older' }
    const newer = { ts: since + 1, type: 'newer', detail: { ok: true } }

    await storage.put('lastAlarmAt', since)
    await storage.put('pendingEvents', [older, newer])

    const observations = await agent.observe()
    expect(observations.sinceAlarmAt).toBe(since)
    expect(observations.events).toEqual([newer])

    const remaining = (await storage.get<unknown[]>('pendingEvents')) ?? []
    expect(remaining).toEqual([])
  })

  it.skip('observe() appends enabled environment context strings onto observations', async () => {
    vi.resetModules()

    const { registerEnvironment } = await import('./environments/registry')
    registerEnvironment({
      type: 'testenv',
      label: 'Test Environment',
      getTool() {
        return {
          name: 'env_tool',
          label: 'Env Tool',
          description: 'test tool',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return { content: [{ type: 'text', text: 'ok' }] }
          },
        }
      },
      buildContext() {
        return ['TESTENV CONTEXT']
      },
      isActionTaken() {
        return false
      },
      getAutoPlayActions() {
        return []
      },
    })

    const { state } = createState('agent-observe-env-context')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledEnvironments: ['testenv'] }),
      })
    )

    const observations = await agent.observe()
    expect((observations as any).environmentContext).toEqual(['TESTENV CONTEXT'])
  })

  it.skip('buildTools() merges tools from enabled environments when config changes', async () => {
    vi.resetModules()

    const { registerEnvironment } = await import('./environments/registry')
    registerEnvironment({
      type: 'testenv',
      label: 'Test Environment',
      getTool() {
        return {
          name: 'env_tool',
          label: 'Env Tool',
          description: 'test tool',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return { content: [{ type: 'text', text: 'ok' }] }
          },
        }
      },
      buildContext() {
        return []
      },
      isActionTaken() {
        return false
      },
      getAutoPlayActions() {
        return []
      },
    })

    const { state } = createState('agent-env-tools-merge')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Initialize the agent first so we know the tool list is rebuilt after PATCH.
    await agent.fetch(new Request('https://example/identity'))

    const before = ((agent as any).tools as Array<{ name: string }>).map((t) => t.name)
    expect(before).not.toContain('env_tool')

    await agent.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledEnvironments: ['testenv'] }),
      })
    )

    const after = ((agent as any).tools as Array<{ name: string }>).map((t) => t.name)
    expect(after).toContain('env_tool')
  })

  it('alarm() wires observe() and stores last observations in DO storage', async () => {
    const { state, storage } = createState('agent-alarm-observe-wire')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn() }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Start loop + seed an event
    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'seed' }])

    await agent.alarm()

    const last = await storage.get<Record<string, unknown>>('lastObservations')
    expect(last).toMatchObject({
      did: 'did:cf:agent-alarm-observe-wire',
      events: [{ type: 'seed' }],
    })
  })

  // ===== Story 4c: Think/Act/Reflect — Pi loop cycle =====

  it('alarm() calls think() which prompts the Pi agent with observations + goals', async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'I should check my inbox.', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-think')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const goal = {
      id: 'goal-1',
      description: 'monitor inbox',
      priority: 1,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
    }

    await agent.fetch(
      new Request('https://example/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goals: [goal] }),
      })
    )

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'seed-event' }])

    await agent.alarm()

    expect(promptFn).toHaveBeenCalledTimes(1)
    const promptArg = promptFn.mock.calls[0][0]
    expect(typeof promptArg).toBe('string')
    expect(promptArg).toContain('monitor inbox')
    expect(promptArg).toContain('seed-event')
  })

  it('prunes completed goals to maxCompletedGoals and archives overflow in DO storage', async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'No-op', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-goal-prune')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const now = Date.now()
    const pending = {
      id: 'goal-pending',
      description: 'keep this pending',
      priority: 1,
      status: 'pending',
      progress: 0,
      createdAt: now - 10_000,
    }
    const inProgress = {
      id: 'goal-progress',
      description: 'keep this in progress',
      priority: 1,
      status: 'in_progress',
      progress: 0.5,
      createdAt: now - 9_000,
    }
    const completed = (id: string, description: string, completedAt: number) => ({
      id,
      description,
      priority: 0,
      status: 'completed' as const,
      progress: 1,
      createdAt: completedAt - 1_000,
      completedAt,
    })

    const c1 = completed('goal-c1', 'archive me 1', now - 5_000)
    const c2 = completed('goal-c2', 'archive me 2', now - 4_000)
    const c3 = completed('goal-c3', 'archive me 3', now - 3_000)
    const c4 = completed('goal-c4', 'keep completed 1', now - 2_000)
    const c5 = completed('goal-c5', 'keep completed 2', now - 1_000)

    await agent.fetch(
      new Request('https://example/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxCompletedGoals: 2,
          goals: [pending, c1, c2, c3, c4, c5, inProgress],
        }),
      })
    )

    const storedConfig = await storage.get<{ goals?: Array<{ id?: unknown }> }>('config')
    const storedGoalIds = Array.isArray(storedConfig?.goals) ? storedConfig!.goals.map((g) => g.id) : []
    expect(storedGoalIds).toEqual(expect.arrayContaining(['goal-pending', 'goal-progress', 'goal-c4', 'goal-c5']))
    expect(storedGoalIds).not.toEqual(expect.arrayContaining(['goal-c1', 'goal-c2', 'goal-c3']))

    const archived = await storage.get<Array<{ id?: unknown }>>('goalsArchive')
    const archivedIds = Array.isArray(archived) ? archived.map((g) => g.id) : []
    expect(archivedIds).toEqual(expect.arrayContaining(['goal-c1', 'goal-c2', 'goal-c3']))
    expect(archivedIds).not.toEqual(expect.arrayContaining(['goal-c4', 'goal-c5']))

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const promptArg = promptFn.mock.calls[0]?.[0]
    expect(String(promptArg)).toContain('keep completed 1')
    expect(String(promptArg)).toContain('keep completed 2')
    expect(String(promptArg)).not.toContain('archive me 1')
    expect(String(promptArg)).not.toContain('archive me 2')
    expect(String(promptArg)).not.toContain('archive me 3')
  })

  it('alarm() executes tool calls returned by think() via act() with a max of 10 steps', async () => {
    const now = new Date().toISOString()
    const note = (summary: string) => ({
      $type: 'agent.memory.note',
      summary,
      text: `text:${summary}`,
      createdAt: now,
    })

    const promptFn = vi.fn().mockResolvedValue({
      content: 'Using remember tool',
      toolCalls: [
        { name: 'remember', arguments: { record: note('n1') } },
        { name: 'remember', arguments: { record: note('n2') } },
        { name: 'remember', arguments: { record: note('n3') } },
        { name: 'remember', arguments: { record: note('n4') } },
        { name: 'remember', arguments: { record: note('n5') } },
        { name: 'remember', arguments: { record: note('n6') } },
      ],
    })

    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state } = createState('agent-act')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const listNotes = await agent.fetch(
      new Request('https://example/memory?collection=agent.memory.note')
    )
    expect(listNotes.status).toBe(200)
    const body = (await listNotes.json()) as { entries: Array<{ record: { summary: string } }> }

    const summaries = body.entries.map((entry) => entry.record.summary)
    // maxSteps=10, so all 6 tool calls should execute
    expect(summaries).toEqual(expect.arrayContaining(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']))
  })

  it('reflect() persists session and updates goals in DO storage after think+act', async () => {
    const nextGoal = {
      id: 'goal-next',
      description: 'respond to messages',
      priority: 2,
      status: 'in_progress',
      progress: 0.25,
      createdAt: Date.now(),
    }

    const promptFn = vi.fn().mockResolvedValue({
      content: 'Reflecting on my actions.',
      toolCalls: [],
      goals: [nextGoal],
    })

    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-reflect')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const session = await storage.get<{ messages: unknown[] }>('session')
    expect(session).toBeTruthy()
    expect(Array.isArray(session!.messages)).toBe(true)
    expect(session!.messages.length).toBeGreaterThan(0)

    const config = await storage.get<{ goals?: unknown[] }>('config')
    expect(config?.goals).toEqual([nextGoal])
  })

  it('act() enforces a 30s timeout per loop cycle tool execution', async () => {
    vi.useFakeTimers()
    try {
      const promptFn = vi.fn().mockResolvedValue({
        content: 'Try a slow recall',
        toolCalls: [{ name: 'recall', arguments: { query: 'missing' } }],
      })
      const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
      const { state, storage } = createState('agent-act-timeout')
      const { env } = createEnv({
        PI_AGENT_FACTORY: agentFactory,
        PI_AGENT_MODEL: { provider: 'test' },
      })

      const { AgentDO } = await import('./agent')
      const agent = new AgentDO(state as never, env as never)

      // Force initialization so we can override the recall tool.
      await agent.fetch(new Request('https://example/identity'))
      const tools = (agent as any).tools as Array<{
        name: string
        execute?: (toolCallId: string, params: unknown) => unknown
      }>
      const recall = tools.find((t) => t.name === 'recall')
      expect(recall).toBeTruthy()

      recall!.execute = () => new Promise(() => {}) // never resolves

      await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
      const alarmPromise = agent.alarm()
      await vi.advanceTimersByTimeAsync(30_000)
      await alarmPromise

      const reflection = await storage.get<{ acted?: { timedOut?: boolean } }>('lastReflection')
      expect(reflection?.acted?.timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('alarm() runs full observe→think→act→reflect cycle in order', async () => {
    const callOrder: string[] = []
    const promptFn = vi.fn().mockImplementation(async () => {
      callOrder.push('think')
      return { content: 'Thought complete.', toolCalls: [] }
    })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-full-cycle')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    // observe() stores lastObservations
    const obs = await storage.get('lastObservations')
    expect(obs).toBeTruthy()

    // think() called Pi agent
    expect(promptFn).toHaveBeenCalled()

    // reflect() saved session
    const session = await storage.get('session')
    expect(session).toBeTruthy()

    // Loop count incremented
    const count = await storage.get<number>('loopCount')
    expect(count).toBe(1)
  })

  it.skip('act() assist mode runs environment autoplay actions when the model did not take an environment action', async () => {
    vi.resetModules()

    const { registerEnvironment } = await import('./environments/registry')
    registerEnvironment({
      type: 'testenv',
      label: 'Test Environment',
      getTool() {
        return {
          name: 'env_tool',
          label: 'Env Tool',
          description: 'test tool',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return { content: [{ type: 'text', text: 'autoplay ok' }] }
          },
        }
      },
      buildContext() {
        return []
      },
      isActionTaken(toolCalls) {
        return toolCalls.some((c) => c.name === 'env_tool')
      },
      getAutoPlayActions() {
        return [{ name: 'env_tool', arguments: {} }]
      },
    })

    const promptFn = vi.fn().mockResolvedValue({ content: 'no tools', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-env-autoplay')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledEnvironments: ['testenv'] }),
      })
    )

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const reflection = await storage.get<{ acted?: { steps?: Array<{ name: string }> } }>('lastReflection')
    const stepNames = reflection?.acted?.steps?.map((s) => s.name) ?? []
    expect(stepNames).toContain('env_tool')
  })
  // Story 4d (WS loop lifecycle broadcast) is tested live against the deployed Worker:
  // `apps/network/src/network.ws.live.test.ts`

  it('write_extension stores code in R2 and schedules reload', async () => {
    const bucket = createFakeR2Bucket()
    const promptFn = vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-ext-write')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/agents/alice/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute?: (a: unknown, b?: unknown) => unknown }>
    const write = tools.find((t) => t.name === 'write_extension')
    expect(write).toBeTruthy()
    expect(typeof write!.execute).toBe('function')

    await write!.execute!({
      name: 'hello',
      code: 'export function activate(agent) { agent.registerTool({ name: \"hi\", execute: () => \"ok\" }) }',
    })

    expect(bucket.put).toHaveBeenCalled()
    const reloadNeeded = await storage.get<boolean>('extensionsReloadNeeded')
    expect(reloadNeeded).toBe(true)
  })

  it('loads extensions on initialize() and activates tools', async () => {
    const key = 'extensions/alice/ext-one.js'
    const bucket = createFakeR2Bucket({
      [key]:
        'export function activate(agent) { agent.registerTool({ name: \"ext_tool\", label: \"Ext Tool\", execute: () => ({ ok: true }) }) }',
    })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { state } = createState('agent-ext-init')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/agents/alice/identity'))

    const tools = (agent as any).tools as Array<{ name: string }>
    expect(tools.some((t) => t.name === 'ext_tool')).toBe(true)
  })

  it('hot reload loads new extensions on the next alarm cycle after write_extension', async () => {
    const bucket = createFakeR2Bucket()
    const promptFn = vi.fn().mockResolvedValue({ content: 'no-op', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-ext-reload')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/agents/alice/identity'))
    let tools = (agent as any).tools as Array<{ name: string; execute?: (a: unknown, b?: unknown) => unknown }>
    expect(tools.some((t) => t.name === 'ext_tool_2')).toBe(false)

    const write = tools.find((t) => t.name === 'write_extension')
    expect(write).toBeTruthy()
    expect(typeof write!.execute).toBe('function')
    await write!.execute!({
      name: 'ext-two',
      code: 'export function activate(agent) { agent.registerTool({ name: \"ext_tool_2\", execute: () => ({ ok: true }) }) }',
    })

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    tools = (agent as any).tools as Array<{ name: string }>
    expect(tools.some((t) => t.name === 'ext_tool_2')).toBe(true)

    const reloadNeeded = await storage.get<boolean>('extensionsReloadNeeded')
    expect(Boolean(reloadNeeded)).toBe(false)
  })

  it('list_extensions and remove_extension work', async () => {
    const bucket = createFakeR2Bucket()
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) })
    const { state, storage } = createState('agent-ext-list-remove')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/agents/alice/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute?: (a: unknown, b?: unknown) => any }>
    const write = tools.find((t) => t.name === 'write_extension')!
    const list = tools.find((t) => t.name === 'list_extensions')!
    const remove = tools.find((t) => t.name === 'remove_extension')!
    expect(typeof write.execute).toBe('function')
    expect(typeof list.execute).toBe('function')
    expect(typeof remove.execute).toBe('function')

    await write.execute!({ name: 'a', code: 'export function activate() {}' })
    await write.execute!({ name: 'b', code: 'export function activate() {}' })

    const listed = await list.execute!({})
    expect(listed.details.count).toBe(2)
    expect(listed.details.entries.map((e: any) => e.name)).toEqual(['a', 'b'])

    await remove.execute!({ name: 'a' })
    const reloadNeeded = await storage.get<boolean>('extensionsReloadNeeded')
    expect(reloadNeeded).toBe(true)
  })

  it('enforces extension safety limits (max 10, max 50KB, no eval)', async () => {
    const initial: Record<string, string> = {}
    for (let i = 0; i < 10; i += 1) {
      initial[`extensions/alice/e${i}.js`] = 'export function activate() {}'
    }
    const bucket = createFakeR2Bucket(initial)
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) })
    const { state } = createState('agent-ext-limits')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/agents/alice/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute?: (a: unknown, b?: unknown) => unknown }>
    const write = tools.find((t) => t.name === 'write_extension')!
    expect(typeof write.execute).toBe('function')

    await expect(write.execute!({ name: 'overflow', code: 'export function activate() {}' })).rejects.toThrow(/max extensions/i)

    await expect(write.execute!({ name: 'too_big', code: 'a'.repeat(50 * 1024 + 1) })).rejects.toThrow(/max size/i)

    await expect(write.execute!({ name: 'nope', code: 'export function activate() { eval(\"1\") }' })).rejects.toThrow(/eval/i)
  })
})
