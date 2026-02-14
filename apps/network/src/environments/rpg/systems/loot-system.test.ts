import { describe, expect, it } from 'vitest'

import { createCharacter, createGame, createTestDice, type Enemy, type RpgGameState } from '../../../games/rpg-engine'
import {
  buyHubTownItem,
  listHubTownShopItemIds,
  maybeAwardEnemyDrop,
  resolveTreasureLoot,
  sellHubTownItem,
} from './loot-system'

function makeTreasureGame(): RpgGameState {
  const alice = createCharacter({ name: 'Alice', agent: 'alice', klass: 'Warrior' })
  return createGame({
    id: 'loot-system',
    players: [alice],
    dungeon: [
      { type: 'treasure', description: 'A chest in a dusty chamber.' },
      { type: 'rest', description: 'A quiet camp.' },
      { type: 'rest', description: 'An old shrine.' },
    ],
  })
}

function makeEnemy(input: { name: string; boss?: boolean }): Enemy {
  return {
    name: input.name,
    hp: 12,
    maxHp: 12,
    DEX: 40,
    attack: 35,
    dodge: 30,
    ...(input.boss ? { tactics: { kind: 'boss' } } : { tactics: { kind: 'goblin' } }),
  }
}

describe('loot-system', () => {
  it('resolveTreasureLoot grants loot, logs the summary, and awards treasure XP', () => {
    const game = makeTreasureGame()
    const actor = game.party[0]!
    const dice = createTestDice({ d100: () => 50, d: () => 2 })

    const line = resolveTreasureLoot(game, actor, dice, { now: () => 123, random: () => 0.5 })

    expect(line.startsWith('Found: ')).toBe(true)
    expect(actor.inventory.length).toBeGreaterThan(0)
    expect(actor.gold).toBeGreaterThan(0)
    expect(game.log.some((entry) => entry.what.startsWith('Found: '))).toBe(true)
    expect(game.xpEarned?.alice).toBe(10)
  })

  it('maybeAwardEnemyDrop returns null when non-boss drop roll fails', () => {
    const game = makeTreasureGame()
    const actor = game.party[0]!
    const enemy = makeEnemy({ name: 'Goblin' })
    const dice = createTestDice({ d100: () => 99, d: () => 2 })

    const line = maybeAwardEnemyDrop(game, actor, enemy, dice, { now: () => 456 })

    expect(line).toBeNull()
    expect(game.log.some((entry) => entry.what.includes('loot drop'))).toBe(false)
  })

  it('maybeAwardEnemyDrop always grants a drop for boss enemies', () => {
    const game = makeTreasureGame()
    const actor = game.party[0]!
    const enemy = makeEnemy({ name: 'Lich King', boss: true })
    const dice = createTestDice({ d100: () => 99, d: () => 3 })

    const line = maybeAwardEnemyDrop(game, actor, enemy, dice, { now: () => 789 })

    expect(line).toContain('Lich King dropped')
    expect(game.log.some((entry) => entry.what.includes('loot drop: Lich King dropped'))).toBe(true)
  })

  it('buyHubTownItem buys a market listing, applies effects, and tags the item id', () => {
    const actor = createCharacter({ name: 'Buyer', agent: 'buyer', klass: 'Warrior' })
    actor.gold = 100
    actor.inventory = []

    const result = buyHubTownItem(actor, 'iron_sword')

    expect(result.ok).toBe(true)
    expect(actor.gold).toBe(55)
    expect(actor.skills.attack).toBeGreaterThan(30)
    expect(actor.inventory.some((item) => (item as any).hubItemId === 'iron_sword')).toBe(true)
  })

  it('sellHubTownItem removes equipment effects and returns listed sell value', () => {
    const actor = createCharacter({ name: 'Seller', agent: 'seller', klass: 'Warrior' })
    actor.gold = 40
    actor.inventory = []
    const buy = buyHubTownItem(actor, 'chain_jerkin')
    expect(buy.ok).toBe(true)
    const dodgeAfterBuy = actor.skills.dodge

    const sold = sellHubTownItem(actor, 'chain_jerkin')

    expect(sold.ok).toBe(true)
    expect(actor.skills.dodge).toBeLessThan(dodgeAfterBuy)
    expect(actor.gold).toBe(20)
    expect(actor.inventory.length).toBe(0)
  })

  it('listHubTownShopItemIds is stable and lower-cased for command validation', () => {
    expect(listHubTownShopItemIds()).toEqual(['chain_jerkin', 'iron_sword', 'runed_charm'])
  })
})
