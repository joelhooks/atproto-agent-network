import type { PersistentCharacter } from '@atproto-agent/core'

import type {
  CampaignPatch,
  CampaignRepository,
  CharacterRepository,
  CreateCampaignOptions,
  GameCreateMeta,
  GameStateRepository,
  GameStateRow,
} from '../../interfaces'
import type { CampaignState, RpgGameState } from '../../../../games/rpg-engine'

function deepClone<T>(value: T): T {
  return structuredClone(value)
}

function defaultWorldState() {
  return { factions: [], locations: [], events: [] }
}

function winnerFromGame(game: RpgGameState): string | null {
  const winner = (game as Record<string, unknown>).winner
  return typeof winner === 'string' ? winner : null
}

export class InMemoryGameStateRepository implements GameStateRepository {
  readonly rows = new Map<string, GameStateRow>()

  async findActiveForAgent(agentName: string): Promise<GameStateRow | null> {
    const needle = agentName.trim()
    if (!needle) return null

    for (const row of this.rows.values()) {
      if (row.type !== 'rpg') continue
      if (!['playing', 'setup', 'hub_town'].includes(String(row.phase ?? ''))) continue
      const players = Array.isArray(row.players) ? row.players : []
      if (players.includes(needle)) return deepClone(row)
    }

    for (const row of this.rows.values()) {
      if (row.type !== 'rpg') continue
      if (!['playing', 'setup', 'hub_town'].includes(String(row.phase ?? ''))) continue
      if (row.hostAgent === needle) return deepClone(row)
    }

    return null
  }

  async findWhereItsMyTurn(agentName: string): Promise<GameStateRow | null> {
    const needle = agentName.trim()
    if (!needle) return null

    for (const row of this.rows.values()) {
      if (row.type !== 'rpg') continue
      if (!['playing', 'setup', 'hub_town'].includes(String(row.phase ?? ''))) continue
      if (row.game.currentPlayer === needle) return deepClone(row)
    }

    return null
  }

  async findJoinable(exclude: string, limit = 5): Promise<GameStateRow[]> {
    const needle = exclude.trim()
    const out: GameStateRow[] = []

    for (const row of this.rows.values()) {
      if (row.type !== 'rpg') continue
      if (!['playing', 'setup'].includes(String(row.phase ?? ''))) continue
      if (Array.isArray(row.players) && row.players.includes(needle)) continue
      if (Array.isArray(row.game.party) && row.game.party.length >= 3) continue

      out.push(deepClone(row))
      if (out.length >= Math.max(1, Math.floor(limit))) break
    }

    return out
  }

  async load(gameId: string): Promise<RpgGameState> {
    const row = this.rows.get(gameId)
    if (!row) throw new Error(`Adventure ${gameId} not found`)
    return deepClone(row.game)
  }

  async save(gameId: string, game: RpgGameState): Promise<void> {
    const existing = this.rows.get(gameId)
    if (!existing) throw new Error(`Adventure ${gameId} not found`)

    this.rows.set(gameId, {
      ...existing,
      game: deepClone(game),
      phase: game.phase,
      winner: winnerFromGame(game),
      players: game.party.map((member) => member.agent ?? member.name),
      updatedAt: new Date().toISOString(),
    })
  }

  async create(gameId: string, game: RpgGameState, meta: GameCreateMeta): Promise<void> {
    this.rows.set(gameId, {
      id: gameId,
      type: meta.type ?? 'rpg',
      hostAgent: meta.hostAgent,
      phase: game.phase,
      players: deepClone(meta.players),
      winner: null,
      game: deepClone(game),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  async anyActiveExist(): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.type !== 'rpg') continue
      if (['playing', 'setup', 'hub_town'].includes(String(row.phase ?? ''))) return true
    }
    return false
  }

  async countFinishedToday(referenceDate = new Date()): Promise<number> {
    const day = referenceDate.toISOString().slice(0, 10)
    let count = 0
    for (const row of this.rows.values()) {
      if (row.type !== 'rpg') continue
      if (String(row.phase ?? '') !== 'finished') continue
      const updatedDay = String(row.updatedAt ?? '').slice(0, 10)
      if (updatedDay === day) count += 1
    }
    return count
  }
}

export class InMemoryCampaignRepository implements CampaignRepository {
  readonly rows = new Map<string, CampaignState>()

  constructor(private readonly gameRepo?: InMemoryGameStateRepository) {}

  async get(id: string): Promise<CampaignState | null> {
    const row = this.rows.get(id)
    return row ? deepClone(row) : null
  }

  async create(name: string, premise: string, options: CreateCampaignOptions = {}): Promise<CampaignState> {
    const id = `campaign_${crypto.randomUUID()}`
    const created: CampaignState = {
      id,
      name: String(name || '').trim() || 'Untitled Campaign',
      premise: String(premise || '').trim(),
      worldState: options.worldState ? deepClone(options.worldState) : defaultWorldState(),
      storyArcs: Array.isArray(options.storyArcs) ? deepClone(options.storyArcs) : [],
      adventureCount: 0,
    }
    this.rows.set(id, deepClone(created))
    return created
  }

  async update(id: string, patch: CampaignPatch): Promise<void> {
    const current = this.rows.get(id)
    if (!current) return

    this.rows.set(id, {
      ...current,
      ...(typeof patch.name === 'string' ? { name: patch.name.trim() || current.name } : {}),
      ...(typeof patch.premise === 'string' ? { premise: patch.premise.trim() } : {}),
      ...(patch.worldState ? { worldState: deepClone(patch.worldState) } : {}),
      ...(patch.storyArcs ? { storyArcs: deepClone(patch.storyArcs) } : {}),
      ...(typeof patch.adventureCount === 'number'
        ? { adventureCount: Math.max(0, Math.floor(patch.adventureCount)) }
        : {}),
    })
  }

  async linkAdventure(envId: string, campaignId: string): Promise<number> {
    const campaign = this.rows.get(campaignId)
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

    if (!this.gameRepo) throw new Error('gameRepo is required to link adventures in memory')
    const row = this.gameRepo.rows.get(envId)
    if (!row) throw new Error(`Adventure ${envId} not found`)

    const next = Math.max(1, campaign.adventureCount + 1)
    campaign.adventureCount = next
    this.rows.set(campaign.id, deepClone(campaign))

    row.game.campaignId = campaign.id
    row.game.campaignAdventureNumber = next
    row.updatedAt = new Date().toISOString()
    this.gameRepo.rows.set(envId, deepClone(row))

    return next
  }

  async findLatest(): Promise<{ id: string } | null> {
    const latest = Array.from(this.rows.values()).at(-1)
    return latest ? { id: latest.id } : null
  }
}

export class InMemoryCharacterRepository implements CharacterRepository {
  private character: PersistentCharacter | null = null

  async load(): Promise<PersistentCharacter | null> {
    return this.character ? deepClone(this.character) : null
  }

  async save(character: PersistentCharacter): Promise<void> {
    this.character = deepClone(character)
  }
}
