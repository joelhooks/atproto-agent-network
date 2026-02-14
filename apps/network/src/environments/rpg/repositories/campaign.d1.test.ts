import { describe, expect, it } from 'vitest'

import { createGame } from '../../../games/rpg-engine'
import { D1CampaignRepository } from './campaign.d1'

type CampaignRow = {
  id: string
  name: string
  premise: string
  world_state: string
  story_arcs: string
  created_at: string
  updated_at: string
}

type EnvironmentRow = {
  id: string
  type: string
  state: string
  campaign_id: string | null
  adventure_number: number
  created_at: string
  updated_at: string
}

class CampaignMockStatement {
  constructor(
    private readonly db: CampaignMockDb,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): CampaignMockStatement {
    return new CampaignMockStatement(this.db, this.sql, params)
  }

  async run(): Promise<{ success: true }> {
    await this.db.run(this.sql, this.params)
    return { success: true }
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.params)
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.db.all<T>(this.sql, this.params)
  }
}

class CampaignMockDb {
  readonly campaigns = new Map<string, CampaignRow>()
  readonly environments = new Map<string, EnvironmentRow>()

  prepare(sql: string): CampaignMockStatement {
    return new CampaignMockStatement(this, sql)
  }

  seedEnvironment(row: Partial<EnvironmentRow> & Pick<EnvironmentRow, 'id' | 'state'>): void {
    const now = new Date().toISOString()
    this.environments.set(row.id, {
      id: row.id,
      type: row.type ?? 'rpg',
      state: row.state,
      campaign_id: row.campaign_id ?? null,
      adventure_number: row.adventure_number ?? 0,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    })
  }

  private normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim()
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = this.normalize(sql)
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
      const existing = this.environments.get(String(id))
      if (!existing) return
      existing.campaign_id = campaignId == null ? null : String(campaignId)
      existing.adventure_number = Number(adventureNumber ?? 0)
      existing.state = String(state ?? existing.state)
      existing.updated_at = now
      this.environments.set(existing.id, existing)
      return
    }

    throw new Error(`Unsupported SQL in CampaignMockDb.run: ${normalized}`)
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const normalized = this.normalize(sql)

    if (normalized.startsWith('select id, name, premise, world_state, story_arcs, created_at, updated_at from campaigns where id = ?')) {
      const row = this.campaigns.get(String(params[0]))
      return (row ?? null) as T | null
    }

    if (normalized.startsWith('select id, state from environments where id = ? and type =')) {
      const row = this.environments.get(String(params[0]))
      if (!row || row.type !== 'rpg') return null
      return ({ id: row.id, state: row.state } as unknown) as T
    }

    if (normalized.startsWith('select id from campaigns order by created_at desc limit 1')) {
      const latest = Array.from(this.campaigns.values())
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .at(0)
      return (latest ? { id: latest.id } : null) as T | null
    }

    throw new Error(`Unsupported SQL in CampaignMockDb.first: ${normalized}`)
  }

  async all<T>(_sql: string, _params: unknown[]): Promise<{ results: T[] }> {
    return { results: [] }
  }
}

describe('D1CampaignRepository', () => {
  it('creates, reads, and updates campaigns', async () => {
    const db = new CampaignMockDb()
    const repo = new D1CampaignRepository(db as unknown as D1Database)

    const created = await repo.create('Ironlands Saga', 'The Shadow Court rises')
    expect(created.name).toBe('Ironlands Saga')
    expect(created.storyArcs).toEqual([])
    expect(created.worldState).toEqual({ factions: [], locations: [], events: [] })

    const loaded = await repo.get(created.id)
    expect(loaded?.premise).toContain('Shadow Court')

    await repo.update(created.id, {
      premise: 'The Shadow Court fractures',
      adventureCount: 2,
      worldState: {
        factions: [{ id: 'f1', name: 'Iron Vanguard', disposition: 25, description: 'Local defenders' }],
        locations: [{ id: 'l1', name: 'Old Keep', description: 'A contested outpost' }],
        events: ['The keep walls cracked under siege.'],
      },
      storyArcs: [
        {
          id: 'arc-1',
          name: 'Opening Siege',
          status: 'active',
          plotPoints: [{ id: 'pp-1', description: 'Secure the eastern gate', resolved: false }],
        },
      ],
    })

    const reloaded = await repo.get(created.id)
    expect(reloaded?.premise).toContain('fractures')
    expect(reloaded?.adventureCount).toBe(2)
    expect(reloaded?.storyArcs).toHaveLength(1)
    expect(reloaded?.worldState.locations[0]?.name).toBe('Old Keep')
  })

  it('links an adventure to a campaign and increments adventure number', async () => {
    const db = new CampaignMockDb()
    const repo = new D1CampaignRepository(db as unknown as D1Database)

    const campaign = await repo.create('Ashen Crown', 'A fractured crown ignites war')
    const game = createGame({ id: 'rpg_link_target', players: ['slag', 'snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })
    db.seedEnvironment({ id: game.id, state: JSON.stringify(game), type: 'rpg' })

    const adventureNumber = await repo.linkAdventure(game.id, campaign.id)
    expect(adventureNumber).toBe(1)

    const storedEnv = db.environments.get(game.id)
    expect(storedEnv?.campaign_id).toBe(campaign.id)
    expect(storedEnv?.adventure_number).toBe(1)

    const storedCampaign = await repo.get(campaign.id)
    expect(storedCampaign?.adventureCount).toBe(1)
  })

  it('finds latest campaign id and returns null for missing campaigns', async () => {
    const db = new CampaignMockDb()
    const repo = new D1CampaignRepository(db as unknown as D1Database)

    await expect(repo.get('campaign_missing')).resolves.toBeNull()
    await expect(repo.findLatest()).resolves.toBeNull()

    const first = await repo.create('First', 'One')
    const second = await repo.create('Second', 'Two')

    const latest = await repo.findLatest()
    expect([first.id, second.id]).toContain(latest?.id)
  })
})
