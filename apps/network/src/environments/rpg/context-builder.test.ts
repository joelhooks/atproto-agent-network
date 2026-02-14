import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../../packages/core/src/d1-mock'
import { createGame } from '../../games/rpg-engine'

import { buildContext } from './context-builder'

describe('rpg/context-builder', () => {
  it('returns joinable game guidance when no active game exists for the agent', async () => {
    const db = new D1MockDatabase()
    const gameId = 'rpg_joinable_context'
    const game = createGame({ id: gameId, players: ['slag'] })
    game.phase = 'playing'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag']))
      .run()

    const lines = await buildContext(
      {
        agentName: 'snarl',
        agentDid: 'did:cf:snarl',
        db: db as any,
        broadcast: vi.fn(),
      } as any,
      {
        isCharacter: (character, identity) => character.agent === identity || character.name === identity,
        isReactiveModeEnabled: () => false,
      }
    )

    expect(lines[0]).toBe('🏰 Joinable Dungeon Crawls:')
    expect(lines.join('\n')).toContain(`Join: {"command":"join_game","gameId":"${gameId}"`)
  })
})
