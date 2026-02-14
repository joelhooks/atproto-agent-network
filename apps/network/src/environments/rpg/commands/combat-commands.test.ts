import { describe, expect, it } from 'vitest'

import { createDice, createGame } from '../../../games/rpg-engine'

import { executeCombatCommand } from './combat-commands'

describe('executeCombatCommand', () => {
  it('returns null for unknown commands', async () => {
    const game = createGame({
      id: 'rpg_cmd_unknown',
      players: ['alice', 'bob'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeCombatCommand({
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

  it('rejects attack when it is not the acting player turn', async () => {
    const game = createGame({
      id: 'rpg_cmd_attack_turn',
      players: ['alice', 'bob'],
      dungeon: [{ type: 'combat', description: 'fight', enemies: [{ name: 'Goblin', hp: 1, DEX: 10, attack: 10, dodge: 10 }] }],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'bob'

    const result = await executeCombatCommand({
      command: 'attack',
      game,
      gameId: 'rpg_cmd_attack_turn',
      params: {},
      agentName: 'alice',
      dice: createDice(),
      deps: {} as any,
    })

    expect(result).toEqual({ ok: false, error: 'Not your turn. Current player: bob' })
  })
})
