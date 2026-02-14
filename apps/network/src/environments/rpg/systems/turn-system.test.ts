import { describe, expect, it } from 'vitest'

import { createCharacter, createGame, type Character, type RpgGameState } from '../../../games/rpg-engine'
import { advanceTurn, computeInitiativeOrder, normalizeTurnState, recomputeTurnOrder } from './turn-system'

function makeGame(): RpgGameState {
  const alice = createCharacter({ name: 'Alice', agent: 'alice', klass: 'Warrior' })
  const bob = createCharacter({ name: 'Bob', agent: 'bob', klass: 'Scout' })
  const cara = createCharacter({ name: 'Cara', agent: 'cara', klass: 'Mage' })

  alice.stats.DEX = 70
  bob.stats.DEX = 80
  cara.stats.DEX = 60

  return createGame({
    id: 'turn-system',
    players: [alice, bob, cara],
    dungeon: [{ type: 'rest', description: 'safe room' }],
  })
}

function ids(characters: Character[]): string[] {
  return characters.map((character) => character.agent ?? character.name)
}

describe('turn-system', () => {
  it('computeInitiativeOrder sorts by DEX desc then by name', () => {
    const cato = createCharacter({ name: 'Cato', klass: 'Warrior' })
    const boris = createCharacter({ name: 'Boris', klass: 'Warrior' })
    const alice = createCharacter({ name: 'Alice', klass: 'Warrior' })
    cato.stats.DEX = 80
    boris.stats.DEX = 70
    alice.stats.DEX = 70

    const order = computeInitiativeOrder([boris, cato, alice])
    expect(order.map((character) => character.name)).toEqual(['Cato', 'Alice', 'Boris'])
  })

  it('normalizeTurnState skips dead current player and picks next living', () => {
    const game = makeGame()
    const bob = game.party.find((member) => member.agent === 'bob')!
    bob.hp = 0
    game.currentPlayer = 'bob'

    const changed = normalizeTurnState(game, { now: () => 123 })

    expect(changed).toBe(true)
    expect(ids(game.turnOrder)).toEqual(['alice', 'cara'])
    expect(game.currentPlayer).toBe('alice')
    expect(game.log.some((entry) => entry.what.includes('Bob is dead, skipping turn'))).toBe(true)
  })

  it('normalizeTurnState ends the game on total party kill', () => {
    const game = makeGame()
    for (const member of game.party) member.hp = 0

    normalizeTurnState(game)

    expect(game.phase).toBe('finished')
    expect(game.mode).toBe('finished')
    expect(game.currentPlayer).toBe('none')
    expect(game.combat).toBeUndefined()
  })

  it('advanceTurn rotates living players and increments round on wrap', () => {
    const game = makeGame()
    const bob = game.party.find((member) => member.agent === 'bob')!
    bob.hp = 0
    game.currentPlayer = 'alice'
    game.round = 1

    advanceTurn(game)
    expect(game.currentPlayer).toBe('cara')
    expect(game.round).toBe(1)

    advanceTurn(game)
    expect(game.currentPlayer).toBe('alice')
    expect(game.round).toBe(2)
  })

  it('recomputeTurnOrder normalizes the turn state', () => {
    const game = makeGame()
    const bob = game.party.find((member) => member.agent === 'bob')!
    bob.hp = 0
    game.currentPlayer = 'bob'

    recomputeTurnOrder(game, { now: () => 456 })

    expect(ids(game.turnOrder)).toEqual(['alice', 'cara'])
    expect(game.currentPlayer).toBe('alice')
  })
})
