import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../packages/core/src/d1-mock'
import { createGame } from './games/catan'
import {
  DM_SKILL,
  HEALER_SKILL,
  MAGE_SKILL,
  PARTY_TACTICS,
  SCOUT_SKILL,
  WARRIOR_SKILL,
} from './environments/rpg-skills'

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
      "INSERT INTO environments (id, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
      .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(state), input.phase, input.winner, input.id)
      .run()
  }
}

type CampaignRow = {
  id: string
  name: string
  premise: string
  world_state: string
  story_arcs: string
  created_at: string
  updated_at: string
}

class CampaignAwareD1MockDatabase extends D1MockDatabase {
  readonly campaigns = new Map<string, CampaignRow>()

  private normalizeSql(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim()
  }

  override async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = this.normalizeSql(sql)
    const now = new Date().toISOString()

    if (normalized.startsWith('create table if not exists campaigns')) return

    if (normalized.startsWith('insert into campaigns')) {
      const [id, name, premise, worldState, storyArcs] = params
      this.campaigns.set(String(id), {
        id: String(id),
        name: String(name),
        premise: String(premise ?? ''),
        world_state: String(worldState ?? '{}'),
        story_arcs: String(storyArcs ?? '[]'),
        created_at: now,
        updated_at: now,
      })
      return
    }

    if (normalized.startsWith('update campaigns set')) {
      const [name, premise, worldState, storyArcs, id] = params
      const existing = this.campaigns.get(String(id))
      if (!existing) return

      existing.name = String(name ?? existing.name)
      existing.premise = String(premise ?? existing.premise)
      existing.world_state = String(worldState ?? existing.world_state)
      existing.story_arcs = String(storyArcs ?? existing.story_arcs)
      existing.updated_at = now
      this.campaigns.set(existing.id, existing)
      return
    }

    if (normalized.startsWith('update environments set campaign_id = ?')) {
      const [campaignId, adventureNumber, state, id] = params
      const existing = this.games.get(String(id))
      if (!existing) return

      ;(existing as Record<string, unknown>).campaign_id = campaignId == null ? null : String(campaignId)
      ;(existing as Record<string, unknown>).adventure_number = Number(adventureNumber ?? 0)
      existing.state = String(state ?? existing.state)
      existing.updated_at = now
      this.games.set(existing.id, existing)
      return
    }

    return super.run(sql, params)
  }

  override async all<T>(sql: string, params: unknown[]): Promise<{ results: T[] }> {
    const normalized = this.normalizeSql(sql)

    if (normalized.startsWith('select id, name, premise, world_state, story_arcs, created_at, updated_at from campaigns where id = ?')) {
      const row = this.campaigns.get(String(params[0]))
      return { results: row ? [row as T] : [] }
    }

    if (normalized.startsWith('select id from campaigns order by updated_at desc')) {
      const results = Array.from(this.campaigns.values())
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((row) => ({ id: row.id } as T))
      return { results }
    }

    return super.all<T>(sql, params)
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

  it('POST /environments creates a new instance and /games stays an alias', async () => {
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
    expect(gamesRes.headers.get('Deprecation')).toBe('true')
    const games = await gamesRes.json()
    expect(games.environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          type: 'catan',
        }),
      ])
    )
  })

  it('GET /environments?all=true returns all environment rows (not just catan)', async () => {
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
      new Request('https://example.com/environments?all=true', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'catan_1', type: 'catan' }),
        expect.objectContaining({ id: 'rpg_1', type: 'rpg' }),
      ])
    )
  })

  it('GET /games logs a deprecation warning for the legacy alias', async () => {
    const db = new D1MockDatabase()
    await registerGame(db, {
      id: 'catan_1',
      hostAgent: 'grimlock',
      phase: 'playing',
      players: ['grimlock', 'slag'],
      state: { id: 'catan_1', phase: 'playing' },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const env = createHealthEnv({ DB: db })
      const { default: worker } = await import('./index')

      const response = await worker.fetch(
        new Request('https://example.com/games', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Deprecation')).toBe('true')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/games'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('GET /environments includes active and recently finished (24h) by default', async () => {
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
        new Request('https://example.com/environments', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      const ids = (body.environments as any[]).map((g) => g.id)

      expect(ids).toEqual(expect.arrayContaining(['catan_active', 'rpg_finished_recent']))
      expect(ids).not.toContain('catan_finished_old')
      expect(ids).toContain('rpg_setup')
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /environments supports pagination via limit + cursor', async () => {
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
        new Request('https://example.com/environments?all=true&limit=2', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(page1Res.status).toBe(200)
      const page1 = await page1Res.json()
      expect(page1.environments).toHaveLength(2)
      expect(typeof page1.nextCursor).toBe('string')

      const page2Res = await worker.fetch(
        new Request(`https://example.com/environments?all=true&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

      expect(page2Res.status).toBe(200)
      const page2 = await page2Res.json()
      expect(page2.environments).toHaveLength(1)

      const page1Ids = (page1.environments as any[]).map((g) => g.id)
      const page2Ids = (page2.environments as any[]).map((g) => g.id)
      expect(new Set([...page1Ids, ...page2Ids])).toEqual(new Set(['catan_3', 'rpg_2', 'catan_1']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /environments/:id serves any environment and /games/:id is an alias', async () => {
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
      new Request('https://example.com/environments/rpg_1', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(nonCatanRes.status).toBe(200)
    await expect(nonCatanRes.json()).resolves.toMatchObject({ id: 'rpg_1', type: 'rpg' })

    const aliasRes = await worker.fetch(
      new Request('https://example.com/games/rpg_1', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(aliasRes.status).toBe(200)
    expect(aliasRes.headers.get('Deprecation')).toBe('true')
    await expect(aliasRes.json()).resolves.toMatchObject({ id: 'rpg_1', type: 'rpg' })
  })

  it('DELETE /environments/:id deletes rows and /games/:id stays an alias', async () => {
    const db = new D1MockDatabase()
    await registerGame(db, {
      id: 'rpg_1',
      hostAgent: 'snarl',
      phase: 'playing',
      players: ['snarl', 'swoop'],
      state: { id: 'rpg_1', phase: 'playing' },
    })
    await registerGame(db, {
      id: 'catan_1',
      hostAgent: 'grimlock',
      phase: 'playing',
      players: ['grimlock', 'slag'],
      state: { id: 'catan_1', phase: 'playing' },
    })

    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const deleteCanonical = await worker.fetch(
      new Request('https://example.com/environments/rpg_1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(deleteCanonical.status).toBe(200)
    await expect(deleteCanonical.json()).resolves.toMatchObject({ ok: true })

    const deleteAlias = await worker.fetch(
      new Request('https://example.com/games/catan_1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(deleteAlias.status).toBe(200)
    expect(deleteAlias.headers.get('Deprecation')).toBe('true')
    await expect(deleteAlias.json()).resolves.toMatchObject({ ok: true })
  })
})

describe('network worker campaign API', () => {
  it('requires admin auth for campaign routes', async () => {
    const db = new CampaignAwareD1MockDatabase()
    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const routes = [
      new Request('https://example.com/environments/rpg/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Auth Campaign' }),
      }),
      new Request('https://example.com/environments/rpg/campaign/campaign_missing'),
      new Request('https://example.com/environments/rpg/campaigns'),
      new Request('https://example.com/environments/rpg/campaign/campaign_missing/start-adventure', {
        method: 'POST',
      }),
    ]

    for (const request of routes) {
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(401)
    }
  })

  it('creates, fetches, and lists campaigns', async () => {
    const db = new CampaignAwareD1MockDatabase()
    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const createOne = await worker.fetch(
      new Request('https://example.com/environments/rpg/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ name: 'Ironlands Saga', premise: 'The Iron Court fractures at dawn.' }),
      }),
      env
    )
    expect(createOne.status).toBe(200)
    const campaignOne = await createOne.json() as any
    expect(campaignOne).toMatchObject({
      id: expect.stringMatching(/^campaign_/),
      name: 'Ironlands Saga',
      premise: 'The Iron Court fractures at dawn.',
      adventureCount: 0,
    })

    const createTwo = await worker.fetch(
      new Request('https://example.com/environments/rpg/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ name: 'Stormwatch', premise: 'A storm cult gathers relics.' }),
      }),
      env
    )
    expect(createTwo.status).toBe(200)
    const campaignTwo = await createTwo.json() as any

    const getResponse = await worker.fetch(
      new Request(`https://example.com/environments/rpg/campaign/${campaignOne.id}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(getResponse.status).toBe(200)
    await expect(getResponse.json()).resolves.toMatchObject({
      id: campaignOne.id,
      name: 'Ironlands Saga',
      premise: 'The Iron Court fractures at dawn.',
    })

    const listResponse = await worker.fetch(
      new Request('https://example.com/environments/rpg/campaigns', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(listResponse.status).toBe(200)
    const listBody = await listResponse.json() as any
    expect(listBody.campaigns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: campaignOne.id, name: 'Ironlands Saga' }),
        expect.objectContaining({ id: campaignTwo.id, name: 'Stormwatch' }),
      ])
    )
  })

  it('starts a campaign adventure and links the created RPG environment', async () => {
    const db = new CampaignAwareD1MockDatabase()
    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const createRes = await worker.fetch(
      new Request('https://example.com/environments/rpg/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ name: 'Ashen Frontier', premise: 'The dead roads are waking.' }),
      }),
      env
    )
    expect(createRes.status).toBe(200)
    const campaign = await createRes.json() as any

    const campaignRow = db.campaigns.get(String(campaign.id))
    expect(campaignRow).toBeDefined()
    if (campaignRow) {
      campaignRow.story_arcs = JSON.stringify([
        {
          id: 'arc_titan',
          name: 'The Waking Titan',
          status: 'active',
          plotPoints: [{ id: 'plot_gate', description: 'Seal the Titan gate', resolved: false }],
        },
      ])
      db.campaigns.set(campaignRow.id, campaignRow)
    }

    const startRes = await worker.fetch(
      new Request(`https://example.com/environments/rpg/campaign/${campaign.id}/start-adventure`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(startRes.status).toBe(200)
    const started = await startRes.json() as any
    expect(started).toMatchObject({
      id: expect.stringMatching(/^rpg_/),
      type: 'rpg',
      phase: 'playing',
      campaignId: campaign.id,
      adventureNumber: 1,
    })

    const createdRow = await db
      .prepare('SELECT * FROM environments WHERE id = ?')
      .bind(started.id)
      .first<{ state: string }>()
    expect(createdRow).not.toBeNull()
    const state = JSON.parse(String(createdRow?.state ?? '{}')) as any
    expect(state.phase).toBe('playing')
    expect(state.mode).toBe('exploring')
    expect(state.currentPlayer).toBe('grimlock')
    expect(state.campaignId).toBe(campaign.id)
    expect(state.campaignAdventureNumber).toBe(1)
    expect(state.theme?.name).toContain('The Waking Titan')
    expect(state.theme?.backstory).toContain('The dead roads are waking.')
    expect(state.campaignLog).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Current objective: The Waking Titan'),
      ])
    )

    const campaignAfter = await worker.fetch(
      new Request(`https://example.com/environments/rpg/campaign/${campaign.id}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(campaignAfter.status).toBe(200)
    await expect(campaignAfter.json()).resolves.toMatchObject({
      id: campaign.id,
      adventureCount: 1,
    })
  })

  it('returns 404 when campaign does not exist', async () => {
    const db = new CampaignAwareD1MockDatabase()
    const env = createHealthEnv({ DB: db })
    const { default: worker } = await import('./index')

    const getRes = await worker.fetch(
      new Request('https://example.com/environments/rpg/campaign/campaign_missing', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(getRes.status).toBe(404)
    await expect(getRes.json()).resolves.toMatchObject({ error: 'Campaign not found' })

    const startRes = await worker.fetch(
      new Request('https://example.com/environments/rpg/campaign/campaign_missing/start-adventure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(startRes.status).toBe(404)
    await expect(startRes.json()).resolves.toMatchObject({ error: 'Campaign not found' })
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

describe('admin seed skills endpoint', () => {
  it('POST /admin/seed-skills seeds RPG skills into agent DO storage and remains idempotent', async () => {
    type SeedCall = {
      agent: string
      pathname: string
      method: string
      body: Record<string, unknown> | null
    }

    const calls: SeedCall[] = []
    const env = createHealthEnv({
      AGENTS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: unknown) => {
          const agent = String(id)
          return {
            fetch: vi.fn(async (req: Request) => {
              const pathname = new URL(req.url).pathname
              const body = await req.json().catch(() => null)
              calls.push({ agent, pathname, method: req.method, body })
              return Response.json({ ok: true })
            }),
          }
        }),
      },
    })

    const expectedPayloadByPath = new Map<string, Record<string, unknown>>([
      [
        '/agents/grimlock/skills/rpg/gm',
        {
          id: 'skill:rpg:gm',
          name: 'RPG GM',
          description: 'Default GM skill for the RPG environment.',
          content: DM_SKILL,
          version: '1.0.0',
        },
      ],
      [
        '/agents/slag/skills/rpg/warrior',
        {
          id: 'skill:rpg:warrior',
          name: 'RPG Warrior',
          description: 'Default Warrior skill for the RPG environment.',
          content: WARRIOR_SKILL,
          version: '1.0.0',
        },
      ],
      [
        '/agents/snarl/skills/rpg/scout',
        {
          id: 'skill:rpg:scout',
          name: 'RPG Scout',
          description: 'Default Scout skill for the RPG environment.',
          content: SCOUT_SKILL,
          version: '1.0.0',
        },
      ],
      [
        '/agents/swoop/skills/rpg/mage',
        {
          id: 'skill:rpg:mage',
          name: 'RPG Mage',
          description: 'Default Mage skill for the RPG environment.',
          content: MAGE_SKILL,
          version: '1.0.0',
        },
      ],
      [
        '/agents/sludge/skills/rpg/healer',
        {
          id: 'skill:rpg:healer',
          name: 'RPG Healer',
          description: 'Default Healer skill for the RPG environment.',
          content: HEALER_SKILL,
          version: '1.0.0',
        },
      ],
      [
        '/agents/sludge/skills/rpg/player',
        {
          id: 'skill:rpg:player',
          name: 'RPG Player',
          description: 'Shared player coordination skill for RPG agents.',
          content: PARTY_TACTICS,
          version: '1.0.0',
        },
      ],
    ])

    const { default: worker } = await import('./index')
    const sendSeed = async () =>
      worker.fetch(
        new Request('https://example.com/admin/seed-skills', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        env
      )

    const first = await sendSeed()
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      seeded: expectedPayloadByPath.size,
    })

    const second = await sendSeed()
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      seeded: expectedPayloadByPath.size,
    })

    expect(calls).toHaveLength(expectedPayloadByPath.size * 2)

    for (const call of calls) {
      expect(call.method).toBe('PUT')
      const expected = expectedPayloadByPath.get(call.pathname)
      expect(expected).toBeDefined()
      expect(call.body).toMatchObject(expected!)
    }
  })
})

describe('admin observability endpoints', () => {
  it('GET /admin/errors aggregates agent errors by category and sorts groups by recency', async () => {
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })
    await registerAgent(db, { name: 'bob', did: 'did:cf:bob' })
    await registerAgent(db, { name: 'charlie', did: 'did:cf:charlie' })

    const errorByAgent: Record<string, unknown> = {
      alice: {
        consecutiveErrors: 2,
        lastError: {
          ts: 1_700_000_002_000,
          category: 'transient',
          streak: 2,
          backoffMs: 30_000,
          lastPhase: 'think',
          lastMessage: 'rate limited',
        },
      },
      bob: {
        consecutiveErrors: 1,
        lastError: {
          ts: 1_700_000_001_000,
          category: 'persistent',
          streak: 1,
          backoffMs: 60_000,
          lastPhase: 'config',
          lastMessage: 'invalid model',
        },
      },
      charlie: {
        consecutiveErrors: 4,
        lastError: {
          ts: 1_700_000_003_000,
          category: 'transient',
          streak: 4,
          backoffMs: 60_000,
          lastPhase: 'act',
          lastMessage: 'tool timed out',
        },
      },
    }

    const env = createHealthEnv({
      DB: db,
      AGENTS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: unknown) => {
          const name = String(id)
          return {
            fetch: vi.fn(async (req: Request) => {
              const url = new URL(req.url)
              if (url.pathname.endsWith('/debug')) {
                return Response.json(errorByAgent[name] ?? { consecutiveErrors: 0, lastError: null })
              }
              return new Response('Not found', { status: 404 })
            }),
          }
        }),
      },
    })

    const { default: worker } = await import('./index')
    const res = await worker.fetch(
      new Request('https://example.com/admin/errors', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'transient', count: 2 }),
        expect.objectContaining({ category: 'persistent', count: 1 }),
      ])
    )
    expect(body.groups[0].category).toBe('transient')
    expect(body.groups[0].agents.map((agent: any) => agent.name)).toEqual(['charlie', 'alice'])
  })

  it('GET /admin/loops supports agent filtering and returns loop metrics', async () => {
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
              if (url.pathname.endsWith('/debug')) {
                if (name === 'alice') {
                  return Response.json({
                    consecutiveErrors: 2,
                    loopTranscript: {
                      startedAt: 1_700_000_000_000,
                      totalDurationMs: 42_000,
                      totalSteps: 2,
                      totalToolCalls: 3,
                      model: 'moonshotai/kimi-k2.5',
                      steps: [
                        {
                          step: 1,
                          timestamp: 1_700_000_000_000,
                          durationMs: 21_000,
                          toolResults: [{ name: 'remember', durationMs: 3_000, resultPreview: 'ok' }],
                        },
                        {
                          step: 2,
                          timestamp: 1_700_000_021_000,
                          durationMs: 21_000,
                          toolResults: [{ name: 'message', durationMs: 2_000, resultPreview: 'ok' }],
                        },
                      ],
                    },
                  })
                }
                return Response.json({ consecutiveErrors: 0, loopTranscript: null })
              }
              if (url.pathname.endsWith('/loop/status')) {
                return Response.json({
                  loopRunning: true,
                  loopCount: name === 'alice' ? 12 : 4,
                  nextAlarm: 1_700_000_060_000,
                })
              }
              if (url.pathname === '/__internal/analytics') {
                return Response.json({
                  actionOutcomes: name === 'alice'
                    ? [
                        { tool: 'remember', success: true, timestamp: 1_700_000_000_100 },
                        { tool: 'message', success: false, timestamp: 1_700_000_000_200 },
                      ]
                    : [{ tool: 'observe', success: true, timestamp: 1_700_000_000_300 }],
                })
              }
              return new Response('Not found', { status: 404 })
            }),
          }
        }),
      },
    })

    const { default: worker } = await import('./index')
    const res = await worker.fetch(
      new Request('https://example.com/admin/loops?agent=alice', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]).toMatchObject({
      name: 'alice',
      loopCount: 12,
      avgDurationMs: 42_000,
      toolCallsPerLoop: 3,
      successRate: 0.5,
      consecutiveErrors: 2,
    })
  })
})

describe('admin sandbox endpoints', () => {
  it('GET /admin/sandbox/costs returns per-agent cost breakdown', async () => {
    const leaseModule = await import('./sandbox/lease-manager')
    const costSpy = vi.spyOn(leaseModule.LeaseManager.prototype, 'getCostBreakdown').mockResolvedValue({
      agents: [
        { name: 'grimlock', activeHours: 12, estimatedCost: 0.324 },
        { name: 'slag', activeHours: 4, estimatedCost: 0.108 },
      ],
      total: { hours: 16, cost: 0.432 },
    })

    const env = createHealthEnv({ DB: new D1MockDatabase() })
    const { default: worker } = await import('./index')

    const res = await worker.fetch(
      new Request('https://example.com/admin/sandbox/costs', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ name: 'grimlock', activeHours: 12, estimatedCost: 0.324 }),
        expect.objectContaining({ name: 'slag', activeHours: 4, estimatedCost: 0.108 }),
      ]),
      total: { hours: 16, cost: 0.432 },
    })
    expect(costSpy).toHaveBeenCalledTimes(1)
    costSpy.mockRestore()
  })

  it('GET /admin/sandbox/leases includes active and destroyed leases for audit', async () => {
    const leaseModule = await import('./sandbox/lease-manager')
    const listSpy = vi.spyOn(leaseModule.LeaseManager.prototype, 'listLeases').mockResolvedValue([
      {
        id: 'grimlock:rpg_1',
        agentName: 'grimlock',
        environmentId: 'rpg_1',
        sandboxId: 'sandbox-rpg-1',
        status: 'active',
        leasedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_360_000,
        lastActivityAt: 1_700_000_100_000,
        uptimeMs: 600_000,
      },
      {
        id: 'slag:catan_1',
        agentName: 'slag',
        environmentId: 'catan_1',
        sandboxId: 'sandbox-catan-1',
        status: 'destroyed',
        leasedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_360_000,
        lastActivityAt: 1_700_000_050_000,
        uptimeMs: 50_000,
      },
    ] as any)

    const env = createHealthEnv({ DB: new D1MockDatabase() })
    const { default: worker } = await import('./index')

    const res = await worker.fetch(
      new Request('https://example.com/admin/sandbox/leases', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      leases: expect.arrayContaining([
        expect.objectContaining({
          id: 'grimlock:rpg_1',
          status: 'active',
          environmentType: 'rpg',
        }),
        expect.objectContaining({
          id: 'slag:catan_1',
          status: 'destroyed',
          environmentType: 'catan',
        }),
      ]),
    })
    expect(listSpy).toHaveBeenCalledTimes(1)
    listSpy.mockRestore()
  })

  it('PUT /admin/sandbox/config updates budget config and GET returns it', async () => {
    const leaseModule = await import('./sandbox/lease-manager')
    const setSpy = vi.spyOn(leaseModule.LeaseManager.prototype, 'setSandboxConfig').mockResolvedValue({
      defaultMonthlyHours: 40,
      agentBudgets: { grimlock: 20 },
    })
    const getSpy = vi.spyOn(leaseModule.LeaseManager.prototype, 'getSandboxConfig').mockResolvedValue({
      defaultMonthlyHours: 40,
      agentBudgets: { grimlock: 20 },
    })

    const env = createHealthEnv({ DB: new D1MockDatabase() })
    const { default: worker } = await import('./index')

    const putRes = await worker.fetch(
      new Request('https://example.com/admin/sandbox/config', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultMonthlyHours: 40, agentBudgets: { grimlock: 20 } }),
      }),
      env
    )
    expect(putRes.status).toBe(200)
    await expect(putRes.json()).resolves.toMatchObject({
      ok: true,
      config: { defaultMonthlyHours: 40, agentBudgets: { grimlock: 20 } },
    })

    const getRes = await worker.fetch(
      new Request('https://example.com/admin/sandbox/config', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )
    expect(getRes.status).toBe(200)
    await expect(getRes.json()).resolves.toMatchObject({
      config: { defaultMonthlyHours: 40, agentBudgets: { grimlock: 20 } },
    })

    expect(setSpy).toHaveBeenCalledWith({
      defaultMonthlyHours: 40,
      agentBudgets: { grimlock: 20 },
    })
    expect(getSpy).toHaveBeenCalledTimes(1)
    setSpy.mockRestore()
    getSpy.mockRestore()
  })
})

describe('agent trace endpoint', () => {
  it('GET /agents/:name/trace returns observe→think→act→reflect chain with timing', async () => {
    const db = new D1MockDatabase()
    await registerAgent(db, { name: 'alice', did: 'did:cf:alice' })

    const env = createHealthEnv({
      DB: db,
      AGENTS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          fetch: vi.fn(async (req: Request) => {
            const url = new URL(req.url)
            if (url.pathname.endsWith('/debug')) {
              return Response.json({
                loopTranscript: {
                  startedAt: 1_700_000_000_000,
                  totalDurationMs: 1_600,
                  totalSteps: 2,
                  totalToolCalls: 1,
                  model: 'moonshotai/kimi-k2.5',
                  steps: [
                    {
                      step: 1,
                      timestamp: 1_700_000_000_000,
                      durationMs: 1_000,
                      modelResponse: {
                        role: 'assistant',
                        content: 'calling remember',
                        toolCalls: [{ name: 'remember', arguments: { key: 'x' } }],
                      },
                      toolResults: [{ name: 'remember', durationMs: 200, resultPreview: '{"ok":true}' }],
                    },
                    {
                      step: 2,
                      timestamp: 1_700_000_001_000,
                      durationMs: 500,
                      modelResponse: { role: 'assistant', content: 'done' },
                    },
                  ],
                },
                lastReflection: { at: 1_700_000_002_000 },
              })
            }
            return new Response('Not found', { status: 404 })
          }),
        })),
      },
    })

    const { default: worker } = await import('./index')
    const res = await worker.fetch(
      new Request('https://example.com/agents/alice/trace', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({
      agent: 'alice',
      trace: expect.objectContaining({
        totalDurationMs: 1_600,
        chain: expect.arrayContaining([
          expect.objectContaining({ phase: 'observe' }),
          expect.objectContaining({ phase: 'think' }),
          expect.objectContaining({ phase: 'act' }),
          expect.objectContaining({ phase: 'reflect' }),
        ]),
      }),
    })

    const phases = body.trace.chain.map((step: any) => step.phase)
    expect(phases).toEqual(['observe', 'think', 'act', 'reflect'])
    expect(body.trace.chain.find((step: any) => step.phase === 'act')).toMatchObject({
      toolCalls: ['remember'],
      durationMs: 200,
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
