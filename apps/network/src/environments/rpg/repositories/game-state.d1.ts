import type { GameCreateMeta, GameStateRepository, GameStateRow } from '../interfaces'
import type { RpgGameState } from '../../../games/rpg-engine'

type EnvironmentDbRow = {
  id: string
  type: string | null
  host_agent: string | null
  state: string
  phase: string | null
  players: string | null
  winner: string | null
  created_at: string | null
  updated_at: string | null
}

function parsePlayers(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function parseGameState(raw: string, gameId: string): RpgGameState {
  try {
    return JSON.parse(raw) as RpgGameState
  } catch {
    throw new Error(`Adventure ${gameId} has invalid state JSON`)
  }
}

function rowToGameStateRow(row: EnvironmentDbRow): GameStateRow {
  return {
    id: row.id,
    type: row.type ?? 'rpg',
    hostAgent: row.host_agent ?? 'unknown',
    phase: row.phase ?? 'setup',
    players: parsePlayers(row.players),
    winner: row.winner ?? null,
    game: parseGameState(row.state, row.id),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  }
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  const n = typeof limit === 'number' ? Math.floor(limit) : fallback
  return Math.max(1, Math.min(50, n))
}

function dayPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s.length >= 10 ? s.slice(0, 10) : null
}

function winnerFromGame(game: RpgGameState): string | null {
  const winner = (game as Record<string, unknown>).winner
  return typeof winner === 'string' ? winner : null
}

export class D1GameStateRepository implements GameStateRepository {
  constructor(private readonly db: D1Database) {}

  async findActiveForAgent(agentName: string): Promise<GameStateRow | null> {
    const agent = agentName.trim()
    if (!agent) return null

    try {
      const asPlayer = await this.db
        .prepare("SELECT id, type, host_agent, state, phase, players, winner, created_at, updated_at FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND players LIKE ? LIMIT 1")
        .bind(`%${agent}%`)
        .first<EnvironmentDbRow>()
      if (asPlayer) return rowToGameStateRow(asPlayer)

      const asHost = await this.db
        .prepare("SELECT id, type, host_agent, state, phase, players, winner, created_at, updated_at FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND host_agent = ? LIMIT 1")
        .bind(agent)
        .first<EnvironmentDbRow>()

      return asHost ? rowToGameStateRow(asHost) : null
    } catch {
      return null
    }
  }

  async findWhereItsMyTurn(agentName: string): Promise<GameStateRow | null> {
    const agent = agentName.trim()
    if (!agent) return null

    try {
      const row = await this.db
        .prepare(
          "SELECT id, type, host_agent, state, phase, players, winner, created_at, updated_at FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND json_extract(state, '$.currentPlayer') = ?"
        )
        .bind(agent)
        .first<EnvironmentDbRow>()
      return row ? rowToGameStateRow(row) : null
    } catch {
      return null
    }
  }

  async findJoinable(exclude: string, limit = 5): Promise<GameStateRow[]> {
    const agent = exclude.trim()
    const boundedLimit = normalizeLimit(limit, 5)

    try {
      const { results } = await this.db
        .prepare(
          "SELECT id, type, host_agent, state, phase, players, winner, created_at, updated_at FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY updated_at DESC"
        )
        .all<EnvironmentDbRow>()

      const joinable: GameStateRow[] = []
      for (const row of results ?? []) {
        try {
          const parsed = rowToGameStateRow(row)
          if (parsed.players.includes(agent)) continue
          if (!Array.isArray(parsed.game.party) || parsed.game.party.length >= 3) continue
          joinable.push(parsed)
          if (joinable.length >= boundedLimit) break
        } catch {
          // Ignore corrupt rows so one bad row does not hide joinable adventures.
        }
      }

      return joinable
    } catch {
      return []
    }
  }

  async load(gameId: string): Promise<RpgGameState> {
    const row = await this.db
      .prepare("SELECT state FROM environments WHERE id = ? AND type = 'rpg'")
      .bind(gameId)
      .first<{ state: string }>()

    if (!row?.state) throw new Error(`Adventure ${gameId} not found`)
    return parseGameState(row.state, gameId)
  }

  async save(gameId: string, game: RpgGameState): Promise<void> {
    const players = Array.isArray(game.party) ? game.party.map((member) => member.agent ?? member.name) : []
    const winner = winnerFromGame(game)

    await this.db
      .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, players = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(game), game.phase, winner, JSON.stringify(players), gameId)
      .run()
  }

  async create(gameId: string, game: RpgGameState, meta: GameCreateMeta): Promise<void> {
    await this.ensureTypeColumn()

    const phase = meta.phase ?? game.phase
    const type = meta.type ?? 'rpg'

    await this.db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, type, meta.hostAgent, JSON.stringify(game), phase, JSON.stringify(meta.players))
      .run()
  }

  async anyActiveExist(): Promise<boolean> {
    try {
      const row = await this.db
        .prepare("SELECT id FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') LIMIT 1")
        .first<{ id: string }>()
      return Boolean(row?.id)
    } catch {
      return false
    }
  }

  async countFinishedToday(referenceDate = new Date()): Promise<number> {
    const today = referenceDate.toISOString().slice(0, 10)

    try {
      const { results } = await this.db
        .prepare("SELECT id, updated_at FROM environments WHERE type = 'rpg' AND phase = 'finished'")
        .all<{ id: string; updated_at: string }>()
      return (results ?? []).filter((row) => dayPrefix(row.updated_at) === today).length
    } catch {
      return 0
    }
  }

  async listRecentJoinCandidates(limit = 5): Promise<Array<{ id: string; players: string[] }>> {
    const boundedLimit = normalizeLimit(limit, 5)
    const { results } = await this.db
      .prepare(`SELECT id, players FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY created_at DESC LIMIT ${boundedLimit}`)
      .all<{ id: string; players: string }>()

    return (results ?? []).map((row) => ({
      id: row.id,
      players: parsePlayers(row.players),
    }))
  }

  private async ensureTypeColumn(): Promise<void> {
    await this.db.prepare("ALTER TABLE environments ADD COLUMN type TEXT DEFAULT 'catan'").run().catch(() => undefined)
  }
}
