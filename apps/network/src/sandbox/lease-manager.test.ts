import { describe, expect, it, vi } from 'vitest'

import { LeaseManager } from './lease-manager'

type MockStatement = {
  bind: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
}

function createDbMocks(options?: {
  allResult?: { results: unknown[] }
  firstResult?: unknown
}) {
  let boundArgs: unknown[] = []

  const statement: MockStatement = {
    bind: vi.fn((...args: unknown[]) => {
      boundArgs = args
      return statement
    }),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue(options?.allResult ?? { results: [] }),
    first: vi.fn().mockResolvedValue(options?.firstResult ?? null),
  }

  const db = {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database

  return {
    db,
    statement,
    getBoundArgs: () => boundArgs,
  }
}

describe('LeaseManager', () => {
  it('acquire inserts or replaces active lease with computed expiry', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { db, statement, getBoundArgs } = createDbMocks()
    const manager = new LeaseManager(db)

    await manager.acquire('grimlock', 'env-1', 'sandbox-1', 5_000)

    expect((db as any).prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO sandbox_leases')
    )
    expect(statement.run).toHaveBeenCalledTimes(1)
    expect(getBoundArgs()).toEqual(['grimlock:env-1', 'grimlock', 'env-1', 'sandbox-1', 1_000, 6_000, 1_000])

    nowSpy.mockRestore()
  })

  it('renew updates activity and extends expiry using default ttl', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const { db, statement, getBoundArgs } = createDbMocks()
    const manager = new LeaseManager(db)

    await manager.renew('grimlock', 'env-1')

    expect((db as any).prepare).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sandbox_leases SET last_activity_at = ?, expires_at = ? WHERE id = ? AND status = 'active'")
    )
    expect(statement.run).toHaveBeenCalledTimes(1)
    expect(getBoundArgs()).toEqual([2_000, 2_000 + 14_400_000, 'grimlock:env-1'])

    nowSpy.mockRestore()
  })

  it('release marks lease as destroyed for the composite id', async () => {
    const { db, statement, getBoundArgs } = createDbMocks()
    const manager = new LeaseManager(db)

    await manager.release('grimlock', 'env-1')

    expect((db as any).prepare).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sandbox_leases SET status = 'destroyed' WHERE id = ?")
    )
    expect(statement.run).toHaveBeenCalledTimes(1)
    expect(getBoundArgs()).toEqual(['grimlock:env-1'])
  })

  it('getExpiredLeases returns active expired lease rows', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    const expectedRows = [{ agent_name: 'grimlock', environment_id: 'env-1', sandbox_id: 'sandbox-1' }]
    const { db, statement } = createDbMocks({ allResult: { results: expectedRows } })
    const manager = new LeaseManager(db)

    const result = await manager.getExpiredLeases()

    expect((db as any).prepare).toHaveBeenCalledWith(
      expect.stringContaining("SELECT agent_name, environment_id, sandbox_id FROM sandbox_leases WHERE status = 'active' AND expires_at < ?")
    )
    expect(statement.all).toHaveBeenCalledTimes(1)
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
    const { db, statement, getBoundArgs } = createDbMocks({ firstResult: expectedLease })
    const manager = new LeaseManager(db)

    const result = await manager.getAgentLease('grimlock', 'env-1')

    expect((db as any).prepare).toHaveBeenCalledWith('SELECT * FROM sandbox_leases WHERE id = ?')
    expect(statement.first).toHaveBeenCalledTimes(1)
    expect(getBoundArgs()).toEqual(['grimlock:env-1'])
    expect(result).toEqual(expectedLease)
  })
})
