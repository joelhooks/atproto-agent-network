import { describe, expect, it, vi } from 'vitest'

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

describe('network worker lexicon validation', () => {
  it('rejects requests without a bearer token before routing', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(new Request('https://example.com/agents/alice/identity'), env)

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
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
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
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
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
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
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
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
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
      ADMIN_TOKEN,
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/identity', {
        headers: { Origin: 'https://app.example' },
      }),
      env
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('uses a configured CORS origin when provided', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
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
