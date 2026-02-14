import { describe, expect, it } from 'vitest'

import { createGame } from '../../../games/rpg-engine'

import { executeHubTownCommand } from './hub-town-commands'

describe('executeHubTownCommand', () => {
  it('returns null for unknown commands', async () => {
    const game = createGame({
      id: 'rpg_hub_unknown',
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeHubTownCommand({
      command: 'status',
      game,
      gameId: 'rpg_hub_unknown',
      params: {},
      agentName: 'alice',
      deps: {
        saveGame: async () => undefined,
        summarizeParty: () => 'party',
        getCampaign: async () => null,
        updateCampaign: async () => undefined,
        linkAdventureToCampaign: async () => 1,
      },
    })

    expect(result).toBeNull()
  })

  it('rejects visit_location outside hub_town', async () => {
    const game = createGame({
      id: 'rpg_hub_visit_phase',
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeHubTownCommand({
      command: 'visit_location',
      game,
      gameId: 'rpg_hub_visit_phase',
      params: { location: 'market' },
      agentName: 'alice',
      deps: {
        saveGame: async () => undefined,
        summarizeParty: () => 'party',
        getCampaign: async () => null,
        updateCampaign: async () => undefined,
        linkAdventureToCampaign: async () => 1,
      },
    })

    expect(result).toEqual({ ok: false, error: 'visit_location is only available in hub_town.' })
  })

  it('rejects embark outside hub_town', async () => {
    const game = createGame({
      id: 'rpg_hub_embark_phase',
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })

    const result = await executeHubTownCommand({
      command: 'embark',
      game,
      gameId: 'rpg_hub_embark_phase',
      params: {},
      agentName: 'alice',
      deps: {
        saveGame: async () => undefined,
        summarizeParty: () => 'party',
        getCampaign: async () => null,
        updateCampaign: async () => undefined,
        linkAdventureToCampaign: async () => 1,
      },
    })

    expect(result).toEqual({ ok: false, error: 'embark is only available in hub_town.' })
  })
})
