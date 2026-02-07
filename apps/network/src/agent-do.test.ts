import { describe, expect, it, vi } from 'vitest'

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

class FakeD1Statement {
  private readonly params: unknown[]
  private readonly sql: string
  private readonly db: FakeD1Database

  constructor(db: FakeD1Database, sql: string, params: unknown[] = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }

  bind(...params: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.sql, params)
  }

  async run(): Promise<void> {
    await this.db.run(this.sql, this.params)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.params)
  }
}

class FakeD1Database {
  readonly records = new Map<string, RecordRow>()

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this, sql)
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = normalizeSql(sql)

    if (normalized.startsWith('insert into records')) {
      const [
        id,
        did,
        collection,
        rkey,
        ciphertext,
        encryptedDek,
        nonce,
        isPublic,
        createdAt,
      ] = params

      this.records.set(id as string, {
        id: id as string,
        did: did as string,
        collection: collection as string,
        rkey: rkey as string,
        ciphertext: asBytes(ciphertext, 'ciphertext'),
        encrypted_dek: encryptedDek ? asBytes(encryptedDek, 'encrypted_dek') : null,
        nonce: asBytes(nonce, 'nonce'),
        public: Number(isPublic),
        created_at: createdAt as string,
        updated_at: null,
      })
      return
    }

    throw new Error(`Unsupported SQL in FakeD1Database.run: ${normalized}`)
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const normalized = normalizeSql(sql)

    if (normalized.includes('from records') && normalized.includes('where id = ?')) {
      const [id, did] = params as [string, string]
      const row = this.records.get(id)
      if (!row) return null
      if (did && row.did !== did) return null
      return row as unknown as T
    }

    throw new Error(`Unsupported SQL in FakeD1Database.first: ${normalized}`)
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`${label} must be bytes`)
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
  const db = new FakeD1Database()
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
})
