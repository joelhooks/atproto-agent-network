import { describe, expect, it, vi } from 'vitest'

import { runCli } from './index'

describe('anet CLI sandbox commands', () => {
  it('anet sandbox calls /admin/sandbox/leases', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        leases: [{ id: 'grimlock:rpg_1', status: 'active' }],
      })
    )
    const out: string[] = []
    const err: string[] = []

    const code = await runCli(['sandbox'], {
      fetch: fetchMock as unknown as typeof fetch,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      env: {
        ANET_API: 'https://example.com',
        ANET_TOKEN: 'test-token',
      },
    })

    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/admin/sandbox/leases',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    )
    expect(out.join('\n')).toContain('grimlock:rpg_1')
    expect(err).toEqual([])
  })

  it('anet sandbox costs calls /admin/sandbox/costs', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        agents: [{ name: 'grimlock', activeHours: 2, estimatedCost: 0.054 }],
        total: { hours: 2, cost: 0.054 },
      })
    )
    const out: string[] = []

    const code = await runCli(['sandbox', 'costs'], {
      fetch: fetchMock as unknown as typeof fetch,
      stdout: (line) => out.push(line),
      stderr: () => {},
      env: {
        ANET_API: 'https://example.com',
        ANET_TOKEN: 'test-token',
      },
    })

    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/admin/sandbox/costs',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    )
    expect(out.join('\n')).toContain('grimlock')
    expect(out.join('\n')).toContain('0.054')
  })
})
