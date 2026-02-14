import { describe, expect, it } from 'vitest'

import { createCharacter, createGame, createTestDice, type Enemy, type RpgGameState } from '../../../games/rpg-engine'
import { resolveCombatAttack, runEnemyFreeAttackRound } from './combat-resolver'

function makeGame(): RpgGameState {
  const alice = createCharacter({ name: 'Alice', agent: 'alice', klass: 'Warrior' })
  const bob = createCharacter({ name: 'Bob', agent: 'bob', klass: 'Scout' })
  alice.stats.STR = 50

  const game = createGame({
    id: 'combat-system',
    players: [alice, bob],
    dungeon: [{ type: 'combat', description: 'ambush', enemies: [] }],
  })
  game.phase = 'playing'
  game.mode = 'combat'
  return game
}

function makeEnemy(): Enemy {
  return {
    name: 'Goblin',
    hp: 10,
    maxHp: 10,
    DEX: 30,
    attack: 75,
    dodge: 20,
    tactics: { kind: 'goblin' },
  }
}

describe('combat-resolver', () => {
  it('resolveCombatAttack applies hit damage and updates attack skill progression', () => {
    const game = makeGame()
    const attacker = game.party.find((member) => member.agent === 'alice')!
    const enemy = makeEnemy()
    const dice = createTestDice({
      d100: (() => {
        const rolls = [10, 90]
        let index = 0
        return () => rolls[index++] ?? 100
      })(),
      d: () => 4,
    })

    const result = resolveCombatAttack({
      game,
      attacker,
      attackerId: 'alice',
      enemy,
      dice,
      now: () => 111,
    })

    expect(result.hit).toBe(true)
    expect(result.damage).toBe(6)
    expect(enemy.hp).toBe(4)
    expect(attacker.skills.attack).toBeGreaterThan(0)
    expect(game.log.some((entry) => entry.what.includes('attack: hit Goblin for 6'))).toBe(true)
  })

  it('resolveCombatAttack records misses without damaging the enemy', () => {
    const game = makeGame()
    const attacker = game.party.find((member) => member.agent === 'alice')!
    attacker.skills.attack = 20
    const enemy = makeEnemy()
    const dice = createTestDice({
      d100: (() => {
        const rolls = [95, 1]
        let index = 0
        return () => rolls[index++] ?? 100
      })(),
      d: () => 3,
    })

    const result = resolveCombatAttack({
      game,
      attacker,
      attackerId: 'alice',
      enemy,
      dice,
      now: () => 222,
    })

    expect(result.hit).toBe(false)
    expect(enemy.hp).toBe(10)
    expect(result.text).toBe('The Goblin avoids your attack.')
    expect(game.log.some((entry) => entry.what.includes('attack: missed Goblin'))).toBe(true)
  })

  it('runEnemyFreeAttackRound applies enemy attacks and returns narration lines', () => {
    const game = makeGame()
    const alice = game.party.find((member) => member.agent === 'alice')!
    alice.hp = 3
    alice.skills.dodge = 1
    const enemy = makeEnemy()
    game.combat = { enemies: [enemy] }

    const d100Rolls = [1, 100]
    let d100Index = 0
    const dRolls = [1, 3]
    let dIndex = 0
    const dice = createTestDice({
      d100: () => d100Rolls[d100Index++] ?? 100,
      d: () => dRolls[dIndex++] ?? 1,
    })

    const lines = runEnemyFreeAttackRound(game, dice)

    expect(lines[0]).toContain('Goblin strikes Alice for 3')
    expect(alice.hp).toBe(0)
  })

  it('runEnemyFreeAttackRound reports misses when enemy cannot land a hit', () => {
    const game = makeGame()
    const alice = game.party.find((member) => member.agent === 'alice')!
    alice.skills.dodge = 80
    const enemy = makeEnemy()
    enemy.attack = 10
    game.combat = { enemies: [enemy] }

    const dice = createTestDice({
      d100: (() => {
        const rolls = [95, 5]
        let index = 0
        return () => rolls[index++] ?? 100
      })(),
      d: () => 1,
    })

    const lines = runEnemyFreeAttackRound(game, dice)

    expect(lines).toEqual(['Goblin swings at Alice but misses.'])
    expect(alice.hp).toBeGreaterThan(0)
  })
})
