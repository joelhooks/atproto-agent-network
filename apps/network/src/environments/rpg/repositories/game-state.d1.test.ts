import { describe, expect, it } from 'vitest'

import { D1MockDatabase } from '../../../../../../packages/core/src/d1-mock'
import { createCharacter, createGame, type RpgGameState } from '../../../games/rpg-engine'
import { D1GameStateRepository } from './game-state.d1'

async function seedGame(
  db: D1MockDatabase,
  input: {
    id: string
    game: RpgGameState
    host?: string
    phase?: RpgGameState['phase']
    players?: string[]
    updatedAt?: string
  }
): Promise<void> {
  const host = input.host ?? 'grimlock'
  const phase = input.phase ?? input.game.phase
  const players = input.players ?? input.game.party.map((member) => member.agent ?? member.name)

  await db
    .prepare(
      "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    )
    .bind(input.id, 'rpg', host, JSON.stringify(input.game), phase, JSON.stringify(players))
    .run()

  if (input.updatedAt) {
    const row = db.games.get(input.id)
    if (row) {
      row.updated_at = input.updatedAt
      db.games.set(input.id, row)
    }
  }
}

describe('D1GameStateRepository', () => {
  it('finds active game for player first, then host fallback', async () => {
    const db = new D1MockDatabase()
    const repo = new D1GameStateRepository(db as unknown as D1Database)

    const playerGame = createGame({ id: 'rpg_player_active', players: ['slag', 'snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })
    const hostGame = createGame({ id: 'rpg_host_active', players: ['swoop'], dungeon: [{ type: 'rest', description: 'safe' }] })

    await seedGame(db, { id: playerGame.id, game: playerGame, host: 'grimlock' })
    await seedGame(db, { id: hostGame.id, game: hostGame, host: 'oracle' })

    const asPlayer = await repo.findActiveForAgent('slag')
    expect(asPlayer?.id).toBe(playerGame.id)

    const asHost = await repo.findActiveForAgent('oracle')
    expect(asHost?.id).toBe(hostGame.id)
  })

  it('finds active game where it is the agent turn', async () => {
    const db = new D1MockDatabase()
    const repo = new D1GameStateRepository(db as unknown as D1Database)

    const game = createGame({ id: 'rpg_turn_lookup', players: ['slag', 'snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })
    game.currentPlayer = 'snarl'

    await seedGame(db, { id: game.id, game })

    const row = await repo.findWhereItsMyTurn('snarl')
    expect(row?.id).toBe(game.id)
  })

  it('returns joinable games that exclude the querying agent and full parties', async () => {
    const db = new D1MockDatabase()
    const repo = new D1GameStateRepository(db as unknown as D1Database)

    const openGame = createGame({ id: 'rpg_join_open', players: ['swoop'], dungeon: [{ type: 'rest', description: 'safe' }] })
    const ownGame = createGame({ id: 'rpg_join_own', players: ['slag'], dungeon: [{ type: 'rest', description: 'safe' }] })
    const fullGame = createGame({ id: 'rpg_join_full', players: ['slag', 'snarl', 'swoop'], dungeon: [{ type: 'rest', description: 'safe' }] })

    await seedGame(db, { id: openGame.id, game: openGame })
    await seedGame(db, { id: ownGame.id, game: ownGame })
    await seedGame(db, { id: fullGame.id, game: fullGame })

    const joinable = await repo.findJoinable('slag', 5)
    expect(joinable.map((row) => row.id)).toEqual([openGame.id])
  })

  it('loads and saves game state with player list and winner', async () => {
    const db = new D1MockDatabase()
    const repo = new D1GameStateRepository(db as unknown as D1Database)

    const game = createGame({ id: 'rpg_load_save', players: ['slag'], dungeon: [{ type: 'rest', description: 'safe' }] })
    await seedGame(db, { id: game.id, game })

    const loaded = await repo.load(game.id)
    expect(loaded.id).toBe(game.id)

    loaded.party.push(createCharacter({ name: 'Kragh', klass: 'Warrior', agent: 'snarl' }))
    loaded.phase = 'finished'
    ;(loaded as { winner?: string }).winner = 'snarl'

    await repo.save(game.id, loaded)

    const stored = db.games.get(game.id)
    expect(stored?.phase).toBe('finished')
    expect(stored?.winner).toBe('snarl')
    expect(JSON.parse(String(stored?.players ?? '[]'))).toEqual(['slag', 'snarl'])
  })

  it('creates a game row and can load it back', async () => {
    const db = new D1MockDatabase()
    const repo = new D1GameStateRepository(db as unknown as D1Database)

    const game = createGame({ id: 'rpg_create_row', players: ['slag', 'swoop'], dungeon: [{ type: 'rest', description: 'safe' }] })

    await repo.create(game.id, game, {
      hostAgent: 'grimlock',
      players: ['slag', 'swoop'],
      type: 'rpg',
    })

    const loaded = await repo.load(game.id)
    expect(loaded.id).toBe(game.id)
    expect(loaded.party.map((member) => member.agent ?? member.name)).toEqual(['slag', 'swoop'])
  })

  it('reports active games and finished count for today', async () => {
    const db = new D1MockDatabase()
    const repo = new D1GameStateRepository(db as unknown as D1Database)

    const today = new Date('2026-02-14T12:00:00.000Z')
    const yesterday = new Date('2026-02-13T23:00:00.000Z')

    const active = createGame({ id: 'rpg_active_yes', players: ['slag'], dungeon: [{ type: 'rest', description: 'safe' }] })
    active.phase = 'playing'
    const finishedToday = createGame({ id: 'rpg_finished_today', players: ['snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })
    finishedToday.phase = 'finished'
    const finishedYesterday = createGame({ id: 'rpg_finished_yesterday', players: ['swoop'], dungeon: [{ type: 'rest', description: 'safe' }] })
    finishedYesterday.phase = 'finished'

    await seedGame(db, { id: active.id, game: active, phase: 'playing', updatedAt: today.toISOString() })
    await seedGame(db, { id: finishedToday.id, game: finishedToday, phase: 'finished', updatedAt: today.toISOString() })
    await seedGame(db, { id: finishedYesterday.id, game: finishedYesterday, phase: 'finished', updatedAt: yesterday.toISOString() })

    await expect(repo.anyActiveExist()).resolves.toBe(true)
    await expect(repo.countFinishedToday(today)).resolves.toBe(1)
  })
})
