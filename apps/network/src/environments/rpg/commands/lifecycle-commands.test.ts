import { describe, expect, it } from 'vitest'

import { createGame } from '../../../games/rpg-engine'

import { executeLifecycleCommand } from './lifecycle-commands'

describe('executeLifecycleCommand', () => {
  it('returns null for unknown commands', async () => {
    const game = createGame({
      id: 'rpg_lifecycle_unknown',
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeLifecycleCommand({
      command: 'explore',
      params: {},
      gameId: 'rpg_lifecycle_unknown',
      game,
      setupActive: false,
      ctx: {
        agentName: 'alice',
        db: {} as D1Database,
        broadcast: async () => undefined,
      } as any,
      deps: {
        getCampaign: async () => null,
        linkAdventureToCampaign: async () => 1,
      },
    })

    expect(result).toBeNull()
  })

  it('throws when join_game is missing gameId', async () => {
    await expect(
      executeLifecycleCommand({
        command: 'join_game',
        params: { klass: 'Mage' },
        ctx: {
          agentName: 'alice',
          db: {} as D1Database,
          broadcast: async () => undefined,
        } as any,
        deps: {
          getCampaign: async () => null,
          linkAdventureToCampaign: async () => 1,
        },
      })
    ).rejects.toThrow('gameId required for join_game')
  })
})
