import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../../packages/core/src/d1-mock'
import { createGame } from '../../games/rpg-engine'

import { getAutoPlayActions } from './auto-play'

describe('rpg/auto-play', () => {
  it('grimlock crafts a dungeon when the active game has no dungeon rooms', async () => {
    const db = new D1MockDatabase()
    const gameId = 'rpg_autoplay_craft_dungeon'
    const game = createGame({ id: gameId, players: ['slag', 'snarl'] })
    game.dungeon = []
    game.phase = 'playing'
    game.currentPlayer = 'grimlock'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const calls = await getAutoPlayActions(
      {
        agentName: 'grimlock',
        agentDid: 'did:cf:grimlock',
        db: db as any,
        broadcast: vi.fn(),
      } as any,
      {
        isCharacter: (character, identity) => character.agent === identity || character.name === identity,
        isReactiveModeEnabled: () => false,
      }
    )

    expect(calls).toEqual([{ name: 'gm', arguments: { command: 'craft_dungeon', gameId } }])
  })
})
