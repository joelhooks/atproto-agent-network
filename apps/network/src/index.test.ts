import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../packages/core/src/d1-mock'

vi.mock('cloudflare:workers', () => {
  class DurableObject {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_ctx: unknown, _env: unknown) {}
  }

  return { DurableObject }
})

function createAgentNamespace(agentFetch: (req: Request) => Promise<Response>) {
  return {
    idFromName: vi.fn().mockReturnValue('agent-id'),
    get: vi.fn().mockReturnValue({ fetch: agentFetch }),
  }
}

const ADMIN_TOKEN = 'test-admin-token'

function createHealthEnv(overrides: Record<string, unknown> = {}) {
  const agentFetch = vi.fn(async () => new Response('ok'))

  return {
    AGENTS: createAgentNamespace(agentFetch),
    RELAY: createAgentNamespace(agentFetch),
    DB: new D1MockDatabase(),
    BLOBS: { get: vi.fn(), put: vi.fn() },
    VECTORIZE: { query: vi.fn() },
    MESSAGE_QUEUE: { send: vi.fn() },
    AI: { run: vi.fn() },

    CF_ACCOUNT_ID: '00000000000000000000000000000000',
    AI_GATEWAY_SLUG: 'test-gateway',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    OPENROUTER_MODEL_DEFAULT: 'openrouter/test',

    ADMIN_TOKEN,
    ...overrides,
  } as never
}

async function registerAgent(db: D1MockDatabase, input: { name: string; did: string }) {
  await db
    .prepare('INSERT INTO agents (name, did, created_at) VALUES (?, ?, ?)')
    .bind(input.name, input.did, new Date().toISOString())
    .run()
}

describe('network worker lexicon validation', () => {
  it('rejects requests without a bearer token before routing', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    // GET requests to agent routes are now public (read-only)
    // Test with POST instead to verify auth is still required for writes
    const response = await worker.fetch(new Request('https://example.com/agents/alice/prompt', { method: 'POST' }), env)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized',
    })
    expect(agentFetch).not.toHaveBeenCalled()
  })

  it('rejects requests without a bearer token before parsing JSON bodies', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      env
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized',
    })
    expect(agentFetch).not.toHaveBeenCalled()
  })

  it('rejects invalid lexicon records at the worker boundary with 400 + issues', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const invalidRecord = {
      $type: 'agent.memory.note',
      createdAt: new Date().toISOString(),
    }

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify(invalidRecord),
      }),
      env
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid record',
      issues: expect.any(Array),
    })
    expect(agentFetch).not.toHaveBeenCalled()
  })

  it('forwards the parsed lexicon record (defaults applied) to the agent DO', async () => {
    const agentFetch = vi.fn(async (req: Request) => Response.json(await req.json()))
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const record = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:recipient',
      content: { kind: 'text', text: 'hello' },
      createdAt: new Date().toISOString(),
    }

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify(record),
      }),
      env
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ...record,
      priority: 3,
    })
    expect(agentFetch).toHaveBeenCalledTimes(1)
  })

  it('returns 400 with a descriptive message for invalid JSON', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: '{',
      }),
      env
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid JSON',
    })
    expect(agentFetch).not.toHaveBeenCalled()
  })

  it('returns 500 JSON when a downstream route handler throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const agentFetch = vi.fn(async () => {
      throw new Error('agent down')
    })
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/identity', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Internal Server Error',
    })

    expect(consoleSpy).toHaveBeenCalledWith(
      'Unhandled route error',
      expect.objectContaining({ route: 'network.agents' })
    )
    consoleSpy.mockRestore()
  })
})

describe('network worker CORS', () => {
  it('responds to OPTIONS preflight without requiring auth', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/identity', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      }),
      env
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(agentFetch).not.toHaveBeenCalled()
  })

  it('adds CORS headers to auth errors', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    // Use POST to trigger auth check (GET is public for agent reads)
    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/prompt', {
        method: 'POST',
        headers: { Origin: 'https://app.example' },
      }),
      env
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('uses a configured CORS origin when provided', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
      CORS_ORIGIN: 'https://dashboard.example',
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/identity', {
        headers: { Origin: 'https://dashboard.example', Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://dashboard.example')
  })
})

describe('agent creation API', () => {
  it('requires admin auth for POST /agents', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', personality: 'test' }),
      }),
      env
    )

    expect(response.status).toBe(401)
  })

  it('requires admin auth for GET /agents', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(new Request('https://example.com/agents'), env)

    expect(response.status).toBe(401)
  })

  it('returns 400 with validation issues for invalid AgentConfig', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: new D1MockDatabase(),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ name: '', personality: '' }),
      }),
      env
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid agent config',
      issues: expect.any(Array),
    })
  })

  it('creates an agent, stores registry row, and starts the loop', async () => {
    const agentFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/create') && req.method === 'POST') {
        const body = (await req.json()) as any
        return Response.json({
          did: `did:cf:${body.name}`,
          createdAt: Date.now(),
          publicKeys: { encryption: 'enc', signing: 'sig' },
          config: body,
          loop: { loopRunning: true, nextAlarm: Date.now() },
        })
      }
      return new Response('unexpected', { status: 500 })
    })

    const db = new D1MockDatabase()
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ name: 'alice', personality: 'You are Alice.' }),
      }),
      env
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      did: expect.stringMatching(/^did:cf:/),
      publicKeys: { encryption: 'enc', signing: 'sig' },
      config: expect.objectContaining({
        name: 'alice',
        personality: 'You are Alice.',
        model: 'moonshotai/kimi-k2.5',
      }),
    })

    const row = await db
      .prepare('SELECT * FROM agents WHERE name = ?')
      .bind('alice')
      .first<{ name: string; did: string }>()
    expect(row).toMatchObject({ name: 'alice', did: expect.stringMatching(/^did:cf:/) })
  })

  it('returns 409 on duplicate agent name', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })

    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ name: 'alice', personality: 'You are Alice.' }),
      }),
      env
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Agent already exists',
    })
  })

  it('lists all agents via GET /agents', async () => {
    const agentFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url)
      const parts = url.pathname.split('/').filter(Boolean)
      const name = parts[1]
      const leaf = parts.at(-1)

      if (leaf === 'identity') {
        return Response.json({
          did: `did:cf:${name}`,
          createdAt: 1_700_000_000_000,
          publicKeys: { encryption: `${name}-enc`, signing: `${name}-sig` },
        })
      }

      if (leaf === 'config') {
        return Response.json({
          name,
          personality: `You are ${name}.`,
          model: 'moonshotai/kimi-k2.5',
          fastModel: 'google/gemini-2.0-flash-001',
          loopIntervalMs: 60_000,
          specialty: '',
          goals: [],
          enabledTools: [],
        })
      }

      return new Response('unexpected', { status: 500 })
    })
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    await registerAgent(db, { name: 'bob', did: 'did:cf:bob' })

    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      DB: db,
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          did: 'did:cf:alice',
          publicKeys: { encryption: 'alice-enc', signing: 'alice-sig' },
          config: expect.objectContaining({ name: 'alice', personality: 'You are alice.' }),
        }),
        expect.objectContaining({
          name: 'bob',
          did: 'did:cf:bob',
          publicKeys: { encryption: 'bob-enc', signing: 'bob-sig' },
          config: expect.objectContaining({ name: 'bob', personality: 'You are bob.' }),
        }),
      ]),
    })

    expect(agentFetch).toHaveBeenCalled()
  })
})

describe('network worker health endpoint', () => {
  it('responds 200 without requiring auth when bindings are present', async () => {
    const env = createHealthEnv()

    const { default: worker } = await import('./index')

    const response = await worker.fetch(new Request('https://example.com/health'), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      missing: [],
    })
  })

  it('returns 500 and lists missing bindings when misconfigured', async () => {
    const env = {} as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(new Request('https://example.com/health'), env)

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({
      status: 'error',
      missing: expect.any(Array),
    })
    expect(body.missing).toEqual(expect.arrayContaining(['AGENTS', 'ADMIN_TOKEN']))
  })
})
