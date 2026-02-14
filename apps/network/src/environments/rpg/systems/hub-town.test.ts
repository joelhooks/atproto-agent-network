import { describe, expect, it } from 'vitest'

import { createCharacter, createGame, type RpgGameState } from '../../../games/rpg-engine'
import {
  buildHubTownNarration,
  countHubTownIdleTurn,
  ensureHubTownState,
  resetHubTownIdle,
} from './hub-town'

function makeGame(): RpgGameState {
  const alice = createCharacter({ name: 'Alice', agent: 'alice', klass: 'Warrior' })
  return createGame({
    id: 'hub-town-system',
    players: [alice],
    dungeon: [{ type: 'rest', description: 'camp' }],
  })
}

describe('hub-town system', () => {
  it('ensureHubTownState normalizes invalid values onto the game state', () => {
    const game = makeGame()
    ;(game as Record<string, unknown>).hubTown = {
      location: 'invalid-location',
      idleTurns: -10,
      autoEmbarkAfter: 999,
    }

    const hub = ensureHubTownState(game)

    expect(hub.location).toBe('tavern')
    expect(hub.idleTurns).toBe(0)
    expect(hub.autoEmbarkAfter).toBe(20)
    expect(game.hubTown).toEqual(hub)
  })

  it('countHubTownIdleTurn increments idle turns and persists the next state', () => {
    const game = makeGame()
    ;(game as Record<string, unknown>).hubTown = {
      location: 'market',
      idleTurns: 1,
      autoEmbarkAfter: 3,
    }

    const idleTurns = countHubTownIdleTurn(game)

    expect(idleTurns).toBe(2)
    expect(game.hubTown?.idleTurns).toBe(2)
  })

  it('resetHubTownIdle only resets when in hub_town phase', () => {
    const game = makeGame()
    ;(game as Record<string, unknown>).hubTown = {
      location: 'market',
      idleTurns: 4,
      autoEmbarkAfter: 5,
    }

    game.phase = 'playing'
    resetHubTownIdle(game)
    expect(game.hubTown?.idleTurns).toBe(4)

    game.phase = 'hub_town'
    resetHubTownIdle(game)
    expect(game.hubTown?.idleTurns).toBe(0)
  })

  it('buildHubTownNarration includes location, campaign context, and latest rumor', () => {
    const game = makeGame()
    game.campaignContext = {
      id: 'camp-1',
      name: 'Shadows of Red Hollow',
      premise: 'Break the cult encirclement.',
      activeArcs: ['The Ember Sigil'],
      factions: [],
      npcs: [],
    }
    game.campaignLog = ['Earlier recap', 'The tavern whispers of a hidden sigil vault.']

    const text = buildHubTownNarration(game, { location: 'temple', cue: 'The party regroups in solemn quiet.' })

    expect(text).toContain('Hub Town - Temple of Dawn')
    expect(text).toContain('GM: The party regroups in solemn quiet.')
    expect(text).toContain('Campaign: Shadows of Red Hollow')
    expect(text).toContain('Latest rumor: The tavern whispers of a hidden sigil vault.')
  })
})
