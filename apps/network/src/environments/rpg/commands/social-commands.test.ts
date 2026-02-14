import { describe, expect, it } from 'vitest'

import { createGame } from '../../../games/rpg-engine'

import { executeSocialCommand } from './social-commands'

describe('executeSocialCommand', () => {
  it('returns null for unknown commands', async () => {
    const game = createGame({
      id: 'rpg_social_unknown',
      players: ['slag'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeSocialCommand({
      command: 'explore',
      params: {},
      game,
      gameId: 'rpg_social_unknown',
      ctx: {
        agentName: 'slag',
        db: {} as D1Database,
      } as any,
    })

    expect(result).toBeNull()
  })

  it('rejects setup_narrate for non-DM agents', async () => {
    const game = createGame({
      id: 'rpg_social_setup_dm_only',
      players: ['slag'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'setup'
    game.setupPhase = {
      currentPlayerIndex: 0,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: {},
      complete: false,
    }

    const result = await executeSocialCommand({
      command: 'setup_narrate',
      params: { message: 'Tell me your story.' },
      game,
      gameId: 'rpg_social_setup_dm_only',
      ctx: {
        agentName: 'slag',
        db: {} as D1Database,
      } as any,
    })

    expect(result).toEqual({ ok: false, error: 'Only Grimlock can use setup_narrate.' })
  })
})
