import { describe, expect, it, vi } from 'vitest'

import { LeaseManager, SandboxBudgetExceededError } from './lease-manager'

type SqlMock = {
  match: RegExp
  result: unknown
}

type DbCall = {
  sql: string
  method: 'run' | 'all' | 'first'
  args: unknown[]
}

function createDbMocks(options?: {
  allMocks?: SqlMock[]
  firstMocks?: SqlMock[]
}) {
  const calls: DbCall[] = []

  const db = {
    prepare: vi.fn((sql: string) => {
      let boundArgs: unknown[] = []
      const statement = {
        bind: vi.fn((...args: unknown[]) => {
          boundArgs = args
          return statement
        }),
        run: vi.fn(async () => {
          calls.push({ sql, method: 'run', args: [...boundArgs] })
          return { success: true }
        }),
        all: vi.fn(async () => {
          calls.push({ sql, method: 'all', args: [...boundArgs] })
          const mock = options?.allMocks?.find((entry) => entry.match.test(sql))
          return (mock?.result as { results: unknown[] }) ?? { results: [] }
        }),
        first: vi.fn(async () => {
          calls.push({ sql, method: 'first', args: [...boundArgs] })
          const mock = options?.firstMocks?.find((entry) => entry.match.test(sql))
          return (mock?.result as unknown) ?? null
        }),
      }
      return statement
    }),
  } as unknown as D1Database

  return {
    db,
    calls,
  }
}

describe('LeaseManager', () => {
  it('acquire inserts or replaces active lease with computed expiry', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { db, calls } = createDbMocks()
    const manager = new LeaseManager(db)

    await manager.acquire('grimlock', 'env-1', 'sandbox-1', 5_000)

    expect((db as any).prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sandbox_leases')
    )

    const insertCall = calls.find((entry) => /insert or replace into sandbox_leases/i.test(entry.sql))
    expect(insertCall).toBeDefined()
    expect(insertCall?.args).toEqual([
      'grimlock:env-1',
      'grimlock',
      'env-1',
      'sandbox-1',
      1_000,
      6_000,
      1_000,
      '[]',
    ])

    nowSpy.mockRestore()
  })

  it('acquire throws SandboxBudgetExceededError and skips insert when monthly budget is exceeded', async () => {
    const now = new Date('2026-02-17T12:00:00.000Z').getTime()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const monthStart = new Date('2026-02-01T00:00:00.000Z').getTime()

    const { db, calls } = createDbMocks({
      firstMocks: [
        {
          match: /select default_budget_hours, agent_budgets_json from sandbox_admin_config/i,
          result: { default_budget_hours: 1, agent_budgets_json: null },
        },
      ],
      allMocks: [
        {
          match: /select agent_name, leased_at, last_activity_at, status from sandbox_leases where agent_name = \?/i,
          result: {
            results: [
              {
                agent_name: 'grimlock',
                leased_at: monthStart + 1_000,
                last_activity_at: monthStart + 2 * 60 * 60 * 1000,
                status: 'destroyed',
              },
            ],
          },
        },
      ],
    })
    const manager = new LeaseManager(db)

    await expect(manager.acquire('grimlock', 'env-1', 'sandbox-1', 5_000)).rejects.toBeInstanceOf(
      SandboxBudgetExceededError
    )

    const insertCall = calls.find((entry) => /insert or replace into sandbox_leases/i.test(entry.sql))
    expect(insertCall).toBeUndefined()
    nowSpy.mockRestore()
  })

  it('renew updates activity and extends expiry using default ttl', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const { db, calls } = createDbMocks()
    const manager = new LeaseManager(db)

    await manager.renew('grimlock', 'env-1')

    const renewCall = calls.find((entry) => /update sandbox_leases set last_activity_at = \?, expires_at = \?/i.test(entry.sql))
    expect(renewCall).toBeDefined()
    expect(renewCall?.args).toEqual([2_000, 2_000 + 14_400_000, 'grimlock:env-1'])

    nowSpy.mockRestore()
  })

  it('release marks lease as destroyed for the composite id', async () => {
    const { db, calls } = createDbMocks()
    const manager = new LeaseManager(db)

    await manager.release('grimlock', 'env-1')

    const releaseCall = calls.find((entry) => /update sandbox_leases set status = 'destroyed' where id = \?/i.test(entry.sql))
    expect(releaseCall).toBeDefined()
    expect(releaseCall?.args).toEqual(['grimlock:env-1'])
  })

  it('getExpiredLeases returns active expired lease rows', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    const expectedRows = [{ agent_name: 'grimlock', environment_id: 'env-1', sandbox_id: 'sandbox-1' }]
    const { db, calls } = createDbMocks({
      allMocks: [
        {
          match: /select agent_name, environment_id, sandbox_id from sandbox_leases where status = 'active' and expires_at < \?/i,
          result: { results: expectedRows },
        },
      ],
    })
    const manager = new LeaseManager(db)

    const result = await manager.getExpiredLeases()

    const expiredCall = calls.find((entry) => /select agent_name, environment_id, sandbox_id from sandbox_leases where status = 'active' and expires_at < \?/i.test(entry.sql))
    expect(expiredCall).toBeDefined()
    expect(result).toEqual(expectedRows)

    nowSpy.mockRestore()
  })

  it('getAgentLease fetches lease by composite id', async () => {
    const expectedLease = {
      id: 'grimlock:env-1',
      agent_name: 'grimlock',
      environment_id: 'env-1',
      sandbox_id: 'sandbox-1',
      status: 'active',
    }
    const { db, calls } = createDbMocks({
      firstMocks: [{ match: /select \* from sandbox_leases where id = \?/i, result: expectedLease }],
    })
    const manager = new LeaseManager(db)

    const result = await manager.getAgentLease('grimlock', 'env-1')

    const firstCall = calls.find((entry) => /select \* from sandbox_leases where id = \?/i.test(entry.sql))
    expect(firstCall).toBeDefined()
    expect(firstCall?.args).toEqual(['grimlock:env-1'])
    expect(result).toEqual(expectedLease)
  })

  it('getCostBreakdown aggregates active hours per agent and totals using basic instance pricing', async () => {
    const now = new Date('2026-02-17T12:00:00.000Z').getTime()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const monthStart = new Date('2026-02-01T00:00:00.000Z').getTime()

    const { db } = createDbMocks({
      allMocks: [
        {
          match: /select agent_name, leased_at, last_activity_at, status from sandbox_leases/i,
          result: {
            results: [
              {
                agent_name: 'grimlock',
                leased_at: monthStart + 1_000,
                last_activity_at: monthStart + 3 * 60 * 60 * 1000,
                status: 'destroyed',
              },
              {
                agent_name: 'slag',
                leased_at: now - 2 * 60 * 60 * 1000,
                last_activity_at: now - 1 * 60 * 60 * 1000,
                status: 'active',
              },
            ],
          },
        },
      ],
    })
    const manager = new LeaseManager(db)

    const result = await manager.getCostBreakdown()

    expect(result.agents).toHaveLength(2)
    const grimlock = result.agents.find((entry) => entry.name === 'grimlock')
    const slag = result.agents.find((entry) => entry.name === 'slag')
    expect(grimlock?.activeHours).toBeCloseTo(3, 3)
    expect(slag?.activeHours).toBeCloseTo(2, 3)
    expect(result.total.hours).toBeCloseTo(5, 3)
    expect(result.total.cost).toBeCloseTo(0.135, 4)
    nowSpy.mockRestore()
  })

  it('listLeases returns active and historical leases with computed uptime', async () => {
    const now = new Date('2026-02-17T12:00:00.000Z').getTime()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    const { db } = createDbMocks({
      allMocks: [
        {
          match: /select \* from sandbox_leases order by leased_at desc/i,
          result: {
            results: [
              {
                id: 'grimlock:env-active',
                agent_name: 'grimlock',
                environment_id: 'rpg_1',
                sandbox_id: 'sandbox-1',
                status: 'active',
                leased_at: now - 2 * 60 * 60 * 1000,
                last_activity_at: now - 1 * 60 * 60 * 1000,
                expires_at: now + 60 * 60 * 1000,
              },
              {
                id: 'slag:env-done',
                agent_name: 'slag',
                environment_id: 'catan_2',
                sandbox_id: 'sandbox-2',
                status: 'destroyed',
                leased_at: now - 4 * 60 * 60 * 1000,
                last_activity_at: now - 90 * 60 * 1000,
                expires_at: now - 80 * 60 * 1000,
              },
            ],
          },
        },
      ],
    })
    const manager = new LeaseManager(db)

    const leases = await manager.listLeases()

    expect(leases).toHaveLength(2)
    expect(leases[0]).toMatchObject({
      id: 'grimlock:env-active',
      status: 'active',
    })
    expect(leases[1]).toMatchObject({
      id: 'slag:env-done',
      status: 'destroyed',
    })
    expect(leases[0].uptimeMs).toBeCloseTo(2 * 60 * 60 * 1000, 0)
    expect(leases[1].uptimeMs).toBeCloseTo(2.5 * 60 * 60 * 1000, 0)
    nowSpy.mockRestore()
  })
})
