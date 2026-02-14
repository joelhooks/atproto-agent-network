import { describe, expect, it } from 'vitest'

import { createDice, createGame } from '../../../games/rpg-engine'

import { executeExplorationCommand } from './exploration-commands'

describe('executeExplorationCommand', () => {
  it('returns null for unknown commands', async () => {
    const game = createGame({
      id: 'rpg_cmd_unknown',
      players: ['alice', 'bob'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeExplorationCommand({
      command: 'status',
      game,
      gameId: 'rpg_cmd_unknown',
      params: {},
      agentName: 'alice',
      dice: createDice(),
      deps: {} as any,
    })

    expect(result).toBeNull()
  })

  it('rejects explore when it is not the acting player turn', async () => {
    const game = createGame({
      id: 'rpg_cmd_explore_turn',
      players: ['alice', 'bob'],
      dungeon: [{ type: 'rest', description: 'safe' }, { type: 'rest', description: 'after' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'bob'

    const result = await executeExplorationCommand({
      command: 'explore',
      game,
      gameId: 'rpg_cmd_explore_turn',
      params: {},
      agentName: 'alice',
      dice: createDice(),
      deps: {} as any,
    })

    expect(result).toEqual({ ok: false, error: 'Not your turn. Current player: bob' })
  })
})
