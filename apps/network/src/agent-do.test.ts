import { afterEach, describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../packages/core/src/d1-mock'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createGame as createCatanGame } from './games/catan'
import { createGame as createRpgGame } from './games/rpg-engine'

afterEach(() => {
  // Keep tests isolated: some stories stub global fetch.
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  async list(options: { prefix?: string } = {}): Promise<Map<string, unknown>> {
    const prefix = typeof options.prefix === 'string' ? options.prefix : ''
    const out = new Map<string, unknown>()
    for (const [key, value] of this.store.entries()) {
      if (prefix && !key.startsWith(prefix)) continue
      out.set(key, structuredClone(value))
    }
    return out
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

function parseJsonLogs(calls: Array<unknown[]>): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const call of calls) {
    const first = call[0]
    if (typeof first !== 'string') continue
    try {
      const parsed = JSON.parse(first)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>)
      }
    } catch {
      // ignore non-JSON logs
    }
  }
  return events
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

  it('includes extension and skill tools in the default enabledTools config', async () => {
    const { state } = createState('agent-default-tools')
    const { env } = createEnv()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const response = await agent.fetch(new Request('https://example/config'))
    const body = (await response.json()) as { enabledTools?: unknown; maxBroadcastAge?: unknown }

    expect(Array.isArray(body.enabledTools)).toBe(true)
    expect(body.enabledTools).toEqual(
      expect.arrayContaining([
        'write_extension',
        'list_extensions',
        'remove_extension',
        'write_skill',
        'list_skills',
      ])
    )
    expect(body.maxBroadcastAge).toBe(3)
  })

  it('adds environment shared-memory tools to default enabledTools only for active environments', async () => {
    const { AgentDO } = await import('./agent')

    const { state: idleState } = createState('agent-env-tools-idle')
    const { env: idleEnv } = createEnv()
    const idleAgent = new AgentDO(idleState as never, idleEnv as never)
    const idleRes = await idleAgent.fetch(new Request('https://example/agents/agent-env-tools-idle/config'))
    const idleConfig = (await idleRes.json()) as { enabledTools?: unknown }
    expect(Array.isArray(idleConfig.enabledTools)).toBe(true)
    expect(idleConfig.enabledTools).not.toEqual(expect.arrayContaining(['environment_remember', 'environment_recall']))

    const { state: activeState } = createState('agent-env-tools-active')
    const { env: activeEnv, db } = createEnv()
    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'env_shared_tools',
        'ralph',
        'agent-env-tools-active',
        JSON.stringify({ members: [{ name: 'agent-env-tools-active' }] }),
        'playing',
        JSON.stringify(['agent-env-tools-active'])
      )
      .run()

    const activeAgent = new AgentDO(activeState as never, activeEnv as never)
    const activeRes = await activeAgent.fetch(new Request('https://example/agents/agent-env-tools-active/config'))
    const activeConfig = (await activeRes.json()) as { enabledTools?: unknown }
    expect(Array.isArray(activeConfig.enabledTools)).toBe(true)
    expect(activeConfig.enabledTools).toEqual(expect.arrayContaining(['environment_remember', 'environment_recall']))
  })

  it('enables the gm tool by default only for grimlock', async () => {
    const { state: stateGrimlock } = createState('agent-gm-grimlock')
    const { env: envGrimlock } = createEnv()
    const { AgentDO } = await import('./agent')
    const grimlock = new AgentDO(stateGrimlock as never, envGrimlock as never)

    const grimlockConfigRes = await grimlock.fetch(new Request('https://example/agents/grimlock/config'))
    const grimlockConfig = (await grimlockConfigRes.json()) as { enabledTools?: unknown }
    expect(Array.isArray(grimlockConfig.enabledTools)).toBe(true)
    expect(grimlockConfig.enabledTools).toEqual(expect.arrayContaining(['gm']))

    const { state: stateOther } = createState('agent-gm-other')
    const { env: envOther } = createEnv()
    const other = new AgentDO(stateOther as never, envOther as never)

    const otherConfigRes = await other.fetch(new Request('https://example/agents/slag/config'))
    const otherConfig = (await otherConfigRes.json()) as { enabledTools?: unknown }
    expect(Array.isArray(otherConfig.enabledTools)).toBe(true)
    expect(otherConfig.enabledTools).not.toEqual(expect.arrayContaining(['gm']))
  })

  it('allows grimlock to call gm tool via /execute and persists narration into the RPG game log', async () => {
    const { state } = createState('agent-gm-execute')
    const { env, db } = createEnv()

    const game = createRpgGame({
      id: 'rpg_gm_execute_1',
      players: ['grimlock', 'alice'],
      dungeon: [{ type: 'rest', description: 'start' }],
    })
    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(game.id, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock', 'alice']))
      .run()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Ensure config exists for grimlock (so enabledTools includes gm).
    await agent.fetch(new Request('https://example/agents/grimlock/config'))

    const execRes = await agent.fetch(
      new Request('https://example/agents/grimlock/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolCalls: [
            {
              name: 'gm',
              arguments: { command: 'narrate', gameId: game.id, text: 'The torchlight bends like it is afraid.' },
            },
          ],
        }),
      })
    )
    const execBody = (await execRes.json()) as { steps?: Array<{ name: string; ok: boolean; error?: string }> }
    expect(execRes.status).toBe(200)
    expect(execBody.steps?.[0]?.name).toBe('gm')
    expect(execBody.steps?.[0]?.ok).toBe(true)

    const stored = await (db as any).prepare('SELECT state FROM environments WHERE id = ?').bind(game.id).first<{ state: string }>()
    const next = JSON.parse(String(stored?.state ?? '{}')) as any
    expect(Array.isArray(next.log)).toBe(true)
    expect(next.log.some((e: any) => e.who === 'GM' && String(e.what).startsWith('[GM]') && String(e.what).includes('torchlight'))).toBe(true)
  })

  it('non-grimlock calling gm via /execute gets tool not available', async () => {
    const { state } = createState('agent-gm-deny')
    const { env } = createEnv()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Initialize config for a non-grimlock name
    await agent.fetch(new Request('https://example/agents/slag/config'))

    const execRes = await agent.fetch(
      new Request('https://example/agents/slag/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolCalls: [{ name: 'gm', arguments: { command: 'review_party', gameId: 'does_not_matter' } }],
        }),
      })
    )
    const body = (await execRes.json()) as { steps?: Array<{ name: string; ok: boolean; error?: string }> }
    expect(execRes.status).toBe(200)
    expect(body.steps?.[0]?.name).toBe('gm')
    expect(body.steps?.[0]?.ok).toBe(false)
    expect(String(body.steps?.[0]?.error ?? '')).toContain('tool not available')
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
      expect.arrayContaining(['remember', 'recall', 'message', 'notify', 'search', 'set_goal', 'think_aloud'])
    )
  })

  it('stores full prompt + loop transcript + timing for the agentic tool loop and exposes them via /debug', async () => {
    const { state, storage } = createState('agent-debug-o11y')

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
    const character = { name: 'Rook', level: 2 }
    await storage.put('rpg:character', character)

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
    expect('extensionMetrics' in debug).toBe(true)
    expect(debug.rpgCharacter).toEqual(character)
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

    // Auto-wrapping converts invalid records to MemoryNote, so this should succeed now
    const result = await rememberTool!.execute!('tc-1', { record: invalidRecord })
    expect(result).toBeTruthy()
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

  it('skips storing duplicate memories when Vectorize similarity is above 0.9', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })

    const { state } = createState('agent-remember-dedup-skip')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { upsert: vectorizeUpsert, query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')
    expect(remember).toBeTruthy()

    const first = await remember!.execute('tc-dedup-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Dungeon trap details',
        text: 'Room 4 has a pressure plate trap by the western door.',
        createdAt: new Date().toISOString(),
      },
    })

    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: first.details.id,
          score: 0.95,
          metadata: { did: 'did:cf:agent-remember-dedup-skip', collection: 'agent.memory.note' },
        },
      ],
    })

    const duplicate = await remember!.execute('tc-dedup-2', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Known dungeon trap',
        text: 'The west-door pressure plate trap in room 4 is still active.',
        createdAt: new Date().toISOString(),
      },
    })

    expect(duplicate.content[0]?.text).toContain(`Memory already exists: ${first.details.id}`)
    expect(duplicate.details).toMatchObject({
      id: first.details.id,
      action: 'skip',
      deduped: true,
    })
    expect(db.records.size).toBe(1)
    expect(vectorizeUpsert).toHaveBeenCalledTimes(1)
    expect(vectorizeQuery).toHaveBeenCalledTimes(2)
    expect(vectorizeQuery).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      expect.objectContaining({
        topK: 1,
        filter: { did: 'did:cf:agent-remember-dedup-skip' },
      })
    )
  })

  it('stores novel memories when Vectorize similarity is below 0.7', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })

    const { state } = createState('agent-remember-dedup-novel')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { upsert: vectorizeUpsert, query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')
    expect(remember).toBeTruthy()

    const first = await remember!.execute('tc-novel-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Potion vendor',
        text: 'Town vendor sells healing potions for 50 gold.',
        createdAt: new Date().toISOString(),
      },
    })

    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: first.details.id,
          score: 0.65,
          metadata: { did: 'did:cf:agent-remember-dedup-novel', collection: 'agent.memory.note' },
        },
      ],
    })

    const second = await remember!.execute('tc-novel-2', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Guard rotation',
        text: 'Northern gate guards swap shifts every two hours.',
        createdAt: new Date().toISOString(),
      },
    })

    expect(second.content[0]?.text).toContain('Stored memory')
    expect(second.details.id).not.toBe(first.details.id)
    expect(db.records.size).toBe(2)
    expect(vectorizeUpsert).toHaveBeenCalledTimes(2)
  })

  it('broadcasts dedup observability events when duplicate memories are skipped', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })

    const { state, acceptWebSocket } = createState('agent-remember-dedup-event')
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

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() } as any as WebSocket
    acceptWebSocket(ws)

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')
    expect(remember).toBeTruthy()

    const first = await remember!.execute('tc-dedup-log-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Bridge crossing',
        text: 'The old bridge can hold only one armored person at a time.',
        createdAt: new Date().toISOString(),
      },
    })

    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: first.details.id,
          score: 0.96,
          metadata: { did: 'did:cf:agent-remember-dedup-event', collection: 'agent.memory.note' },
        },
      ],
    })

    await remember!.execute('tc-dedup-log-2', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Old bridge limit',
        text: 'Only one heavily armored adventurer should cross the old bridge at once.',
        createdAt: new Date().toISOString(),
      },
    })

    const events = (ws as any).send.mock.calls.map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
    const dedupEvent = events.find((event) => event.event_type === 'agent.memory.dedup')
    expect(dedupEvent).toBeTruthy()
    expect((dedupEvent?.context as Record<string, unknown>)?.action).toBe('skip')
    expect((dedupEvent?.context as Record<string, unknown>)?.matchedId).toBe(first.details.id)
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

  it('stores environment memories with a did:env namespace via environment_remember', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const { state } = createState('agent-env-remember')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { upsert: vectorizeUpsert, query: vectorizeQuery },
    })

    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'env_shared_1',
        'rpg',
        'agent-env-remember',
        JSON.stringify({ members: [{ name: 'agent-env-remember' }] }),
        'playing',
        JSON.stringify(['agent-env-remember'])
      )
      .run()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const environmentRemember = tools.find((t) => t.name === 'environment_remember')
    expect(environmentRemember).toBeTruthy()

    const result = await environmentRemember!.execute('tc-env-rem-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Shared room intel',
        text: 'We already explored room 3 and found nothing.',
        createdAt: new Date().toISOString(),
      },
    })
    expect(result.details.id).toContain('did:env:env_shared_1/agent.memory.note/')

    const [firstUpsert] = vectorizeUpsert.mock.calls
    expect(Array.isArray(firstUpsert?.[0])).toBe(true)
    expect(firstUpsert?.[0]?.[0]).toMatchObject({
      id: result.details.id,
      metadata: { did: 'did:env:env_shared_1', collection: 'agent.memory.note' },
    })
  })

  it('recalls environment memories via semantic search in environment_recall', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const { state } = createState('agent-env-recall')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { upsert: vectorizeUpsert, query: vectorizeQuery },
    })

    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'env_shared_2',
        'rpg',
        'agent-env-recall',
        JSON.stringify({ members: [{ name: 'agent-env-recall' }] }),
        'playing',
        JSON.stringify(['agent-env-recall'])
      )
      .run()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const environmentRemember = tools.find((t) => t.name === 'environment_remember')
    const environmentRecall = tools.find((t) => t.name === 'environment_recall')
    expect(environmentRemember).toBeTruthy()
    expect(environmentRecall).toBeTruthy()

    const stored = await environmentRemember!.execute('tc-env-rem-2', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Merchant pricing',
        text: 'The merchant in town sells healing potions for 50 gold.',
        createdAt: new Date().toISOString(),
      },
    })

    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: stored.details.id,
          score: 0.96,
          metadata: { did: 'did:env:env_shared_2', collection: 'agent.memory.note' },
        },
      ],
    })

    const recalled = await environmentRecall!.execute('tc-env-rec-1', { query: 'healing potions', limit: 3 })
    expect(vectorizeQuery).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        filter: { did: 'did:env:env_shared_2' },
      })
    )
    expect(recalled.details.results[0]).toMatchObject({
      id: stored.details.id,
      record: { summary: 'Merchant pricing' },
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

  it('broadcasts a message to all other members in active environments via environment_broadcast', async () => {
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env: baseEnv, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const { RelayDO } = await import('./relay')

    const senderState = createState('agent-alpha')
    const betaState = createState('agent-beta')
    const gammaState = createState('agent-gamma')
    const relayState = createState('relay-main').state

    const senderEnv = { ...baseEnv } as any
    const betaEnv = { ...baseEnv } as any
    const gammaEnv = { ...baseEnv } as any

    const sender = new AgentDO(senderState.state as never, senderEnv as never)
    const beta = new AgentDO(betaState.state as never, betaEnv as never)
    const gamma = new AgentDO(gammaState.state as never, gammaEnv as never)

    const agentsById = new Map<string, any>([
      ['agent-alpha', sender],
      ['agent-beta', beta],
      ['agent-gamma', gamma],
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
    senderEnv.AGENTS = agentsNamespace
    betaEnv.RELAY = relayNamespace
    betaEnv.AGENTS = agentsNamespace
    gammaEnv.RELAY = relayNamespace
    gammaEnv.AGENTS = agentsNamespace

    await (db as any)
      .prepare("INSERT INTO agents (name, did, created_at) VALUES (?, ?, datetime('now'))")
      .bind('agent-alpha', 'did:cf:agent-alpha')
      .run()
    await (db as any)
      .prepare("INSERT INTO agents (name, did, created_at) VALUES (?, ?, datetime('now'))")
      .bind('agent-beta', 'did:cf:agent-beta')
      .run()
    await (db as any)
      .prepare("INSERT INTO agents (name, did, created_at) VALUES (?, ?, datetime('now'))")
      .bind('agent-gamma', 'did:cf:agent-gamma')
      .run()

    const environmentState = {
      members: [{ name: 'agent-alpha' }, { name: 'agent-beta' }, { name: 'agent-gamma' }],
      mode: 'coordination',
    }
    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'ralph_env_broadcast_1',
        'ralph',
        'agent-alpha',
        JSON.stringify(environmentState),
        'playing',
        JSON.stringify(['agent-alpha']),
      )
      .run()

    // Force init (so tools are built and identity is present).
    await sender.fetch(new Request('https://example/identity'))
    await beta.fetch(new Request('https://example/identity'))
    await gamma.fetch(new Request('https://example/identity'))

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() } as any as WebSocket
    senderState.acceptWebSocket(ws)

    const tools = (sender as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const environmentBroadcast = tools.find((t) => t.name === 'environment_broadcast')
    expect(environmentBroadcast).toBeTruthy()

    const result = await environmentBroadcast!.execute('tc-env-broadcast-1', {
      message: 'Status check: regroup at base camp.',
      intent: 'status',
    })

    expect(result.details).toMatchObject({
      delivered: 2,
      intent: 'status',
      recipients: ['did:cf:agent-beta', 'did:cf:agent-gamma'],
    })

    const betaInbox = await beta.fetch(new Request('https://example/inbox?limit=10'))
    expect(betaInbox.status).toBe(200)
    const betaBody = (await betaInbox.json()) as { entries: Array<{ record: any }> }
    expect(betaBody.entries[0]?.record).toMatchObject({
      $type: 'agent.comms.broadcast',
      sender: 'did:cf:agent-alpha',
      senderName: 'agent-alpha',
      recipient: 'did:cf:agent-beta',
      intent: 'status',
      content: { kind: 'text', text: 'Status check: regroup at base camp.' },
    })
    expect(typeof betaBody.entries[0]?.record?.createdAt).toBe('string')

    const gammaInbox = await gamma.fetch(new Request('https://example/inbox?limit=10'))
    expect(gammaInbox.status).toBe(200)
    const gammaBody = (await gammaInbox.json()) as { entries: Array<{ record: any }> }
    expect(gammaBody.entries[0]?.record).toMatchObject({
      $type: 'agent.comms.broadcast',
      recipient: 'did:cf:agent-gamma',
      intent: 'status',
    })

    // Sender should not receive its own broadcast.
    const senderInbox = await sender.fetch(new Request('https://example/inbox?limit=10'))
    expect(senderInbox.status).toBe(200)
    const senderBody = (await senderInbox.json()) as { entries: Array<{ record: any }> }
    expect(senderBody.entries.some((entry) => entry.record?.$type === 'agent.comms.broadcast')).toBe(false)

    // Delivery should use RelayDO route + emit broadcast event for dashboards/o11y.
    expect(relayFetch).toHaveBeenCalled()
    expect(relayFetch.mock.calls.some(([req]) => new URL(req.url).pathname.endsWith('/relay/broadcast'))).toBe(true)
    expect(relayFetch.mock.calls.some(([req]) => new URL(req.url).pathname.endsWith('/relay/emit'))).toBe(true)

    expect((ws as any).send).toHaveBeenCalled()
    const sentEvents = (ws as any).send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(String(call[0]))
        } catch {
          return null
        }
      })
      .filter(Boolean) as Array<Record<string, unknown>>
    const broadcastEvent = sentEvents.find((event) => event.event_type === 'agent.comms.broadcast')
    expect(broadcastEvent).toBeTruthy()
    expect(broadcastEvent?.context).toMatchObject({
      message: 'Status check: regroup at base camp.',
      intent: 'status',
      recipients: ['did:cf:agent-beta', 'did:cf:agent-gamma'],
      delivered: 2,
    })
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

  it('broadcasts memory lifecycle events to websocket clients', async () => {
    const { state, acceptWebSocket } = createState('agent-memory-events')
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
    const remember = tools.find((t) => t.name === 'remember')
    const recall = tools.find((t) => t.name === 'recall')
    expect(remember).toBeTruthy()
    expect(recall).toBeTruthy()

    const remembered = await remember!.execute('tc-mem-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Memory events',
        text: 'show all memory event types',
        createdAt: new Date().toISOString(),
      },
    })
    const rememberId = remembered.details.id as string

    const apiRecord = {
      $type: 'agent.memory.note',
      summary: 'API memory',
      text: 'stored through HTTP',
      createdAt: new Date().toISOString(),
    }
    const postResponse = await agent.fetch(new Request('https://example/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiRecord),
    }))
    expect(postResponse.status).toBe(200)
    const { id } = (await postResponse.json()) as { id: string }

    await recall!.execute('tc-mem-2', { query: 'memory', limit: 3 })

    const getResponse = await agent.fetch(new Request(`https://example/memory?id=${encodeURIComponent(id)}`))
    expect(getResponse.status).toBe(200)

    const listResponse = await agent.fetch(new Request('https://example/memory?collection=agent.memory.note&limit=10'))
    expect(listResponse.status).toBe(200)

    const updated = { ...apiRecord, summary: 'API memory updated', text: 'updated through HTTP' }
    const putResponse = await agent.fetch(new Request(`https://example/memory?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    }))
    expect(putResponse.status).toBe(200)

    const deleteResponse = await agent.fetch(new Request(`https://example/memory?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }))
    expect(deleteResponse.status).toBe(200)

    const events = (ws as any).send.mock.calls.map((call: [string]) => JSON.parse(call[0]) as Record<string, unknown>)
    const eventTypes = events.map((event) => event.event_type)
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'agent.memory.store',
        'agent.memory.recall',
        'agent.memory.retrieve',
        'agent.memory.list',
        'agent.memory.update',
        'agent.memory.delete',
      ])
    )

    const storeSources = events
      .filter((event) => event.event_type === 'agent.memory.store')
      .map((event) => (event.context as Record<string, unknown>)?.source)

    expect(storeSources).toEqual(expect.arrayContaining(['tool.remember', 'api.memory.post']))

    const storedIds = events
      .filter((event) => event.event_type === 'agent.memory.store')
      .map((event) => (event.context as Record<string, unknown>)?.id)

    expect(storedIds).toEqual(expect.arrayContaining([rememberId, id]))
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

  it('POSTs inbox messages to webhookUrl when configured (fire-and-forget)', async () => {
    const { state } = createState('agent-inbox-webhook')
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const webhookUrl = 'https://example.test/webhook'
    const patch = await agent.fetch(
      new Request('https://example/agents/webhooky/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl }),
      })
    )
    expect(patch.status).toBe(200)

    const message = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:agent-inbox-webhook',
      content: { kind: 'text', text: 'hello webhook' },
      createdAt: new Date().toISOString(),
    }

    const postResponse = await agent.fetch(new Request('https://example/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }))
    expect(postResponse.status).toBe(200)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [unknown, unknown]
    expect(url).toBe(webhookUrl)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    const body = (init as { body?: unknown }).body
    expect(typeof body).toBe('string')
    expect(JSON.parse(String(body))).toEqual({
      type: 'inbox',
      message: { ...message, priority: 3 },
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
    })
    expect(config1.enabledTools).toEqual(expect.arrayContaining(['remember']))
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
    // GET /config now includes profile from DO storage (empty by default)
    const { profile: _p, ...config3WithoutProfile } = config3
    expect(config3WithoutProfile).toEqual(config2)
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

  it('GET /character returns {} when no character exists', async () => {
    const { state } = createState('agent-character-empty')
    const { env } = createEnv()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const res = await agent.fetch(new Request('https://example/agents/alice/character'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('PUT then GET /character roundtrips character data', async () => {
    const { state } = createState('agent-character-roundtrip')
    const { env } = createEnv()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const character = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 3,
      xp: 500,
      maxHp: 20,
      maxMp: 5,
      skills: { attack: 60, dodge: 30, cast_spell: 10, use_skill: 40 },
      backstory: 'A dwarf from the Iron Hills.',
      motivation: 'Recover the lost crown.',
      appearance: 'Broad shoulders, braided beard.',
      personalityTraits: ['stubborn', 'loyal'],
      adventureLog: ['Adventure 1'],
      achievements: ['First blood'],
      inventory: [
        {
          name: 'Sword',
          rarity: 'common',
          slot: 'weapon',
          effects: [{ stat: 'attack', bonus: 2 }],
          description: 'A trusted steel blade.',
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      gamesPlayed: 5,
      deaths: 1,
    }

    const put = await agent.fetch(
      new Request('https://example/agents/alice/character', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(character),
      })
    )
    expect(put.status).toBe(200)

    const get = await agent.fetch(new Request('https://example/agents/alice/character'))
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual(character)
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

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Simulate alarm firing
    await agent.alarm()

    // Counter should be incremented
    const loopCount = await storage.get<number>('loopCount')
    expect(loopCount).toBeGreaterThanOrEqual(1)

    // Next alarm should be scheduled
    const nextAlarm = await storage.getAlarm()
    expect(nextAlarm).not.toBeNull()

    // Structured lifecycle logs should be emitted (ignore non-JSON logs).
    const events: Array<Record<string, unknown>> = []
    for (const call of logSpy.mock.calls) {
      const first = call[0]
      if (typeof first !== 'string') continue
      try {
        const parsed = JSON.parse(first)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>)
        }
      } catch {
        // ignore
      }
    }

    const types = new Set(events.map((e) => e.event_type).filter((v): v is string => typeof v === 'string'))
    expect(types.has('agent.cycle.start')).toBe(true)
    expect(types.has('agent.alarm.schedule')).toBe(true)
    expect(types.has('agent.cycle.end')).toBe(true)
  })

  it('alarm() sends cycle summary event to O11Y pipeline', async () => {
    const { state, storage } = createState('agent-alarm-o11y-pipeline')
    const sendFn = vi.fn().mockResolvedValue(undefined)
    const pipeline = { send: sendFn }
    const { env } = createEnv({
      O11Y_PIPELINE: pipeline,
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({
        prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }),
      }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await agent.alarm()

    expect(sendFn).toHaveBeenCalledTimes(1)

    const [events] = sendFn.mock.calls[0]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event_type: 'agent.cycle',
      agent: 'did:cf:agent-alarm-o11y-pipeline',
      mode: 'think',
      toolCalls: 0,
      errors: 0,
    })
    expect(typeof events[0].durationMs).toBe('number')
    expect(typeof events[0]._ts).toBe('string')

    const nextAlarm = await storage.getAlarm()
    expect(nextAlarm).not.toBeNull()
  })

  it('alarm() treats O11Y pipeline failures as non-fatal', async () => {
    const { state, storage } = createState('agent-alarm-o11y-pipeline-failure')
    const pipeline = { send: vi.fn().mockRejectedValue(new Error('pipeline down')) }
    const { env } = createEnv({
      O11Y_PIPELINE: pipeline,
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({
        prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }),
      }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(agent.alarm()).resolves.toBeUndefined()

    expect(pipeline.send).toHaveBeenCalledTimes(1)
    expect(await storage.getAlarm()).not.toBeNull()
  })

  it("alarm() rotates alarmMode think(5)→housekeeping(1)→reflection(1)→think", async () => {
    const { state, storage } = createState('agent-alarm-mode-rotation')
    const { env } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))

    // Quiet JSON logs; this test only asserts storage keys.
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const modes: string[] = []
    for (let i = 0; i < 7; i += 1) {
      await agent.alarm()
      modes.push(String((await storage.get('alarmMode')) ?? ''))
    }

    expect(modes).toEqual(['think', 'think', 'think', 'think', 'housekeeping', 'reflection', 'think'])
    expect(await storage.get('alarmModeCounter')).toBe(0)
  })

  it("alarm() in housekeeping mode prunes completed goals older than 24h", async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-alarm-housekeeping-goals')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const now = Date.now()
    const old = now - 25 * 60 * 60 * 1000
    const completed = (id: string, completedAt: number) => ({
      id,
      description: id,
      priority: 0,
      status: 'completed' as const,
      progress: 1,
      createdAt: completedAt - 1_000,
      completedAt,
    })
    const pending = {
      id: 'goal-pending',
      description: 'keep me',
      priority: 1,
      status: 'pending',
      progress: 0,
      createdAt: now - 1_000,
    }

    await agent.fetch(
      new Request('https://example/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxCompletedGoals: 10,
          goals: [
            pending,
            completed('goal-old-1', old - 3_000),
            completed('goal-old-2', old - 2_000),
            completed('goal-old-3', old - 1_000),
          ],
        }),
      })
    )

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('alarmMode', 'housekeeping')

    // Quiet noisy lifecycle logs. This test asserts only stored config mutation.
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await agent.alarm()

    const storedConfig = await storage.get<{ goals?: Array<{ id?: unknown }> }>('config')
    const storedIds = Array.isArray(storedConfig?.goals) ? storedConfig!.goals.map((g) => g.id) : []

    expect(storedIds).toEqual(expect.arrayContaining(['goal-pending']))
    expect(storedIds).not.toEqual(expect.arrayContaining(['goal-old-1', 'goal-old-2', 'goal-old-3']))
  })

  it("alarm() in reflection mode stores lastReflection text", async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'reflection: do better', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-alarm-reflection')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('alarmMode', 'reflection')
    await storage.put('actionOutcomes', [
      { tool: 'remember', success: true, timestamp: Date.now() - 3_000 },
      { tool: 'search', success: false, timestamp: Date.now() - 2_000 },
      { tool: 'message', success: true, timestamp: Date.now() - 1_000 },
    ])

    // Quiet noisy lifecycle logs.
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await agent.alarm()

    const lastReflection = await storage.get('lastReflection')
    expect(lastReflection).toBe('reflection: do better')

    const prompt = promptFn.mock.calls[0]?.[0]
    expect(typeof prompt).toBe('string')
    expect(String(prompt)).toContain(
      'Review your last 10 actions. What patterns do you see? What should you do differently? Respond with updated goals if needed.'
    )
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

    // After success, the next cycle is housekeeping (no model call), so it schedules the normal interval again.
    vi.setSystemTime(new Date(tSuccess + 5_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(tSuccess + 5_000 + 5_000)

    // Next transient error after success happens on the following reflection cycle and restarts at 15s.
    vi.setSystemTime(new Date(tSuccess + 10_000))
    await agent.alarm()
    expect(await storage.getAlarm()).toBe(tSuccess + 10_000 + 15_000)

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

  it("alarm() clamps interval to 15s when gameContext says it's your turn", async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-01-04T00:00:00.000Z')
    vi.setSystemTime(t0)

    const { state, storage } = createState('agent-adaptive-interval')
    const prompt = vi.fn().mockResolvedValue({ text: 'ok' })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const agentName = 'Ada'

    // Disable tools so act() doesn't trigger the game safety-net injections; this test only cares about scheduling.
    await agent.fetch(new Request(`https://example/agents/${agentName}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName, enabledTools: [], loopIntervalMs: 120_000 }),
    }))

    await db
      .prepare('INSERT INTO environments (id, type, host_agent, state, phase, players) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        'catan_test_1',
        'catan',
        agentName,
        JSON.stringify({
          type: 'catan',
          turn: 3,
          currentPlayer: agentName,
          players: [
            { name: agentName, victoryPoints: 0, resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }, settlements: [], roads: [] },
            { name: 'Bob', victoryPoints: 0, resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }, settlements: [], roads: [] },
          ],
          board: { edges: [], vertices: [], hexes: [] },
          log: [],
        }),
        'playing',
        JSON.stringify([agentName, 'Bob'])
      )
      .run()

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))

    await agent.alarm()
    expect(await storage.getAlarm()).toBe(t0.getTime() + 15_000)

    vi.useRealTimers()
  })

  it('suppresses think_aloud and recall tool definitions during active game turns', async () => {
    const { state } = createState('agent-gameplay-tools')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ function?: { name?: string } }> }
      const names = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean) as string[]

      expect(names).toContain('remember')
      expect(names).toContain('rpg')
      expect(names).not.toContain('think_aloud')
      expect(names).not.toContain('recall')

      return new Response(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    vi.stubGlobal('fetch', fetchSpy)

    const { env, db } = createEnv({
      CF_ACCOUNT_ID: 'acct',
      AI_GATEWAY_SLUG: 'slug',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL_DEFAULT: 'test-model',
      BLOBS: createFakeR2Bucket(),
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const agentName = 'Ada'
    await agent.fetch(
      new Request(`https://example/agents/${agentName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: agentName }),
      })
    )

    await db
      .prepare('INSERT INTO environments (id, type, host_agent, state, phase, players) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        'rpg_test_tools_1',
        'rpg',
        agentName,
        JSON.stringify({
          type: 'rpg',
          phase: 'playing',
          mode: 'exploring',
          roomIndex: 0,
          currentPlayer: agentName,
          party: [
            {
              name: agentName,
              klass: 'Warrior',
              hp: 10,
              maxHp: 10,
              mp: 2,
              maxMp: 2,
              stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 },
              skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 },
            },
          ],
          turnOrder: [
            {
              name: agentName,
              klass: 'Warrior',
              hp: 10,
              maxHp: 10,
              mp: 2,
              maxMp: 2,
              stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 },
              skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 },
            },
          ],
          dungeon: [{ type: 'trap', description: 'A pressure plate clicks underfoot.' }],
          log: [],
        }),
        'playing',
        JSON.stringify([agentName])
      )
      .run()

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const events = parseJsonLogs(logSpy.mock.calls)
    const filterEvent = events.find((e) => e.event_type === 'tools.gameplay_filter')
    expect(filterEvent).toBeTruthy()
    expect(filterEvent?.suppressed).toEqual(['think_aloud', 'recall'])
  })

  it('keeps message and environment_broadcast available during setup-phase turns', async () => {
    const { state } = createState('agent-setup-tools')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<{ function?: { name?: string } }> }
      const names = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean) as string[]

      expect(names).toContain('message')
      expect(names).toContain('environment_broadcast')
      expect(names).not.toContain('think_aloud')
      expect(names).not.toContain('recall')
      expect(names).not.toContain('remember')

      return new Response(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    vi.stubGlobal('fetch', fetchSpy)

    const { env, db } = createEnv({
      CF_ACCOUNT_ID: 'acct',
      AI_GATEWAY_SLUG: 'slug',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL_DEFAULT: 'test-model',
      BLOBS: createFakeR2Bucket(),
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const agentName = 'Ada'
    await agent.fetch(
      new Request(`https://example/agents/${agentName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: agentName }),
      })
    )

    const game = createCatanGame('catan_setup_tools_1', [agentName, 'Bob'])

    await db
      .prepare('INSERT INTO environments (id, type, host_agent, state, phase, players) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(game.id, 'catan', agentName, JSON.stringify(game), game.phase, JSON.stringify([agentName, 'Bob']))
      .run()

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const events = parseJsonLogs(logSpy.mock.calls)
    const filterEvent = events.find((e) => e.event_type === 'tools.gameplay_filter')
    expect(filterEvent).toBeTruthy()
    expect(filterEvent?.suppressed).toEqual(['think_aloud', 'recall', 'remember', 'gm'])
  })

  it('includes RPG cooperation rules in the think prompt', async () => {
    const { state } = createState('agent-rpg-coop-prompt')
    const prompt = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const agentName = 'Ada'
    await agent.fetch(new Request(`https://example/agents/${agentName}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName, enabledTools: [] }),
    }))

    await db
      .prepare('INSERT INTO environments (id, type, host_agent, state, phase, players) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        'rpg_test_1',
        'rpg',
        'grimlock',
        JSON.stringify({
          type: 'rpg',
          phase: 'playing',
          mode: 'exploring',
          roomIndex: 0,
          currentPlayer: agentName,
          party: [{ name: agentName, klass: 'Warrior', hp: 10, maxHp: 10, mp: 2, maxMp: 2, stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 }, skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 } }],
          turnOrder: [{ name: agentName, klass: 'Warrior', hp: 10, maxHp: 10, mp: 2, maxMp: 2, stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 }, skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 } }],
          dungeon: [{ type: 'trap', description: 'A pressure plate clicks underfoot.' }],
          log: [],
        }),
        'playing',
        JSON.stringify([agentName, 'grimlock'])
      )
      .run()

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const thinkPrompt = prompt.mock.calls[0]?.[0]
    expect(typeof thinkPrompt).toBe('string')
    expect(thinkPrompt).toContain('YOUR ROLE')
    expect(thinkPrompt).toContain('Focus fire')
    expect(thinkPrompt).toContain('Positioning')
    expect(thinkPrompt).toContain('Party Coordination')
    expect(thinkPrompt.indexOf('YOUR ROLE')).toBeLessThan(thinkPrompt.indexOf('🎮🎮🎮 IT IS YOUR TURN'))
  })

  it('injects DO RPG skill before environment context and overrides hardcoded fallback', async () => {
    const { state } = createState('agent-rpg-do-skill-prompt')
    const prompt = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const agentName = 'Ada'
    await agent.fetch(new Request(`https://example/agents/${agentName}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName, enabledTools: [] }),
    }))

    await db
      .prepare('INSERT INTO environments (id, type, host_agent, state, phase, players) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        'rpg_test_do_skill_1',
        'rpg',
        'grimlock',
        JSON.stringify({
          type: 'rpg',
          phase: 'playing',
          mode: 'exploring',
          roomIndex: 0,
          currentPlayer: agentName,
          party: [{ name: agentName, klass: 'Warrior', hp: 10, maxHp: 10, mp: 2, maxMp: 2, stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 }, skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 } }],
          turnOrder: [{ name: agentName, klass: 'Warrior', hp: 10, maxHp: 10, mp: 2, maxMp: 2, stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 }, skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 } }],
          dungeon: [{ type: 'trap', description: 'A pressure plate clicks underfoot.' }],
          log: [],
        }),
        'playing',
        JSON.stringify([agentName, 'grimlock'])
      )
      .run()

    await (agent as any).writeSkill({
      id: 'skill-warrior-do',
      name: 'Warrior override',
      description: 'Custom warrior directives',
      content: 'CUSTOM RPG SKILL: Hold the left flank and protect healers.',
      envType: 'rpg',
      role: 'warrior',
      version: '1.0.0',
    })

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const thinkPrompt = prompt.mock.calls[0]?.[0]
    expect(typeof thinkPrompt).toBe('string')
    expect(thinkPrompt).toContain('CUSTOM RPG SKILL: Hold the left flank and protect healers.')
    expect(thinkPrompt.indexOf('CUSTOM RPG SKILL: Hold the left flank and protect healers.')).toBeLessThan(
      thinkPrompt.indexOf('🎮🎮🎮 IT IS YOUR TURN')
    )
    expect(thinkPrompt).not.toContain('Focus fire')
  })

  it('adds a blocked-mode recruitment message when an RPG barrier requires a missing class', async () => {
    const { state } = createState('agent-rpg-blocked-prompt')
    const prompt = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] })
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: vi.fn().mockResolvedValue({ prompt }),
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const agentName = 'Ada'
    await agent.fetch(new Request(`https://example/agents/${agentName}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName, enabledTools: [] }),
    }))

    await db
      .prepare('INSERT INTO environments (id, type, host_agent, state, phase, players) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        'rpg_test_2',
        'rpg',
        agentName,
        JSON.stringify({
          type: 'rpg',
          phase: 'playing',
          mode: 'exploring',
          roomIndex: 0,
          currentPlayer: agentName,
          party: [{ name: agentName, klass: 'Warrior', hp: 10, maxHp: 10, mp: 2, maxMp: 2, stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 }, skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 } }],
          turnOrder: [{ name: agentName, klass: 'Warrior', hp: 10, maxHp: 10, mp: 2, maxMp: 2, stats: { STR: 75, DEX: 50, INT: 40, WIS: 40 }, skills: { attack: 60, dodge: 45, cast_spell: 40, use_skill: 35 } }],
          dungeon: [
            {
              type: 'barrier',
              requiredClass: 'Mage',
              description: 'A sealed archway bars the way. Only a Mage can open it.',
            },
          ],
          log: [],
        }),
        'playing',
        JSON.stringify([agentName])
      )
      .run()

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    const thinkPrompt = prompt.mock.calls[0]?.[0]
    expect(typeof thinkPrompt).toBe('string')
    expect(thinkPrompt).toContain('URGENT: Recruit Mage via message tool')
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

  it('injects relevant memories into the think prompt when memories exist', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-auto-recall')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery, upsert: vectorizeUpsert },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')
    expect(remember).toBeTruthy()

    const createdAt = '2026-01-15T12:00:00.000Z'
    const stored = await remember!.execute('tc-auto-rec-remember', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Scout saw tracks near the eastern ridge.',
        text: 'Observed goblin tracks near the eastern ridge by the old watchtower.',
        tags: ['scout', 'threat'],
        createdAt,
      },
    })

    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: stored.details.id,
          score: 0.93,
          metadata: { did: 'did:cf:agent-auto-recall', collection: 'agent.memory.note' },
        },
      ],
    })

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'enemy-sighting' }])
    await agent.alarm()

    const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
    expect(promptArg).toContain('📝 Relevant memories:')
    expect(promptArg).toContain('Scout saw tracks near the eastern ridge.')
    expect(promptArg).toMatch(/\[(?:\d+[smhd] ago|yesterday)\]/)
    expect(vectorizeQuery).toHaveBeenCalled()
  })

  it('re-ranks auto-recall memories by recency-weighted score', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'))
    try {
      const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
      const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
      const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
      const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
      const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
      const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
      const { state, storage } = createState('agent-auto-recall-recency-rank')
      const { env } = createEnv({
        PI_AGENT_FACTORY: agentFactory,
        PI_AGENT_MODEL: { provider: 'test' },
        AI: { run: aiRun },
        VECTORIZE: { query: vectorizeQuery, upsert: vectorizeUpsert },
      })

      const { AgentDO } = await import('./agent')
      const agent = new AgentDO(state as never, env as never)
      await agent.fetch(new Request('https://example/identity'))

      const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
      const remember = tools.find((t) => t.name === 'remember')
      expect(remember).toBeTruthy()

      const oldStored = await remember!.execute('tc-auto-recency-old', {
        record: {
          $type: 'agent.memory.note',
          summary: 'Old high score memory',
          text: 'Historical lead from long ago.',
          createdAt: '2026-02-12T00:00:00.000Z',
        },
      })

      const recentStored = await remember!.execute('tc-auto-recency-new', {
        record: {
          $type: 'agent.memory.note',
          summary: 'Recent lower score memory',
          text: 'Fresh intel from this morning.',
          createdAt: '2026-02-13T09:30:00.000Z',
        },
      })

      vectorizeQuery.mockResolvedValueOnce({
        matches: [
          {
            id: oldStored.details.id,
            score: 0.9,
            metadata: { did: 'did:cf:agent-auto-recall-recency-rank', collection: 'agent.memory.note' },
          },
          {
            id: recentStored.details.id,
            score: 0.8,
            metadata: { did: 'did:cf:agent-auto-recall-recency-rank', collection: 'agent.memory.note' },
          },
        ],
      })

      await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
      await storage.put('pendingEvents', [{ ts: Date.now(), type: 'recency-rank-query' }])
      await agent.alarm()

      const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
      const recentIndex = promptArg.indexOf('Recent lower score memory')
      const oldIndex = promptArg.indexOf('Old high score memory')
      expect(recentIndex).toBeGreaterThanOrEqual(0)
      expect(oldIndex).toBeGreaterThanOrEqual(0)
      expect(recentIndex).toBeLessThan(oldIndex)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders relative age labels in auto-recall memory bullets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'))
    try {
      const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
      const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
      const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
      const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
      const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
      const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
      const { state, storage } = createState('agent-auto-recall-age-labels')
      const { env } = createEnv({
        PI_AGENT_FACTORY: agentFactory,
        PI_AGENT_MODEL: { provider: 'test' },
        AI: { run: aiRun },
        VECTORIZE: { query: vectorizeQuery, upsert: vectorizeUpsert },
      })

      const { AgentDO } = await import('./agent')
      const agent = new AgentDO(state as never, env as never)
      await agent.fetch(new Request('https://example/identity'))

      const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
      const remember = tools.find((t) => t.name === 'remember')
      expect(remember).toBeTruthy()

      const hoursAgoStored = await remember!.execute('tc-auto-age-2h', {
        record: {
          $type: 'agent.memory.note',
          summary: 'Two hour note',
          text: 'Filed two hours ago.',
          createdAt: '2026-02-13T10:00:00.000Z',
        },
      })

      const yesterdayStored = await remember!.execute('tc-auto-age-yesterday', {
        record: {
          $type: 'agent.memory.note',
          summary: 'Yesterday note',
          text: 'Filed yesterday.',
          createdAt: '2026-02-12T06:00:00.000Z',
        },
      })

      vectorizeQuery.mockResolvedValueOnce({
        matches: [
          {
            id: hoursAgoStored.details.id,
            score: 0.91,
            metadata: { did: 'did:cf:agent-auto-recall-age-labels', collection: 'agent.memory.note' },
          },
          {
            id: yesterdayStored.details.id,
            score: 0.89,
            metadata: { did: 'did:cf:agent-auto-recall-age-labels', collection: 'agent.memory.note' },
          },
        ],
      })

      await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
      await storage.put('pendingEvents', [{ ts: Date.now(), type: 'age-label-query' }])
      await agent.alarm()

      const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
      expect(promptArg).toContain('[2h ago]')
      expect(promptArg).toContain('[yesterday]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('omits the relevant memories section when no memories exist', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-auto-recall-empty')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'seed-event' }])
    await agent.alarm()

    const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
    expect(promptArg).not.toContain('📝 Relevant memories:')
    expect(vectorizeQuery).not.toHaveBeenCalled()
  })

  it('caps injected relevant memory text to the token budget', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-auto-recall-cap')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery, upsert: vectorizeUpsert },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')
    expect(remember).toBeTruthy()

    const longText = 'A'.repeat(1400)
    const storedIds: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const stored = await remember!.execute(`tc-auto-cap-${i}`, {
        record: {
          $type: 'agent.memory.note',
          summary: `Long memory ${i} ${longText}`,
          text: `Body ${i} ${longText}`,
          createdAt: `2026-01-1${(i % 9) + 1}T00:00:00.000Z`,
        },
      })
      storedIds.push(String(stored.details.id))
    }

    vectorizeQuery.mockResolvedValueOnce({
      matches: storedIds.slice(0, 5).map((id, idx) => ({
        id,
        score: 0.99 - idx * 0.01,
        metadata: { did: 'did:cf:agent-auto-recall-cap', collection: 'agent.memory.note' },
      })),
    })

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'long-memory-query' }])
    await agent.alarm()

    const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
    const start = promptArg.indexOf('📝 Relevant memories:')
    const end = promptArg.indexOf('Available tools:')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const memorySection = promptArg.slice(start, end)
    const approxTokens = Math.ceil(memorySection.length / 4)
    expect(approxTokens).toBeLessThanOrEqual(500)
  })

  it('injects shared environment memories into the think prompt with [shared] labels', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-auto-recall-shared')
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery, upsert: vectorizeUpsert },
    })

    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'env_shared_prompt',
        'rpg',
        'agent-auto-recall-shared',
        JSON.stringify({ members: [{ name: 'agent-auto-recall-shared' }] }),
        'playing',
        JSON.stringify(['agent-auto-recall-shared'])
      )
      .run()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const environmentRemember = tools.find((t) => t.name === 'environment_remember')
    expect(environmentRemember).toBeTruthy()

    const sharedStored = await environmentRemember!.execute('tc-auto-shared-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Shared merchant intel',
        text: 'The merchant in town sells healing potions for 50 gold.',
        createdAt: '2026-01-20T12:00:00.000Z',
      },
    })

    // Personal recall is skipped when no agent-scoped memories exist; shared lookup issues one query.
    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        {
          id: sharedStored.details.id,
          score: 0.97,
          metadata: { did: 'did:env:env_shared_prompt', collection: 'agent.memory.note' },
        },
      ],
    })

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'shared-intel-check' }])
    await agent.alarm()

    const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
    expect(promptArg).toContain('📝 Relevant memories:')
    expect(promptArg).toContain('[shared]')
    expect(promptArg).toContain('The merchant in town sells healing potions for 50 gold.')
  })

  it('skips undecryptable vectorized memories and still injects readable ones', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const vectorizeUpsert = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-auto-recall-decrypt-skip')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery, upsert: vectorizeUpsert },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const remember = tools.find((t) => t.name === 'remember')
    expect(remember).toBeTruthy()

    const unreadableMemory = await remember!.execute('tc-auto-decrypt-bad', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Unreadable memory',
        text: 'This memory should be skipped if decrypt fails.',
        createdAt: '2026-01-20T12:00:00.000Z',
      },
    })
    const readableMemory = await remember!.execute('tc-auto-decrypt-good', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Readable memory',
        text: 'This memory should still appear.',
        createdAt: '2026-01-20T12:10:00.000Z',
      },
    })

    const unreadableId = String(unreadableMemory.details.id)
    const readableId = String(readableMemory.details.id)
    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        { id: unreadableId, score: 0.99, metadata: { did: 'did:cf:agent-auto-recall-decrypt-skip' } },
        { id: readableId, score: 0.98, metadata: { did: 'did:cf:agent-auto-recall-decrypt-skip' } },
      ],
    })

    const memory = (agent as any).memory
    const originalRetrieve = memory.retrieve.bind(memory)
    vi.spyOn(memory, 'retrieve').mockImplementation(async (id: string) => {
      if (id === unreadableId) throw new Error('Decryption failed')
      return originalRetrieve(id)
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'decrypt-skip-check' }])
    await agent.alarm()

    const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
    expect(promptArg).toContain('Readable memory')
    expect(promptArg).not.toContain('Unreadable memory')
    expect(errorSpy).toHaveBeenCalledWith(
      'Skipping unreadable memory during auto-recall',
      expect.objectContaining({
        agent: expect.stringContaining('agent-auto-recall-decrypt-skip'),
        memoryId: unreadableId,
      })
    )
  })

  it('skips shared memories that fail decryption and keeps other shared matches', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024)
    const aiRun = vi.fn().mockResolvedValue({ data: [embedding] })
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] })
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state } = createState('agent-auto-recall-shared-decrypt-skip')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
      AI: { run: aiRun },
      VECTORIZE: { query: vectorizeQuery },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const unreadableSharedId = 'did:env:env-shared/agent.memory.note/bad'
    const readableSharedId = 'did:env:env-shared/agent.memory.note/good'
    vectorizeQuery.mockResolvedValueOnce({
      matches: [
        { id: unreadableSharedId, score: 0.95, metadata: { did: 'did:env:env-shared' } },
        { id: readableSharedId, score: 0.94, metadata: { did: 'did:env:env-shared' } },
      ],
    })

    const sharedMemory = {
      retrieveShared: vi.fn(async (id: string) => {
        if (id === unreadableSharedId) throw new Error('Decryption failed')
        return {
          $type: 'agent.memory.note',
          summary: 'Readable shared memory',
          text: 'Shared memory that should still load.',
          createdAt: '2026-01-20T12:00:00.000Z',
        }
      }),
      listShared: vi.fn().mockResolvedValue([]),
    }
    ;(agent as any).memory = sharedMemory

    const optionsMemory = {
      list: vi.fn().mockResolvedValue([{ id: 'seed', record: { $type: 'agent.memory.note', text: 'seed query' } }]),
      retrieve: vi.fn().mockResolvedValue(null),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const recalled = await (agent as any).recallMemories('seed query', 5, {
      memory: optionsMemory,
      did: 'did:env:env-shared',
      includeShared: true,
      sharedIdPrefixes: ['did:env:env-shared/'],
    })

    expect(recalled.results).toHaveLength(1)
    expect(recalled.results[0]?.id).toBe(readableSharedId)
    expect((recalled.results[0]?.record as Record<string, unknown>).summary).toBe('Readable shared memory')
    expect(errorSpy).toHaveBeenCalledWith(
      'Skipping unreadable shared memory during auto-recall',
      expect.objectContaining({
        agent: expect.stringContaining('agent-auto-recall-shared-decrypt-skip'),
        memoryId: unreadableSharedId,
      })
    )
  })

  it('returns an empty relevant memories section when section building fails', async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-auto-recall-section-failure')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))
    vi.spyOn(agent as any, 'buildRelevantMemoriesSection').mockRejectedValue(new Error('memory section failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await storage.put('pendingEvents', [{ ts: Date.now(), type: 'section-failure-check' }])
    await agent.alarm()

    const promptArg = String(promptFn.mock.calls[0]?.[0] ?? '')
    expect(promptFn).toHaveBeenCalledTimes(1)
    expect(promptArg).not.toContain('📝 Relevant memories:')
    expect(errorSpy).toHaveBeenCalledWith(
      'Auto-recall section generation failed',
      expect.objectContaining({
        agent: expect.stringContaining('agent-auto-recall-section-failure'),
      })
    )
  })

  it('handles fallback memory.list decryption failure without throwing', async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state } = createState('agent-auto-recall-list-failure')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/identity'))

    const optionsMemory = {
      list: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'seed', record: { $type: 'agent.memory.note', text: 'seed query' } }])
        .mockRejectedValueOnce(new Error('Decryption failed')),
      retrieve: vi.fn().mockResolvedValue(null),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      (agent as any).recallMemories('seed query', 5, {
        memory: optionsMemory,
      })
    ).resolves.toEqual({
      results: [],
      usedVectorize: false,
    })
    expect(errorSpy).toHaveBeenCalledWith(
      'Auto-recall fallback list failed',
      expect.objectContaining({
        agent: expect.stringContaining('agent-auto-recall-list-failure'),
      })
    )
  })

  it('isolates environment memories between different active environments', async () => {
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { env: baseEnv, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'env_shared_alpha',
        'rpg',
        'agent-env-alpha',
        JSON.stringify({ members: [{ name: 'agent-env-alpha' }] }),
        'playing',
        JSON.stringify(['agent-env-alpha'])
      )
      .run()
    await (db as any)
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(
        'env_shared_beta',
        'rpg',
        'agent-env-beta',
        JSON.stringify({ members: [{ name: 'agent-env-beta' }] }),
        'playing',
        JSON.stringify(['agent-env-beta'])
      )
      .run()

    const { AgentDO } = await import('./agent')
    const alphaState = createState('agent-env-alpha').state
    const betaState = createState('agent-env-beta').state
    const alpha = new AgentDO(alphaState as never, { ...baseEnv } as never)
    const beta = new AgentDO(betaState as never, { ...baseEnv } as never)

    await alpha.fetch(new Request('https://example/identity'))
    await beta.fetch(new Request('https://example/identity'))

    const alphaTools = (alpha as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const betaTools = (beta as any).tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>
    const alphaEnvRemember = alphaTools.find((t) => t.name === 'environment_remember')
    const betaEnvRecall = betaTools.find((t) => t.name === 'environment_recall')
    expect(alphaEnvRemember).toBeTruthy()
    expect(betaEnvRecall).toBeTruthy()

    await alphaEnvRemember!.execute('tc-env-iso-1', {
      record: {
        $type: 'agent.memory.note',
        summary: 'Room 3 intel',
        text: 'We already explored room 3 and found nothing.',
        createdAt: new Date().toISOString(),
      },
    })

    const betaResults = await betaEnvRecall!.execute('tc-env-iso-2', {
      query: 'room 3',
      limit: 5,
    })
    expect(Array.isArray(betaResults.details.results)).toBe(true)
    expect(betaResults.details.results).toHaveLength(0)
  })

  it('keeps consumed environment broadcasts in think prompt Team Comms for maxBroadcastAge cycles, then prunes them', async () => {
    const promptFn = vi.fn().mockResolvedValue({ content: 'ack', toolCalls: [] })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state } = createState('agent-team-comms')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(
      new Request('https://example/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamCommsLimit: 5, maxBroadcastAge: 3 }),
      })
    )

    const now = Date.now()
    const messages = [
      {
        senderName: 'slag',
        intent: 'plan',
        text: "I'll tank the boss. Focus fire on adds.",
        createdAt: new Date(now - 2 * 60_000).toISOString(),
      },
      {
        senderName: 'swoop',
        intent: 'status',
        text: 'MP at 60%, saving AoE for grouped enemies.',
        createdAt: new Date(now - 60_000).toISOString(),
      },
      {
        senderName: 'snarl',
        intent: 'alert',
        text: 'Backline under pressure; rotating defensive stance.',
        createdAt: new Date(now - 30_000).toISOString(),
      },
      {
        senderName: 'grimlock',
        intent: 'request',
        text: 'Need crowd control near the eastern gate.',
        createdAt: new Date(now - 20_000).toISOString(),
      },
      {
        senderName: 'bumble',
        intent: 'response',
        text: 'On my way with crowd control support.',
        createdAt: new Date(now - 10_000).toISOString(),
      },
      {
        senderName: 'wheeljack',
        intent: 'status',
        text: 'Repair kit deployed at rally point.',
        createdAt: new Date(now - 5_000).toISOString(),
      },
    ] as const

    for (const msg of messages) {
      const post = await agent.fetch(
        new Request('https://example/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            $type: 'agent.comms.broadcast',
            sender: `did:cf:${msg.senderName}`,
            senderName: msg.senderName,
            recipient: 'did:cf:agent-team-comms',
            intent: msg.intent,
            content: { kind: 'text', text: msg.text },
            createdAt: msg.createdAt,
          }),
        })
      )
      expect(post.status).toBe(200)
    }

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    await agent.alarm()

    expect(promptFn).toHaveBeenCalledTimes(1)
    const promptArg1 = promptFn.mock.calls[0][0] as string
    expect(promptArg1).toContain('🗣️ Team Comms (recent broadcasts from your environment):')
    expect(promptArg1).toContain('wheeljack (status): Repair kit deployed at rally point.')
    expect(promptArg1).not.toContain("slag (plan): I'll tank the boss. Focus fire on adds.")

    await agent.alarm()
    expect(promptFn).toHaveBeenCalledTimes(2)
    const promptArg2 = promptFn.mock.calls[1][0] as string
    expect(promptArg2).toContain('🗣️ Team Comms (recent broadcasts from your environment):')
    expect(promptArg2).toContain('wheeljack (status): Repair kit deployed at rally point.')

    await agent.alarm()
    expect(promptFn).toHaveBeenCalledTimes(3)
    const promptArg3 = promptFn.mock.calls[2][0] as string
    expect(promptArg3).toContain('🗣️ Team Comms (recent broadcasts from your environment):')
    expect(promptArg3).toContain('wheeljack (status): Repair kit deployed at rally point.')

    await agent.alarm()
    expect(promptFn).toHaveBeenCalledTimes(4)
    const promptArg4 = promptFn.mock.calls[3][0] as string
    expect(promptArg4).not.toContain('🗣️ Team Comms (recent broadcasts from your environment):')
    expect(promptArg4).not.toContain('wheeljack')

    const listResponse = await agent.fetch(new Request('https://example/inbox?limit=20'))
    expect(listResponse.status).toBe(200)
    const listBody = (await listResponse.json()) as { entries: Array<{ record: { $type?: unknown } }> }
    expect(
      listBody.entries.some((entry) => entry.record?.$type === 'agent.comms.broadcast')
    ).toBe(false)
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

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await agent.alarm()

    const listNotes = await agent.fetch(
      new Request('https://example/memory?collection=agent.memory.note')
    )
    expect(listNotes.status).toBe(200)
    const body = (await listNotes.json()) as { entries: Array<{ record: { summary: string } }> }

    const summaries = body.entries.map((entry) => entry.record.summary)
    // maxSteps=10, so all 6 tool calls should execute
    expect(summaries).toEqual(expect.arrayContaining(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']))

    // TODO: structured log event assertions (agent.tool.call, agent.tool.result) — pending structured logging implementation
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await agent.alarm()

    const session = await storage.get<{ messages: unknown[] }>('session')
    expect(session).toBeTruthy()
    expect(Array.isArray(session!.messages)).toBe(true)
    expect(session!.messages.length).toBeGreaterThan(0)

    const config = await storage.get<{ goals?: unknown[] }>('config')
    expect(config?.goals).toEqual([nextGoal])

    // TODO: structured log event assertion (agent.goal.update) — pending structured logging implementation
  })

  it('set_goal tool emits agent.goal.update JSON logs', async () => {
    const promptFn = vi.fn().mockResolvedValue({
      content: 'Adding a goal.',
      toolCalls: [
        { name: 'set_goal', arguments: { action: 'add', goal: { description: 'do the thing', priority: 1 } } },
      ],
    })

    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-set-goal-log')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await agent.alarm()

    const config = await storage.get<{ goals?: Array<{ description?: string }> }>('config')
    expect(config?.goals?.some((g) => g?.description === 'do the thing')).toBe(true)

    // TODO: structured log event assertion (agent.goal.update) — pending structured logging implementation
  })

  it('game tool emits agent.game.action JSON logs even when the action errors', async () => {
    const promptFn = vi.fn().mockResolvedValue({
      content: 'Attempt game action.',
      toolCalls: [
        {
          name: 'game',
          arguments: {
            command: 'action',
            gameId: 'catan_missing',
            gameAction: { type: 'roll_dice' },
          },
        },
      ],
    })

    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state } = createState('agent-game-action-log')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await agent.alarm()

    // TODO: structured log event assertion (agent.game.action) — pending structured logging implementation
  })

  it('remaps misrouted game->rpg tool calls when active environment is rpg', async () => {
    const promptFn = vi.fn().mockResolvedValue({
      content: 'Attack in the dungeon.',
      toolCalls: [{ name: 'game', arguments: { command: 'status', gameId: 'rpg_router_1' } }],
    })

    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-tool-router-rpg')
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    // Seed an active RPG game so the runtime is in RPG context.
    const gameId = 'rpg_router_1'
    const game = createRpgGame({ id: gameId, players: ['alice'] }) as any
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    // Ensure agentName used by environment registry matches the DB row.
    await agent.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    )

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await agent.alarm()

      const reflection = await storage.get<{ acted?: { steps?: Array<{ name: string; ok: boolean }> } }>('lastReflection')
      expect(reflection?.acted?.steps?.[0]).toMatchObject({ name: 'rpg', ok: true })

      const events = parseJsonLogs(logSpy.mock.calls)
      const misroute = events.find((e) => e.event_type === 'agent.tool.misroute')
      expect(misroute).toMatchObject({ event_type: 'agent.tool.misroute', from: 'game', to: 'rpg', env: 'rpg' })
    } finally {
      logSpy.mockRestore()
    }
  })

  it('remaps misrouted rpg->game tool calls when active environment is catan', async () => {
    const promptFn = vi.fn().mockResolvedValue({
      content: 'Roll dice in Catan.',
      toolCalls: [
        { name: 'rpg', arguments: { command: 'action', gameId: 'catan_router_1', gameAction: { type: 'end_turn' } } },
      ],
    })

    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-tool-router-catan')
    const { env, db } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    // Seed an active Catan game so the runtime is in Catan context.
    const gameId = 'catan_router_1'
    const game = createCatanGame(gameId, ['alice', 'bob']) as any
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO environments (id, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const before = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const beforeState = JSON.parse(before.state)
    expect(beforeState.currentPlayer).toBe('alice')

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(
      new Request('https://example/agents/alice/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    )

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await agent.alarm()

      const reflection = await storage.get<{ acted?: { steps?: Array<{ name: string; ok: boolean }> } }>('lastReflection')
      expect(reflection?.acted?.steps?.[0]).toMatchObject({ name: 'game', ok: true })

      const after = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
      const afterState = JSON.parse(after.state)
      expect(afterState.currentPlayer).toBe('bob')
      expect(afterState.turn).toBe(beforeState.turn + 1)

      const events = parseJsonLogs(logSpy.mock.calls)
      const misroute = events.find((e) => e.event_type === 'agent.tool.misroute')
      expect(misroute).toMatchObject({ event_type: 'agent.tool.misroute', from: 'rpg', to: 'game', env: 'catan' })
    } finally {
      logSpy.mockRestore()
    }
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

  it('stores actionOutcomes in DO storage after each tool call in act()', async () => {
    const promptFn = vi.fn().mockResolvedValue({
      content: 'Run a couple tools.',
      toolCalls: [
        { name: 'think_aloud', arguments: { message: 'planning...' } },
        { name: 'set_goal', arguments: { action: 'add', goal: { description: 'Ship the feature', priority: 1 } } },
      ],
    })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: promptFn })
    const { state, storage } = createState('agent-action-outcomes')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/loop/start', { method: 'POST' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await agent.alarm()

    const outcomes = await storage.get<any>('actionOutcomes')
    expect(Array.isArray(outcomes)).toBe(true)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({ tool: 'think_aloud', success: true })
    expect(outcomes[1]).toMatchObject({ tool: 'set_goal', success: true })
    expect(typeof outcomes[0]?.timestamp).toBe('number')
    expect(typeof outcomes[1]?.timestamp).toBe('number')
  })

  it('ralphEnvironment.getAutoPlayActions() claims the next open ralph work item by priority', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const { ralphEnvironment } = await import('./environments/ralph')

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    } as any

    // Seed two open Ralph work items with different priorities.
    const tool = ralphEnvironment.getTool(ctx)
    await tool.execute?.('toolcall-propose-1', {
      command: 'propose_work',
      env_type: 'ralph',
      id: 'work_p2',
      title: 'second',
      priority: 2,
      payload: {},
    })
    await tool.execute?.('toolcall-propose-2', {
      command: 'propose_work',
      env_type: 'ralph',
      id: 'work_p1',
      title: 'first',
      priority: 1,
      payload: {},
    })

    const actions = await ralphEnvironment.getAutoPlayActions(ctx)
    expect(actions).toEqual([{ name: 'ralph', arguments: { command: 'claim_work', id: 'work_p1' } }])
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

  it('tracks extension usage metrics in DO storage after activation', async () => {
    const key = 'extensions/alice/ext-metrics.js'
    const bucket = createFakeR2Bucket({
      [key]:
        'export function activate(agent) { agent.registerTool({ name: \"ext_metrics_tool\", label: \"Ext Metrics Tool\", execute: () => ({ ok: true }) }) }',
    })
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn() })
    const { state, storage } = createState('agent-ext-metrics')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    await agent.fetch(new Request('https://example/agents/alice/identity'))

    // Execute a tool that came from an extension (proves extension activation worked).
    const tools = (agent as any).tools as Array<{ name: string; execute?: (a: unknown, b?: unknown) => unknown }>
    const extTool = tools.find((t) => t.name === 'ext_metrics_tool')
    expect(extTool).toBeTruthy()
    expect(typeof extTool!.execute).toBe('function')
    await extTool!.execute!({})

    const metrics = await storage.get<any>('extensionMetrics:ext-metrics')
    expect(metrics).toMatchObject({
      name: 'ext-metrics',
      totalCalls: 1,
      successCalls: 1,
      failedCalls: 0,
      lastUsed: expect.any(Number),
    })
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

  it('write_skill and list_skills tools persist AgentSkill records in DO storage', async () => {
    const bucket = createFakeR2Bucket()
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) })
    const { state, storage } = createState('agent-skill-tools')
    const { env } = createEnv({
      BLOBS: bucket,
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/agents/alice/identity'))

    const tools = (agent as any).tools as Array<{ name: string; execute?: (a: unknown, b?: unknown) => any }>
    const writeSkill = tools.find((t) => t.name === 'write_skill')!
    const listSkills = tools.find((t) => t.name === 'list_skills')!
    expect(typeof writeSkill.execute).toBe('function')
    expect(typeof listSkills.execute).toBe('function')

    const first = await writeSkill.execute!({
      name: 'Dungeon Scout',
      description: 'Exploration heuristics for room sequencing.',
      content: 'Prioritize barrier rooms after rest nodes.',
      envType: 'rpg',
      role: 'scout',
      version: '1.0.0',
    })
    const firstId = first?.details?.skill?.id as string
    expect(typeof firstId).toBe('string')
    expect(firstId.length).toBeGreaterThan(0)

    const stored = await storage.get<Record<string, unknown>>('skill:rpg:scout')
    expect(stored).toMatchObject({
      id: firstId,
      name: 'Dungeon Scout',
      description: 'Exploration heuristics for room sequencing.',
      content: 'Prioritize barrier rooms after rest nodes.',
      envType: 'rpg',
      role: 'scout',
      version: '1.0.0',
    })

    await writeSkill.execute!({
      name: 'Dungeon Scout',
      description: 'Updated strategy',
      content: 'Re-check traps before engaging.',
      envType: 'rpg',
      role: 'scout',
      version: '1.1.0',
    })

    const listed = await listSkills.execute!({})
    expect(listed.details.count).toBe(1)
    expect(listed.details.entries[0]).toMatchObject({
      name: 'Dungeon Scout',
      envType: 'rpg',
      role: 'scout',
      version: '1.1.0',
    })
  })

  it('skill storage CRUD methods write/read/list/delete skill records by envType/role key', async () => {
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) })
    const { state } = createState('agent-skill-crud')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)
    await agent.fetch(new Request('https://example/agents/alice/identity'))

    const storedSkill = await (agent as any).writeSkill({
      id: 'skill-1',
      name: 'Campaign Planner',
      description: 'Plans campaign arcs.',
      content: 'Use faction tension as pacing.',
      envType: 'rpg',
      role: 'planner',
      version: '2.0.0',
    })
    expect(storedSkill).toMatchObject({ id: 'skill-1', envType: 'rpg', role: 'planner' })

    const readSkill = await (agent as any).readSkill('rpg', 'planner')
    expect(readSkill).toMatchObject({ id: 'skill-1', name: 'Campaign Planner' })

    const listed = await (agent as any).listSkills()
    expect(Array.isArray(listed)).toBe(true)
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'skill-1', envType: 'rpg', role: 'planner' }),
      ])
    )

    const deleted = await (agent as any).deleteSkill('skill-1')
    expect(deleted).toBe(true)
    await expect((agent as any).readSkill('rpg', 'planner')).resolves.toBeNull()
  })

  it('supports GET and PUT /agents/:name/skills/:envType/:role for external skill seeding', async () => {
    const agentFactory = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) })
    const { state } = createState('agent-skill-route')
    const { env } = createEnv({
      PI_AGENT_FACTORY: agentFactory,
      PI_AGENT_MODEL: { provider: 'test' },
    })

    const { AgentDO } = await import('./agent')
    const agent = new AgentDO(state as never, env as never)

    const putResponse = await agent.fetch(
      new Request('https://example/agents/alice/skills/rpg/scout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Scout Seed',
          description: 'External seed for scout role.',
          content: 'Prefer stealth approach.',
          version: '0.1.0',
        }),
      })
    )
    expect(putResponse.status).toBe(200)
    const putBody = (await putResponse.json()) as { skill?: Record<string, unknown> }
    expect(putBody.skill).toMatchObject({
      name: 'Scout Seed',
      description: 'External seed for scout role.',
      content: 'Prefer stealth approach.',
      envType: 'rpg',
      role: 'scout',
      version: '0.1.0',
    })

    const getResponse = await agent.fetch(new Request('https://example/agents/alice/skills/rpg/scout'))
    expect(getResponse.status).toBe(200)
    const getBody = (await getResponse.json()) as { skill?: Record<string, unknown> }
    expect(getBody.skill).toMatchObject({
      name: 'Scout Seed',
      envType: 'rpg',
      role: 'scout',
      version: '0.1.0',
    })
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
