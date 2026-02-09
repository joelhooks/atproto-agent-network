import { describe, expect, it } from 'vitest'

import {
  attack,
  createCharacter,
  createGame,
  createTestDice,
  explore,
  resolveSkillCheck,
  rollD100,
  type RpgClass,
} from './rpg-engine'

function makeDiceFromD100(rolls: number[]) {
  // Map exact d100 rolls to rng() outputs. rollD100 does: floor(rng()*100)+1
  const values = rolls.map((r) => {
    if (r < 1 || r > 100) throw new Error(`bad roll: ${r}`)
    return (r - 1) / 100 + 0.00001
  })
  let i = 0
  return createTestDice({
    d100: () => values[i++] != null ? Math.floor(values[i - 1]! * 100) + 1 : 100,
    d: (_sides: number) => 1,
  })
}

describe('rpg-engine', () => {
  it('rollD100 returns 1..100', () => {
    const dice = createTestDice({ d100: () => 1, d: () => 1 })
    expect(rollD100(dice)).toBe(1)

    const dice2 = createTestDice({ d100: () => 100, d: () => 1 })
    expect(rollD100(dice2)).toBe(100)
  })

  it('resolveSkillCheck succeeds when roll <= skill', () => {
    const dice = makeDiceFromD100([30, 31])
    const ok = resolveSkillCheck({ skill: 30, dice })
    expect(ok.success).toBe(true)

    const fail = resolveSkillCheck({ skill: 30, dice })
    expect(fail.success).toBe(false)
  })

  it('resolveSkillCheck improves skill by 1 on success (cap 100)', () => {
    const dice = makeDiceFromD100([10, 100])

    const improved = resolveSkillCheck({ skill: 10, dice })
    expect(improved.success).toBe(true)
    expect(improved.nextSkill).toBe(11)

    const capped = resolveSkillCheck({ skill: 100, dice })
    expect(capped.success).toBe(true)
    expect(capped.nextSkill).toBe(100)
  })

  it('createCharacter produces distinct primary stats by class', () => {
    const classes: RpgClass[] = ['Warrior', 'Scout', 'Mage', 'Healer']
    const chars = classes.map((klass) => createCharacter({ name: `p-${klass}`, klass }))

    const byName = new Map(chars.map((c) => [c.klass, c]))
    expect(byName.get('Warrior')!.stats.STR).toBeGreaterThan(byName.get('Warrior')!.stats.DEX)
    expect(byName.get('Scout')!.stats.DEX).toBeGreaterThan(byName.get('Scout')!.stats.STR)
    expect(byName.get('Mage')!.stats.INT).toBeGreaterThan(byName.get('Mage')!.stats.DEX)
    expect(byName.get('Healer')!.stats.WIS).toBeGreaterThan(byName.get('Healer')!.stats.INT)
  })

  it('combat initiative is ordered by DEX (descending)', () => {
    const a = createCharacter({ name: 'a', klass: 'Warrior' })
    const b = createCharacter({ name: 'b', klass: 'Scout' })
    const c = createCharacter({ name: 'c', klass: 'Mage' })

    const game = createGame({ id: 'rpg_1', players: [a, b, c] })
    expect(game.turnOrder[0]!.name).toBe('b')
  })

  it('opposed attack vs dodge: attacker hits when they succeed and defender fails', () => {
    // attacker roll 20 under attack(60) success, defender roll 90 over dodge(40) fail
    const dice = makeDiceFromD100([20, 90])
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Mage' })

    const game = createGame({ id: 'rpg_1', players: [attacker, defender] })
    const before = game.party.find((p) => p.name === 'd')!.hp

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)
    const after = game.party.find((p) => p.name === 'd')!.hp
    expect(after).toBeLessThan(before)
  })

  it('experience: successful attack improves attack skill', () => {
    const dice = makeDiceFromD100([10, 100])
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Warrior' })

    const game = createGame({ id: 'rpg_1', players: [attacker, defender] })
    const before = game.party.find((p) => p.name === 'a')!.skills.attack

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)

    const after = game.party.find((p) => p.name === 'a')!.skills.attack
    expect(after).toBe(before + 1)
  })

  it('explore advances rooms and sets combat mode on combat rooms', () => {
    const dice = makeDiceFromD100([50])
    const game = createGame({
      id: 'rpg_1',
      players: ['alice', 'bob'],
      dice,
      dungeon: [
        { type: 'rest', description: 'A quiet alcove.' },
        { type: 'combat', description: 'Goblins!', enemies: [{ name: 'Goblin', hp: 6, DEX: 40, attack: 30, dodge: 20 }] },
      ],
    })

    expect(game.mode).toBe('exploring')
    expect(game.roomIndex).toBe(0)

    explore(game, { dice })
    expect(game.roomIndex).toBe(1)
    expect(game.mode).toBe('combat')
  })
})
