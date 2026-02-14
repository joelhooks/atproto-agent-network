import { describe, expect, it } from 'vitest'

import { createCharacter, createGame, type RpgGameState } from '../../../games/rpg-engine'
import {
  buyFromHubTownMarket,
  buildHubTownNarration,
  countHubTownIdleTurn,
  ensureHubTownState,
  HUB_TOWN_LOCATIONS,
  sellToHubTownMarket,
  resetHubTownIdle,
  tickHubTownDowntime,
  transitionCampaignCompletionToHubTown,
  visitHubTownLocation,
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

  it('visit/buy/sell handlers manage hub town market actions and turn flow', () => {
    const game = makeGame()
    game.phase = 'hub_town'
    game.currentPlayer = 'alice'
    ;(game as Record<string, unknown>).hubTown = { location: 'tavern', idleTurns: 2, autoEmbarkAfter: 5 }

    const locations = HUB_TOWN_LOCATIONS
    expect(locations).toEqual(['tavern', 'market', 'temple', 'guild_hall'])

    const visit = visitHubTownLocation(game, { agentName: 'alice', location: 'market' })
    expect(visit.ok).toBe(true)
    expect(game.hubTown?.location).toBe('market')
    expect(game.hubTown?.idleTurns).toBe(0)
    expect(game.currentPlayer).toBe('alice')

    const actor = game.party.find((member) => member.agent === 'alice')
    expect(actor).toBeDefined()
    if (!actor) return
    actor.gold = 80

    const buy = buyFromHubTownMarket(game, { agentName: 'alice', itemId: 'iron_sword' })
    expect(buy.ok).toBe(true)
    expect(actor.gold).toBe(35)
    expect(actor.inventory.some((item) => item.name === 'Iron Sword')).toBe(true)

    game.currentPlayer = 'alice'
    const sell = sellToHubTownMarket(game, { agentName: 'alice', itemId: 'iron_sword' })
    expect(sell.ok).toBe(true)
    expect(actor.gold).toBe(57)
  })

  it('transitionCampaignCompletionToHubTown switches finished campaigns into downtime', () => {
    const game = makeGame()
    game.phase = 'finished'
    game.mode = 'exploring'
    game.currentPlayer = 'none'
    game.campaignId = 'campaign-1'
    game.log = []

    const transition = transitionCampaignCompletionToHubTown(game, 'playing')

    expect(transition).toEqual({ completed: true, enteredHubTown: true })
    expect(game.phase).toBe('hub_town')
    expect(game.mode).toBe('finished')
    expect(game.hubTown?.location).toBe('tavern')
    expect(game.currentPlayer).toBe('alice')
    expect(game.log.at(-1)?.what).toContain('hub_town: the party returns to town between adventures.')
  })

  it('tickHubTownDowntime increments idle turns and signals auto-embark threshold', () => {
    const game = makeGame()
    game.phase = 'hub_town'
    ;(game as Record<string, unknown>).hubTown = { location: 'tavern', idleTurns: 0, autoEmbarkAfter: 2 }

    const first = tickHubTownDowntime(game)
    expect(first.shouldEmbark).toBe(false)
    expect(first.hub.idleTurns).toBe(1)

    const second = tickHubTownDowntime(game)
    expect(second.shouldEmbark).toBe(true)
    expect(second.hub.idleTurns).toBe(2)
  })
})
