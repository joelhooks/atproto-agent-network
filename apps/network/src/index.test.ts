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

describe('network worker lexicon validation', () => {
  it('rejects invalid lexicon records at the worker boundary with 400 + issues', async () => {
    const agentFetch = vi.fn(async () => new Response('ok'))
    const env = {
      AGENTS: createAgentNamespace(agentFetch),
    } as never

    const { default: worker } = await import('./index')

    const invalidRecord = {
      $type: 'agent.memory.note',
      createdAt: new Date().toISOString(),
    }

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
    } as never

    const { default: worker } = await import('./index')

    const response = await worker.fetch(
      new Request('https://example.com/agents/alice/identity'),
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
