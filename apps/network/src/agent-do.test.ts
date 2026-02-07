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
    this.store.set(key, value)
  }
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
    const stored = await storage.get<{ did: string }>('identity')

    expect(body.did).toBe('did:cf:agent-identity')
    expect(body.publicKeys.encryption).toMatch(/^z/)
    expect(body.publicKeys.signing).toMatch(/^z/)
    expect(stored?.did).toBe('did:cf:agent-identity')
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
})
