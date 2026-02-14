import { generateTid } from '../../../../../../packages/core/src/identity'

import type {
  CampaignHubTown,
  CampaignHubTownLocation,
  CampaignNpc,
  CampaignPartyMemberSeed,
  CampaignRegionalLocation,
  CampaignState,
  CampaignVillain,
  StoryArc,
  WorldState,
} from '../../../games/rpg-engine'
import type { CampaignPatch, CampaignRepository, CreateCampaignOptions } from '../interfaces'

type CampaignRow = {
  id: string
  name: string
  premise: string | null
  world_state: string | null
  story_arcs: string | null
  created_at: string | null
  updated_at: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function buildDefaultWorldState(): WorldState {
  return {
    factions: [],
    locations: [],
    events: [],
  }
}

function buildDefaultStoryArcs(): StoryArc[] {
  return []
}

function parseCampaignAdventureCount(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return Math.max(0, Math.floor(fallback))
  return Math.max(0, Math.floor(n))
}

function normalizeCreateCampaignOptions(input?: CreateCampaignOptions | string): CreateCampaignOptions {
  if (typeof input === 'string') {
    const theme = input.trim()
    return theme ? { theme } : {}
  }

  if (!isRecord(input)) return {}

  const theme = typeof input.theme === 'string' ? input.theme.trim() : ''
  const party = Array.isArray(input.party) ? (input.party as CampaignPartyMemberSeed[]) : undefined
  const worldState = isRecord(input.worldState) ? (input.worldState as WorldState) : undefined
  const storyArcs = Array.isArray(input.storyArcs) ? (input.storyArcs as StoryArc[]) : undefined

  return {
    ...(theme ? { theme } : {}),
    ...(party ? { party } : {}),
    ...(worldState ? { worldState } : {}),
    ...(storyArcs ? { storyArcs } : {}),
  }
}

function normalizeDisposition(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(-100, Math.min(100, Math.floor(n)))
}

function normalizeCampaignNpc(raw: unknown): CampaignNpc | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const role = String(raw.role ?? '').trim() || 'Contact'
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  return { name, role, description }
}

function normalizeCampaignVillain(raw: unknown): CampaignVillain | undefined {
  if (!isRecord(raw)) return undefined
  const name = String(raw.name ?? '').trim()
  if (!name) return undefined
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  const objective = String(raw.objective ?? '').trim() || 'Advance a hidden agenda.'
  const lieutenants = Array.isArray(raw.lieutenants)
    ? raw.lieutenants
      .map((entry) => normalizeCampaignNpc(entry))
      .filter((entry): entry is CampaignNpc => Boolean(entry))
      .slice(0, 6)
    : []
  return { name, description, objective, lieutenants }
}

function normalizeCampaignHubTownLocation(raw: unknown): CampaignHubTownLocation | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  const shopkeeper = typeof raw.shopkeeper === 'string' ? raw.shopkeeper.trim() : ''
  const questGiver = typeof raw.questGiver === 'string' ? raw.questGiver.trim() : ''
  return {
    name,
    description,
    ...(shopkeeper ? { shopkeeper } : {}),
    ...(questGiver ? { questGiver } : {}),
  }
}

function normalizeCampaignHubTown(raw: unknown): CampaignHubTown | undefined {
  if (!isRecord(raw)) return undefined
  const name = String(raw.name ?? '').trim()
  if (!name) return undefined
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  const locations = Array.isArray(raw.locations)
    ? raw.locations
      .map((entry) => normalizeCampaignHubTownLocation(entry))
      .filter((entry): entry is CampaignHubTownLocation => Boolean(entry))
      .slice(0, 8)
    : []
  return { name, description, locations }
}

function normalizeCampaignRegionalLocation(raw: unknown): CampaignRegionalLocation | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  return { name, description }
}

function normalizeWorldState(raw: unknown, input: { adventureCount: number }): WorldState & { adventureCount: number } {
  const fallback = buildDefaultWorldState()
  const src = isRecord(raw) ? raw : {}

  const factions = Array.isArray(src.factions)
    ? src.factions
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = String(entry.name ?? '').trim()
        if (!name) return null
        const keyNpc = normalizeCampaignNpc(entry.keyNpc)
        return {
          id: String(entry.id ?? `faction_${generateTid()}`),
          name,
          disposition: normalizeDisposition(entry.disposition),
          description: String(entry.description ?? '').trim() || 'Unknown faction motives.',
          ...(keyNpc ? { keyNpc } : {}),
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : fallback.factions

  const locations = Array.isArray(src.locations)
    ? src.locations
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = String(entry.name ?? '').trim()
        if (!name) return null
        return {
          id: String(entry.id ?? `location_${generateTid()}`),
          name,
          description: String(entry.description ?? '').trim() || 'No details recorded.',
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : fallback.locations

  const events = Array.isArray(src.events)
    ? src.events
      .map((entry) => {
        if (typeof entry === 'string') {
          const text = entry.trim()
          return text ? text : null
        }
        if (!isRecord(entry)) return null
        const text = String(entry.description ?? '').trim()
        return text ? text : null
      })
      .filter((entry): entry is string => Boolean(entry))
    : fallback.events

  const alliedNpcs = Array.isArray(src.alliedNpcs)
    ? src.alliedNpcs
      .map((entry) => normalizeCampaignNpc(entry))
      .filter((entry): entry is CampaignNpc => Boolean(entry))
      .slice(0, 6)
    : []
  const centralVillain = normalizeCampaignVillain(src.centralVillain)
  const hubTown = normalizeCampaignHubTown(src.hubTown)
  const regionalMap = Array.isArray(src.regionalMap)
    ? src.regionalMap
      .map((entry) => normalizeCampaignRegionalLocation(entry))
      .filter((entry): entry is CampaignRegionalLocation => Boolean(entry))
      .slice(0, 16)
    : []

  const adventureCount = parseCampaignAdventureCount((src as Record<string, unknown>).adventureCount, input.adventureCount)

  return {
    factions,
    locations,
    events,
    ...(alliedNpcs.length ? { alliedNpcs } : {}),
    ...(centralVillain ? { centralVillain } : {}),
    ...(hubTown ? { hubTown } : {}),
    ...(regionalMap.length ? { regionalMap } : {}),
    adventureCount,
  }
}

function normalizeStoryArcs(raw: unknown): StoryArc[] {
  const fallback = buildDefaultStoryArcs()
  if (!Array.isArray(raw)) return fallback

  const arcs = raw
    .map((entry) => {
      if (!isRecord(entry)) return null
      const name = String(entry.name ?? '').trim()
      if (!name) return null
      const statusRaw = String(entry.status ?? '').trim()
      const status: StoryArc['status'] =
        statusRaw === 'seeded' ||
        statusRaw === 'active' ||
        statusRaw === 'climax' ||
        statusRaw === 'resolved' ||
        statusRaw === 'failed'
          ? statusRaw
          : 'active'

      const plotPoints = Array.isArray(entry.plotPoints)
        ? entry.plotPoints
          .map((point) => {
            if (!isRecord(point)) return null
            const description = String(point.description ?? '').trim()
            if (!description) return null
            const adventureId = typeof point.adventureId === 'string' ? point.adventureId : undefined
            return {
              id: String(point.id ?? `plot_${generateTid()}`),
              description,
              resolved: Boolean(point.resolved),
              ...(adventureId ? { adventureId } : {}),
            }
          })
          .filter((point): point is StoryArc['plotPoints'][number] => Boolean(point))
        : []

      return {
        id: String(entry.id ?? `arc_${generateTid()}`),
        name,
        status,
        plotPoints,
      }
    })
    .filter((arc): arc is StoryArc => Boolean(arc))

  return arcs.length > 0 ? arcs : fallback
}

function worldStateWithoutMeta(state: WorldState & { adventureCount: number }): WorldState {
  return {
    factions: state.factions,
    locations: state.locations,
    events: state.events,
    ...(Array.isArray(state.alliedNpcs) && state.alliedNpcs.length > 0 ? { alliedNpcs: state.alliedNpcs } : {}),
    ...(state.centralVillain ? { centralVillain: state.centralVillain } : {}),
    ...(state.hubTown ? { hubTown: state.hubTown } : {}),
    ...(Array.isArray(state.regionalMap) && state.regionalMap.length > 0 ? { regionalMap: state.regionalMap } : {}),
  }
}

function rowToCampaignState(row: CampaignRow): CampaignState {
  const name = String(row.name || 'Untitled Campaign').trim() || 'Untitled Campaign'
  const premise = String(row.premise || '').trim()

  const worldRaw = (() => {
    try {
      return row.world_state ? JSON.parse(row.world_state) : {}
    } catch {
      return {}
    }
  })()

  const arcsRaw = (() => {
    try {
      return row.story_arcs ? JSON.parse(row.story_arcs) : []
    } catch {
      return []
    }
  })()

  const worldStateWithMeta = normalizeWorldState(worldRaw, { adventureCount: 0 })
  const adventureCount = parseCampaignAdventureCount(worldStateWithMeta.adventureCount, 0)

  return {
    id: row.id,
    name,
    premise,
    worldState: worldStateWithoutMeta(worldStateWithMeta),
    storyArcs: normalizeStoryArcs(arcsRaw),
    adventureCount,
  }
}

function serializeWorldState(state: CampaignState): string {
  const payload: Record<string, unknown> = {
    factions: state.worldState.factions,
    locations: state.worldState.locations,
    events: state.worldState.events,
    adventureCount: state.adventureCount,
  }

  if (Array.isArray(state.worldState.alliedNpcs) && state.worldState.alliedNpcs.length > 0) {
    payload.alliedNpcs = state.worldState.alliedNpcs
  }
  if (state.worldState.centralVillain) payload.centralVillain = state.worldState.centralVillain
  if (state.worldState.hubTown) payload.hubTown = state.worldState.hubTown
  if (Array.isArray(state.worldState.regionalMap) && state.worldState.regionalMap.length > 0) {
    payload.regionalMap = state.worldState.regionalMap
  }

  return JSON.stringify(payload)
}

export class D1CampaignRepository implements CampaignRepository {
  constructor(private readonly db: D1Database) {}

  async get(id: string): Promise<CampaignState | null> {
    await this.ensureCampaignSchema()

    const row = await this.db
      .prepare('SELECT id, name, premise, world_state, story_arcs, created_at, updated_at FROM campaigns WHERE id = ?')
      .bind(id)
      .first<CampaignRow>()

    if (!row) return null
    return rowToCampaignState(row)
  }

  async create(name: string, premise: string, options?: CreateCampaignOptions): Promise<CampaignState> {
    await this.ensureCampaignSchema()

    const campaignOptions = normalizeCreateCampaignOptions(options)
    const safeName = String(name || '').trim() || 'Untitled Campaign'
    const safePremise = String(premise || '').trim()

    const worldState = campaignOptions.worldState
      ? worldStateWithoutMeta(normalizeWorldState(campaignOptions.worldState, { adventureCount: 0 }))
      : buildDefaultWorldState()

    const storyArcs = campaignOptions.storyArcs ? normalizeStoryArcs(campaignOptions.storyArcs) : buildDefaultStoryArcs()

    const campaign: CampaignState = {
      id: `campaign_${generateTid()}`,
      name: safeName,
      premise: safePremise,
      worldState,
      storyArcs,
      adventureCount: 0,
    }

    await this.db
      .prepare(
        "INSERT INTO campaigns (id, name, premise, world_state, story_arcs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(campaign.id, campaign.name, campaign.premise, serializeWorldState(campaign), JSON.stringify(campaign.storyArcs))
      .run()

    return campaign
  }

  async update(id: string, patch: CampaignPatch): Promise<void> {
    const current = await this.get(id)
    if (!current) return

    const next: CampaignState = {
      ...current,
      ...(typeof patch.name === 'string' ? { name: patch.name.trim() || current.name } : {}),
      ...(typeof patch.premise === 'string' ? { premise: patch.premise.trim() } : {}),
      worldState: patch.worldState
        ? worldStateWithoutMeta(
            normalizeWorldState(patch.worldState, {
              adventureCount: parseCampaignAdventureCount(patch.adventureCount, current.adventureCount),
            })
          )
        : { ...current.worldState },
      storyArcs: patch.storyArcs ? normalizeStoryArcs(patch.storyArcs) : current.storyArcs,
      adventureCount: parseCampaignAdventureCount(patch.adventureCount, current.adventureCount),
    }

    await this.db
      .prepare("UPDATE campaigns SET name = ?, premise = ?, world_state = ?, story_arcs = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(next.name, next.premise, serializeWorldState(next), JSON.stringify(next.storyArcs), id)
      .run()
  }

  async linkAdventure(envId: string, campaignId: string): Promise<number> {
    await this.ensureCampaignSchema()

    const campaign = await this.get(campaignId)
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

    const row = await this.db
      .prepare("SELECT id, state FROM environments WHERE id = ? AND type = 'rpg'")
      .bind(envId)
      .first<{ id: string; state: string }>()

    if (!row) throw new Error(`Adventure ${envId} not found`)

    const adventureNumber = Math.max(1, campaign.adventureCount + 1)
    const nextState = (() => {
      try {
        const parsed = JSON.parse(row.state)
        if (isRecord(parsed)) {
          parsed.campaignId = campaign.id
          parsed.campaignAdventureNumber = adventureNumber
        }
        return JSON.stringify(parsed)
      } catch {
        return row.state
      }
    })()

    await this.db
      .prepare("UPDATE environments SET campaign_id = ?, adventure_number = ?, state = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(campaign.id, adventureNumber, nextState, envId)
      .run()

    await this.update(campaign.id, { adventureCount: adventureNumber })
    return adventureNumber
  }

  async findLatest(): Promise<{ id: string } | null> {
    await this.ensureCampaignSchema()

    const row = await this.db.prepare('SELECT id FROM campaigns ORDER BY created_at DESC LIMIT 1').first<{ id: string }>()
    return row?.id ? { id: row.id } : null
  }

  private async ensureCampaignSchema(): Promise<void> {
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS campaigns (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          premise TEXT DEFAULT '',
          world_state TEXT DEFAULT '{}',
          story_arcs TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
      )
      .run()
      .catch(() => undefined)
  }
}
