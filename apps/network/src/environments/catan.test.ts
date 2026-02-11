import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createGame } from '../games/catan'
import { catanEnvironment } from './catan'

describe('catanEnvironment', () => {
  it("logs a structured game.completed event when the game finishes (phase becomes 'finished')", async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'catan_test_game_completed'
    const game = createGame(gameId, ['alice', 'bob'])

    // Force a fast finish path: next end_turn triggers stalemate (threshold is 20).
    game.phase = 'playing'
    game.currentPlayer = 'alice'
    ;(game as any).staleTurns = 19
    game.turn = 100

    await db
      .prepare(
        "INSERT INTO environments (id, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const tool = catanEnvironment.getTool(ctx as any)
      await tool.execute('toolcall-1', { command: 'action', gameId, gameAction: { type: 'end_turn' } })

      const completedLine = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event_type":"game.completed"'))

      expect(completedLine).toBeTruthy()
      expect(JSON.parse(completedLine!)).toMatchObject({
        event_type: 'game.completed',
        type: 'catan',
        gameId,
      })
    } finally {
      logSpy.mockRestore()
    }
  })
})

