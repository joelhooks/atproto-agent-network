import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../packages/core/src/d1-mock'
import { createGame } from './games/catan'

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

async function registerGame(
  db: D1MockDatabase,
  input: {
    id: string
    hostAgent: string
    phase: string
    players: string[]
    state?: Record<string, unknown>
    winner?: string | null
  }
) {
  const state = input.state ?? { id: input.id, phase: input.phase, players: input.players }

  await db
    .prepare(
      "INSERT INTO games (id, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    )
    .bind(
      input.id,
      input.hostAgent,
      JSON.stringify(state),
      input.phase,
      JSON.stringify(input.players)
    )
    .run()

  if (typeof input.winner !== 'undefined') {
    await db
      .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(state), input.phase, input.winner, input.id)
      .run()
  }
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

describe('network worker environments API', () => {
  it('GET /environments lists instances and supports type/phase/player filters', async () => {
    const db = new D1MockDatabase()

    await registerGame(db, {
      id: 'catan_1',
      hostAgent: 'grimlock',
      phase: 'playing',
      players: ['grimlock', 'slag'],
      state: { id: 'catan_1', phase: 'playing', currentPlayer: 'grimlock' },
    })
    await registerGame(db, {
      id: 'rpg_1',
      hostAgent: 'snarl',
      phase: 'playing',
      players: ['snarl', 'swoop'],
      state: { id: 'rpg_1', phase: 'playing' },
    })
    await registerGame(db, {
      id: 'catan_2',
      hostAgent: 'grimlock',
      phase: 'finished',
      players: ['grimlock', 'snarl'],
      winner: 'grimlock',
      state: { id: 'catan_2', phase: 'finished', winner: 'grimlock' },
    })

    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/environments?type=catan&phase=playing&player=grimlock', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      environments: [
        expect.objectContaining({
          id: 'catan_1',
          type: 'catan',
          phase: 'playing',
          hostAgent: 'grimlock',
          players: ['grimlock', 'slag'],
        }),
      ],
    })
  })

  it('POST /environments creates a new instance and /games stays a catan alias', async () => {
    const db = new D1MockDatabase()
    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const createRes = await worker.fetch(
      new Request('https://example.com/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ type: 'catan', players: ['slag', 'snarl'] }),
      }),
      env
    )

    expect(createRes.status).toBe(200)
    const created = await createRes.json()
    expect(created).toMatchObject({
      type: 'catan',
      players: ['slag', 'snarl'],
    })
    expect(typeof created.id).toBe('string')
    expect(created.id).toMatch(/^catan_/)

    const gamesRes = await worker.fetch(
      new Request('https://example.com/games?all=true', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(gamesRes.status).toBe(200)
    const games = await gamesRes.json()
    expect(games.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          type: 'catan',
        }),
      ])
    )
  })

  it('GET /games?all=true returns all game rows (not just catan)', async () => {
    const db = new D1MockDatabase()

    await registerGame(db, {
      id: 'catan_1',
      hostAgent: 'grimlock',
      phase: 'playing',
      players: ['grimlock', 'slag'],
      state: { id: 'catan_1', phase: 'playing' },
    })
    await registerGame(db, {
      id: 'rpg_1',
      hostAgent: 'snarl',
      phase: 'playing',
      players: ['snarl', 'swoop'],
      state: { id: 'rpg_1', phase: 'playing' },
    })

    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/games?all=true', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'catan_1', type: 'catan' }),
        expect.objectContaining({ id: 'rpg_1', type: 'rpg' }),
      ])
    )
  })

  it('GET /games includes active and recently finished (24h) by default', async () => {
    const db = new D1MockDatabase()
    vi.useFakeTimers()
    try {
      const base = new Date('2026-02-09T00:00:00.000Z')

      vi.setSystemTime(new Date(base.getTime() - 48 * 60 * 60_000))
      await registerGame(db, {
        id: 'catan_finished_old',
        hostAgent: 'grimlock',
        phase: 'finished',
        players: ['grimlock', 'snarl'],
      })

      vi.setSystemTime(new Date(base.getTime() - 2 * 60 * 60_000))
      await registerGame(db, {
        id: 'rpg_finished_recent',
        hostAgent: 'snarl',
        phase: 'finished',
        players: ['snarl', 'swoop'],
      })

      vi.setSystemTime(new Date(base.getTime() - 60_000))
      await registerGame(db, {
        id: 'catan_active',
        hostAgent: 'grimlock',
        phase: 'playing',
        players: ['grimlock', 'slag'],
      })

      await registerGame(db, {
        id: 'rpg_setup',
        hostAgent: 'snarl',
        phase: 'setup',
        players: ['snarl', 'swoop'],
      })

      vi.setSystemTime(base)

      const env = createHealthEnv({ DB: db })
      const { default: worker } = await import('./index')

      const response = await worker.fetch(
        new Request('https://example.com/games', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      const ids = (body.games as any[]).map((g) => g.id)

      expect(ids).toEqual(expect.arrayContaining(['catan_active', 'rpg_finished_recent']))
      expect(ids).not.toContain('catan_finished_old')
      expect(ids).not.toContain('rpg_setup')
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /games supports pagination via limit + cursor', async () => {
    const db = new D1MockDatabase()
    vi.useFakeTimers()
    try {
      const base = new Date('2026-02-09T00:00:00.000Z')

      vi.setSystemTime(new Date(base.getTime() - 2000))
      await registerGame(db, {
        id: 'catan_1',
        hostAgent: 'grimlock',
        phase: 'playing',
        players: ['grimlock', 'snarl'],
      })

      vi.setSystemTime(new Date(base.getTime() - 1000))
      await registerGame(db, {
        id: 'rpg_2',
        hostAgent: 'snarl',
        phase: 'playing',
        players: ['snarl', 'swoop'],
      })

      vi.setSystemTime(base)
      await registerGame(db, {
        id: 'catan_3',
        hostAgent: 'grimlock',
        phase: 'playing',
        players: ['grimlock', 'slag'],
      })

      const env = createHealthEnv({ DB: db })
      const { default: worker } = await import('./index')

      const page1Res = await worker.fetch(
        new Request('https://example.com/games?all=true&limit=2', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(page1Res.status).toBe(200)
      const page1 = await page1Res.json()
      expect(page1.games).toHaveLength(2)
      expect(typeof page1.nextCursor).toBe('string')

      const page2Res = await worker.fetch(
        new Request(`https://example.com/games?all=true&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(page2Res.status).toBe(200)
      const page2 = await page2Res.json()
      expect(page2.games).toHaveLength(1)

      const page1Ids = (page1.games as any[]).map((g) => g.id)
      const page2Ids = (page2.games as any[]).map((g) => g.id)
      expect(new Set([...page1Ids, ...page2Ids])).toEqual(new Set(['catan_3', 'rpg_2', 'catan_1']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /games/:id only serves catan instances (alias compatibility)', async () => {
    const db = new D1MockDatabase()

    const catan = createGame('catan_1', ['grimlock', 'slag'])
    await registerGame(db, {
      id: catan.id,
      hostAgent: 'grimlock',
      phase: catan.phase,
      players: ['grimlock', 'slag'],
      state: catan as unknown as Record<string, unknown>,
    })
    await registerGame(db, {
      id: 'rpg_1',
      hostAgent: 'snarl',
      phase: 'playing',
      players: ['snarl', 'swoop'],
      state: { id: 'rpg_1', phase: 'playing' },
    })

    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const nonCatanRes = await worker.fetch(
      new Request('https://example.com/games/rpg_1', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(nonCatanRes.status).toBe(404)
    await expect(nonCatanRes.json()).resolves.toMatchObject({ error: 'Use /environments/:id for non-catan games' })

    const catanRes = await worker.fetch(
      new Request('https://example.com/games/catan_1', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(catanRes.status).toBe(200)
    await expect(catanRes.json()).resolves.toMatchObject({
      id: 'catan_1',
      type: 'catan',
    })
  })
})

describe('admin analytics endpoint', () => {
  it('GET /admin/analytics returns per-agent analytics shape', async () => {
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    await registerAgent(db, { name: 'bob', did: 'did:cf:bob' })

    const env = createHealthEnv({
      DB: db,
      AGENTS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: unknown) => {
          const name = String(id)
          return {
            fetch: vi.fn(async (req: Request) => {
              const url = new URL(req.url)
              if (url.pathname === '/__internal/analytics') {
                if (name === 'alice') {
                  return Response.json({
                    loopCount: 5,
                    consecutiveErrors: 1,
                    alarmMode: 'think',
                    actionOutcomes: [{ tool: 'remember', success: true, timestamp: 1700000000000 }],
                    extensionMetrics: [{ name: 'ext', totalCalls: 1, successCalls: 1, failedCalls: 0, lastUsed: 1700000000000 }],
                    lastReflection: { text: 'ok' },
                  })
                }
                // Simulate older DOs / missing keys.
                return Response.json({})
              }
              return new Response('Not found', { status: 404 })
            }),
          }
        }),
      },
    })

    const { default: worker } = await import('./index')

    const res = await worker.fetch(
      new Request('https://example.com/admin/analytics', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      agents: expect.any(Array),
    })

    const agents = (body as any).agents as any[]
    const alice = agents.find((a) => a.name === 'alice')
    const bob = agents.find((a) => a.name === 'bob')

    expect(alice).toMatchObject({
      name: 'alice',
      loopCount: 5,
      errors: 1,
      mode: 'think',
      recentActions: expect.any(Array),
      extensions: expect.any(Array),
    })

    expect(bob).toMatchObject({
      name: 'bob',
      loopCount: null,
      errors: null,
      mode: null,
      recentActions: [],
      extensions: [],
      lastReflection: null,
    })
  })
})

describe('agent internal endpoints', () => {
  it('requires admin auth for GET /agents/:name/__internal/analytics (should not be publicly readable)', async () => {
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })

    const agentFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/__internal/analytics')) {
        return Response.json({ loopCount: 123 })
      }
      return new Response('ok')
    })

    const env = createHealthEnv({
      DB: db,
      AGENTS: createAgentNamespace(agentFetch),
    })

    const { default: worker } = await import('./index')

    const res = await worker.fetch(new Request('https://example.com/agents/alice/__internal/analytics'), env)

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorized' })
    expect(agentFetch).not.toHaveBeenCalled()
  })
})
