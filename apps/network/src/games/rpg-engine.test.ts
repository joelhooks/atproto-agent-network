import { describe, expect, it } from 'vitest'

import {
  attack,
  createCharacter,
  createGame,
  createTestDice,
  generateDungeon,
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

  it('default dungeon includes all encounter types (combat, trap, treasure, rest, puzzle)', () => {
    // defaultDungeon() is procedural (uses Math.random), so test generateDungeon() deterministically instead.
    const dice = createTestDice({ d100: () => 1, d: () => 1 })
    const dungeon = generateDungeon(12, dice)

    const types = new Set(dungeon.map((r) => r.type))
    expect(types.has('combat')).toBe(true)
    expect(types.has('trap')).toBe(true)
    expect(types.has('treasure')).toBe(true)
    expect(types.has('rest')).toBe(true)
    expect(types.has('puzzle')).toBe(true)
    expect(types.has('barrier')).toBe(true)
    expect(types.has('boss')).toBe(true)
  })

  it('generateDungeon creates the requested number of rooms, contains all 4 class barriers, and ends with a boss room', () => {
    const dice = createTestDice({ d100: () => 1, d: () => 1 })
    const dungeon = generateDungeon(12, dice)

    expect(dungeon).toHaveLength(12)
    expect(dungeon.at(-1)?.type).toBe('boss')

    const barriers = dungeon.filter((r) => r.type === 'barrier')
    expect(barriers).toHaveLength(4)

    const required = new Set(barriers.map((b) => b.requiredClass))
    expect(required).toEqual(new Set<RpgClass>(['Warrior', 'Scout', 'Mage', 'Healer']))
  })

  it('generateDungeon scales enemy HP (early 6-8, mid 10-14, boss 30+)', () => {
    const dice = createTestDice({ d100: () => 1, d: () => 1 })
    const dungeon = generateDungeon(12, dice)

    const last = dungeon.at(-1)
    expect(last?.type).toBe('boss')
    if (last?.type === 'boss') {
      expect(last.enemies[0]!.hp).toBeGreaterThanOrEqual(30)
    }

    const midpoint = Math.floor(dungeon.length / 2)
    const combats = dungeon
      .map((room, index) => ({ room, index }))
      .filter((x) => x.room.type === 'combat')

    const earlyCombats = combats.filter((c) => c.index < midpoint).map((c) => c.room)
    const midCombats = combats.filter((c) => c.index >= midpoint).map((c) => c.room)

    expect(earlyCombats.length).toBeGreaterThan(0)
    expect(midCombats.length).toBeGreaterThan(0)

    for (const room of earlyCombats) {
      if (room.type !== 'combat') continue
      for (const e of room.enemies) {
        expect(e.hp).toBeGreaterThanOrEqual(6)
        expect(e.hp).toBeLessThanOrEqual(8)
      }
    }

    for (const room of midCombats) {
      if (room.type !== 'combat') continue
      for (const e of room.enemies) {
        expect(e.hp).toBeGreaterThanOrEqual(10)
        expect(e.hp).toBeLessThanOrEqual(14)
      }
    }
  })

  it('rest rooms heal the party (capped at max)', () => {
    const dice = makeDiceFromD100([50])
    const a = createCharacter({ name: 'a', klass: 'Warrior' })
    const b = createCharacter({ name: 'b', klass: 'Mage' })
    a.hp = Math.max(0, a.hp - 3)
    b.hp = Math.max(0, b.hp - 3)

    const game = createGame({
      id: 'rpg_1',
      players: [a, b],
      dungeon: [
        { type: 'treasure', description: 'Coins.' },
        { type: 'rest', description: 'A quiet alcove.' },
      ],
    })

    const aBefore = game.party.find((p) => p.name === 'a')!.hp
    const bBefore = game.party.find((p) => p.name === 'b')!.hp

    explore(game, { dice })
    expect(game.roomIndex).toBe(1)

    const aAfter = game.party.find((p) => p.name === 'a')!.hp
    const bAfter = game.party.find((p) => p.name === 'b')!.hp
    expect(aAfter).toBeGreaterThan(aBefore)
    expect(bAfter).toBeGreaterThan(bBefore)
    expect(aAfter).toBeLessThanOrEqual(a.maxHp)
    expect(bAfter).toBeLessThanOrEqual(b.maxHp)
  })
})
