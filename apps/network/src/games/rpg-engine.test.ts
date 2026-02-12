import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  attack,
  adjustDisposition,
  awardXp,
  createHubTownState,
  advanceHubTownIdleTurns,
  createCharacter,
  createGame,
  createTestDice,
  generateDungeon,
  explore,
  XP_PER_BARRIER_CLEAR,
  XP_PER_PUZZLE,
  XP_PER_TRAP_DISARM,
  XP_PER_TREASURE_FIND,
  XP_TABLE,
  resolveSkillCheck,
  rollD100,
  soloMultiplier,
  partyWipe,
  healOther,
  taunt,
  aoeSpell,
  disarmTrap,
  enemyTakeTurn,
  getDispositionTier,
  selectTarget,
  attackEnemy,
  type RpgClass,
  type CampaignState,
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

function makeDice(input: { d100Rolls: number[]; dRolls?: number[]; defaultDRoll?: number }) {
  const { d100Rolls, dRolls = [], defaultDRoll = 1 } = input
  let i = 0
  let j = 0
  return createTestDice({
    d100: () => {
      const next = d100Rolls[i++]
      if (next == null) return 100
      return next
    },
    d: (_sides: number) => {
      const next = dRolls[j++]
      if (next == null) return defaultDRoll
      return next
    },
  })
}

describe('rpg-engine', () => {
  it('soloMultiplier scales danger for smaller parties', () => {
    expect(soloMultiplier(1)).toBe(2.0)
    expect(soloMultiplier(2)).toBe(1.5)
    expect(soloMultiplier(3)).toBe(1.0)
    expect(soloMultiplier(4)).toBe(1.0)
  })

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

  it('opposed rolls: both succeed compares margins; defender wins ties', () => {
    // attacker attack 60 roll 45 => margin 15
    // defender dodge 40 roll 25 => margin 15 (tie => miss)
    const dice = makeDice({ d100Rolls: [45, 25] })
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Scout' })
    attacker.skills.attack = 60
    defender.skills.dodge = 40
    defender.hp = 30

    const game = createGame({ id: 'rpg_1', players: [attacker, defender] })
    const before = game.party.find((p) => p.name === 'd')!.hp

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)
    expect(result.hit).toBe(false)
    const after = game.party.find((p) => p.name === 'd')!.hp
    expect(after).toBe(before)
  })

  it('opposed rolls: both fail is always a miss', () => {
    const dice = makeDice({ d100Rolls: [90, 90] })
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Scout' })
    attacker.skills.attack = 10
    defender.skills.dodge = 10
    defender.hp = 30

    const game = createGame({ id: 'rpg_1', players: [attacker, defender] })
    const before = game.party.find((p) => p.name === 'd')!.hp

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)
    expect(result.hit).toBe(false)
    const after = game.party.find((p) => p.name === 'd')!.hp
    expect(after).toBe(before)
  })

  it('critical hits (roll <= skill/5) deal double damage', () => {
    // attack skill 50 => crit on 10 or less. Defender fails dodge.
    // base damage: d6(6) + STR bonus(3) = 9; crit => 18
    const dice = makeDice({ d100Rolls: [10, 100], dRolls: [6] })
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Warrior' })
    attacker.skills.attack = 50
    defender.skills.dodge = 1
    defender.hp = 30

    const game = createGame({ id: 'rpg_crit', players: [attacker, defender] })
    const before = game.party.find((p) => p.name === 'd')!.hp

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)
    expect(result.hit).toBe(true)
    const after = game.party.find((p) => p.name === 'd')!.hp
    expect(after).toBe(before - 18)
  })

  it('fumbles (roll 96+) cause the attacker to hurt themselves for half damage', () => {
    // attacker fumbles on 96; self damage is floor((d6(6) + STR bonus(3)) / 2) = 4
    const dice = makeDice({ d100Rolls: [96, 1], dRolls: [6] })
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Warrior' })
    attacker.skills.attack = 99
    attacker.hp = 30
    defender.skills.dodge = 1
    defender.hp = 30

    const game = createGame({ id: 'rpg_fumble', players: [attacker, defender] })
    const beforeAttacker = game.party.find((p) => p.name === 'a')!.hp
    const beforeDefender = game.party.find((p) => p.name === 'd')!.hp

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)
    expect(result.hit).toBe(false)
    const afterAttacker = game.party.find((p) => p.name === 'a')!.hp
    const afterDefender = game.party.find((p) => p.name === 'd')!.hp
    expect(afterAttacker).toBe(beforeAttacker - 4)
    expect(afterDefender).toBe(beforeDefender)
  })

  it('damage calculation applies armor reduction when present', () => {
    // base damage: d6(6) + STR bonus(3) = 9; armor 2 => 7
    const dice = makeDice({ d100Rolls: [20, 100], dRolls: [6] })
    const attacker = createCharacter({ name: 'a', klass: 'Warrior' })
    const defender = createCharacter({ name: 'd', klass: 'Warrior' })
    attacker.skills.attack = 60
    defender.skills.dodge = 1
    defender.armor = 2
    defender.hp = 30

    const game = createGame({ id: 'rpg_armor', players: [attacker, defender] })
    const before = game.party.find((p) => p.name === 'd')!.hp

    const result = attack(game, { attacker: 'a', defender: 'd', dice })
    expect(result.ok).toBe(true)
    expect(result.hit).toBe(true)
    const after = game.party.find((p) => p.name === 'd')!.hp
    expect(after).toBe(before - 7)
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

  it('traps deal d6+2 damage on failed check', () => {
    const dice = makeDiceFromD100([100]) // force fail on trap use_skill
    const solo = createCharacter({ name: 'alice', klass: 'Warrior' })
    solo.skills.use_skill = 1
    solo.hp = 15

    const game = createGame({
      id: 'rpg_trap_solo',
      players: [solo],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'trap', description: 'click' },
        { type: 'rest', description: 'after' },
      ],
    })

    const before = game.party[0]!.hp
    explore(game, { dice })
    const dmgTaken = before - game.party[0]!.hp
    expect(dmgTaken).toBeGreaterThanOrEqual(3) // d6+2 = 3-8
    expect(dmgTaken).toBeLessThanOrEqual(8)
  })

  it('partyWipe finishes the adventure when everyone hits 0 HP', () => {
    const solo = createCharacter({ name: 'alice', klass: 'Warrior' })
    solo.hp = 0

    const game = createGame({ id: 'rpg_wipe', players: [solo] })
    expect(partyWipe(game)).toBe(true)
    expect(game.phase).toBe('finished')
    expect(game.mode).toBe('finished')
  })

  it('damage events trigger party wipe when the party is downed', () => {
    const dice = makeDiceFromD100([100]) // force trap fail
    const solo = createCharacter({ name: 'alice', klass: 'Warrior' })
    solo.skills.use_skill = 1
    solo.hp = 3

    const game = createGame({
      id: 'rpg_wipe_trap',
      players: [solo],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'trap', description: 'click' },
        { type: 'rest', description: 'after' },
      ],
    })

    explore(game, { dice }) // trap deals 4, wipes
    expect(game.party[0]!.hp).toBe(0)
    expect(game.phase).toBe('finished')
    expect(game.mode).toBe('finished')
  })

  it('default dungeon includes all encounter types (combat, trap, treasure, rest, puzzle)', () => {
    // defaultDungeon() is procedural (uses Math.random), so test generateDungeon() deterministically instead.
    const dice = createTestDice({ d100: () => 1, d: () => 1 })
    const dungeon = generateDungeon(12, dice).rooms

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
    const dungeon = generateDungeon(12, dice).rooms

    expect(dungeon).toHaveLength(12)
    expect(dungeon.at(-1)?.type).toBe('boss')

    const barriers = dungeon.filter((r) => r.type === 'barrier')
    expect(barriers).toHaveLength(4)

    const required = new Set(barriers.map((b) => b.requiredClass))
    expect(required).toEqual(new Set<RpgClass>(['Warrior', 'Scout', 'Mage', 'Healer']))
  })

  it('generateDungeon scales enemy HP (early 6-8, mid 10-14, boss 30+)', () => {
    const dice = createTestDice({ d100: () => 1, d: () => 1 })
    const dungeon = generateDungeon(12, dice).rooms

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
        // Bestiary: early enemies range from Kobold (hp 3+1d2=4-5) to Carcass Crawler (hp 10+1d6=11-16)
        expect(e.hp).toBeGreaterThanOrEqual(4)
        expect(e.hp).toBeLessThanOrEqual(20)
      }
    }

    for (const room of midCombats) {
      if (room.type !== 'combat') continue
      for (const e of room.enemies) {
        // Bestiary: mid enemies range from Hobgoblin (hp 8+1d4=9-12) to Ogre (hp 16+1d8=17-24)
        expect(e.hp).toBeGreaterThanOrEqual(8)
        expect(e.hp).toBeLessThanOrEqual(30)
      }
    }
  })

  it('generated dungeons include a theme + backstory and room descriptions reference the theme', () => {
    const game = createGame({ id: 'rpg_theme_default', players: ['alice', 'bob'] })

    expect(game.theme.name.length).toBeGreaterThan(0)
    expect(game.theme.backstory.length).toBeGreaterThan(0)

    for (const room of game.dungeon) {
      expect(room.description).toContain(game.theme.name)
      expect(room.description.toLowerCase()).not.toContain('goblin prowls here')
    }
  })

  it('10 generated dungeons can have unique themes', () => {
    function makeThemePickingDice(themePick: number) {
      let picked = false
      return createTestDice({
        d100: () => 1,
        d: (sides: number) => {
          if (!picked) {
            picked = true
            const value = Math.max(1, Math.min(sides, themePick))
            return value
          }
          return 1
        },
      })
    }

    const themes = new Set<string>()
    for (let i = 1; i <= 10; i += 1) {
      const dungeon = generateDungeon(12, makeThemePickingDice(i))
      themes.add(dungeon.theme.name)
    }
    expect(themes.size).toBe(10)
  })

  it('barrier rooms only require classes present in the party', () => {
    const allowed = new Set<RpgClass>(['Warrior', 'Mage'])

    for (let i = 0; i < 100; i += 1) {
      const game = createGame({
        id: `rpg_barrier_${i}`,
        players: [createCharacter({ name: 'a', klass: 'Warrior' }), createCharacter({ name: 'b', klass: 'Mage' })],
      })

      const barriers = game.dungeon.filter((r) => r.type === 'barrier')
      for (const room of barriers) {
        if (room.type !== 'barrier') continue
        expect(allowed.has(room.requiredClass)).toBe(true)
      }
    }
  })

  it('barriers: brute force path lets any Warrior smash through at 20% max HP cost', () => {
    const dice = makeDiceFromD100([100]) // unused for brute force
    const warrior = createCharacter({ name: 'w', klass: 'Warrior' })
    const scout = createCharacter({ name: 's', klass: 'Scout' })

    const game = createGame({
      id: 'rpg_barrier_bruteforce',
      players: [warrior, scout],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'barrier', description: 'A sealed gate.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 's'

    const beforeHp = warrior.hp
    const expectedCost = Math.ceil(warrior.maxHp * 0.2)
    const result = explore(game, { dice })

    expect(result.room?.type).toBe('barrier')
    expect(game.roomIndex).toBe(1)
    expect(warrior.hp).toBe(beforeHp - expectedCost)
    expect(game.log.some((e) => e.what.includes('barrier: brute_force'))).toBe(true)
  })

  it('barriers: skill check path (hard 30%) lets any class pass on success', () => {
    const dice = makeDiceFromD100([30]) // succeed at 30%
    const scout = createCharacter({ name: 's', klass: 'Scout' })
    scout.mp = 0 // ensure MP sacrifice cannot happen

    const game = createGame({
      id: 'rpg_barrier_skillcheck',
      players: [scout],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'barrier', description: 'An ancient seal.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 's'

    const result = explore(game, { dice })
    expect(result.room?.type).toBe('barrier')
    expect(game.roomIndex).toBe(1)
    expect(game.log.some((e) => e.what.includes('barrier: skill_check'))).toBe(true)
  })

  it('barriers: MP sacrifice path spends 50% max MP to force it open', () => {
    const dice = makeDiceFromD100([99]) // fail skill check, then use MP sacrifice
    const scout = createCharacter({ name: 's', klass: 'Scout' })

    const game = createGame({
      id: 'rpg_barrier_mp',
      players: [scout],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'barrier', description: 'A rune-locked door.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 's'

    const beforeMp = scout.mp
    const expectedCost = Math.ceil(scout.maxMp * 0.5)
    const result = explore(game, { dice })

    expect(result.room?.type).toBe('barrier')
    expect(game.roomIndex).toBe(1)
    expect(scout.mp).toBe(beforeMp - expectedCost)
    expect(game.log.some((e) => e.what.includes('barrier: mp_sacrifice'))).toBe(true)
  })

  it('barriers: auto-crumble triggers after exactly 5 failed attempts on the same barrier', () => {
    const dice = makeDiceFromD100([99, 99, 99, 99, 99]) // always fail skill checks
    const scout = createCharacter({ name: 's', klass: 'Scout' })
    scout.mp = 0 // ensure MP sacrifice cannot happen

    const game = createGame({
      id: 'rpg_barrier_crumble',
      players: [scout],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'barrier', description: 'A stubborn stone seal.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 's'

    for (let i = 1; i <= 4; i += 1) {
      explore(game, { dice })
      expect(game.roomIndex).toBe(0)
      expect((game as any).barrierAttempts?.['1']).toBe(i)
    }

    explore(game, { dice })
    expect(game.roomIndex).toBe(1)
    expect((game as any).barrierAttempts?.['1']).toBe(5)
    expect(game.log.some((e) => e.what.includes('barrier: auto_crumble'))).toBe(true)
  })

  it('stuck detection: repeating the same action 5x triggers GM intervention and advances', () => {
    const dice = makeDiceFromD100([99, 99, 99, 99, 99]) // always fail barrier skill checks
    const scout = createCharacter({ name: 's', klass: 'Scout' })
    scout.mp = 0 // ensure MP sacrifice cannot happen

    const game = createGame({
      id: 'rpg_stuck_detection',
      players: [scout],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'barrier', description: 'A sealed gate.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 's'

    for (let i = 0; i < 4; i += 1) {
      explore(game, { dice })
      expect(game.roomIndex).toBe(0)
    }

    explore(game, { dice })
    expect(game.roomIndex).toBe(1)

    expect(game.log.some((e) => e.who === 'GM' && e.what.includes('warning: stuck_detected'))).toBe(true)
    expect(game.log.some((e) => e.who === 'GM' && e.what.includes('gm: auto_resolve barrier'))).toBe(true)
    expect(game.log.some((e) => e.who === 'GM' && e.what === 'The dungeon shifts around you, opening a new path...')).toBe(true)
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

  // --- Role Synergy Tests ---

  describe('healOther', () => {
    function makePartyGame() {
      const healer = createCharacter({ name: 'healer', klass: 'Healer' })
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })
      warrior.hp = 1
      const game = createGame({
        id: 'rpg_heal',
        players: [healer, warrior],
        dungeon: [{ type: 'rest', description: 'start' }],
      })
      return game
    }

    it('healer restores HP to ally', () => {
      const game = makePartyGame()
      const dice = createTestDice({ d100: () => 50, d: () => 3 })
      const result = healOther(game, 'healer', 'warrior', dice)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.amount).toBe(13) // 10 + 3
        expect(result.healed).toBe('warrior')
      }
      const w = game.party.find((p) => p.name === 'warrior')!
      expect(w.hp).toBe(Math.min(w.maxHp, 1 + 13))
    })

    it('wrong class gets rejected', () => {
      const game = makePartyGame()
      const dice = createTestDice({ d100: () => 50, d: () => 3 })
      const result = healOther(game, 'warrior', 'healer', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('requires_healer')
    })

    it('solo player gets rejected', () => {
      const healer = createCharacter({ name: 'healer', klass: 'Healer' })
      const game = createGame({
        id: 'rpg_solo',
        players: [healer],
        dungeon: [{ type: 'rest', description: 'start' }],
      })
      const dice = createTestDice({ d100: () => 50, d: () => 3 })
      const result = healOther(game, 'healer', 'healer', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('need_party')
    })

    it('costs 5 MP', () => {
      const game = makePartyGame()
      const healer = game.party.find((p) => p.name === 'healer')!
      const mpBefore = healer.mp
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      healOther(game, 'healer', 'warrior', dice)
      expect(healer.mp).toBe(mpBefore - 5)
    })
  })

  describe('taunt', () => {
    function makePartyGame() {
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })
      const mage = createCharacter({ name: 'mage', klass: 'Mage' })
      return createGame({
        id: 'rpg_taunt',
        players: [warrior, mage],
        dungeon: [{ type: 'rest', description: 'start' }],
      })
    }

    it('warrior can taunt', () => {
      const game = makePartyGame()
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      const result = taunt(game, 'warrior', dice)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.taunting).toBe(true)
      const w = game.party.find((p) => p.name === 'warrior')! as any
      expect(w.taunting).toBe(true)
    })

    it('wrong class gets rejected', () => {
      const game = makePartyGame()
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      const result = taunt(game, 'mage', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('requires_warrior')
    })

    it('solo player gets rejected', () => {
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })
      const game = createGame({
        id: 'rpg_solo',
        players: [warrior],
        dungeon: [{ type: 'rest', description: 'start' }],
      })
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      const result = taunt(game, 'warrior', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('need_party')
    })
  })

  describe('aoeSpell', () => {
    function makePartyGame() {
      const mage = createCharacter({ name: 'mage', klass: 'Mage' })
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })
      const game = createGame({
        id: 'rpg_aoe',
        players: [mage, warrior],
        dungeon: [
          { type: 'combat', description: 'Goblins!', enemies: [
            { name: 'Goblin A', hp: 20, DEX: 40, attack: 30, dodge: 20 },
            { name: 'Goblin B', hp: 20, DEX: 40, attack: 30, dodge: 20 },
          ]},
        ],
      })
      return game
    }

    it('mage deals damage to all enemies', () => {
      const game = makePartyGame()
      const dice = createTestDice({ d100: () => 50, d: () => 4 }) // 8+4=12 per enemy
      const result = aoeSpell(game, 'mage', dice)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.totalDamage).toBe(24) // 12 * 2
      for (const e of game.combat!.enemies) {
        expect(e.hp).toBe(8) // 20 - 12
      }
    })

    it('wrong class gets rejected', () => {
      const game = makePartyGame()
      const dice = createTestDice({ d100: () => 50, d: () => 4 })
      const result = aoeSpell(game, 'warrior', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('requires_mage')
    })

    it('solo player gets rejected', () => {
      const mage = createCharacter({ name: 'mage', klass: 'Mage' })
      const game = createGame({
        id: 'rpg_solo',
        players: [mage],
        dungeon: [{ type: 'rest', description: 'start' }],
      })
      const dice = createTestDice({ d100: () => 50, d: () => 4 })
      const result = aoeSpell(game, 'mage', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('need_party')
    })

    it('costs 8 MP', () => {
      const game = makePartyGame()
      const mage = game.party.find((p) => p.name === 'mage')!
      const mpBefore = mage.mp
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      aoeSpell(game, 'mage', dice)
      expect(mage.mp).toBe(mpBefore - 8)
    })
  })

  describe('disarmTrap', () => {
    function makePartyGame() {
      const scout = createCharacter({ name: 'scout', klass: 'Scout' })
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })
      return createGame({
        id: 'rpg_disarm',
        players: [scout, warrior],
        dungeon: [{ type: 'trap', description: 'A pressure plate.' }],
      })
    }

    it('scout disarms trap with +30 bonus (auto-success on high skill)', () => {
      const game = makePartyGame()
      // Scout use_skill is ~50. +30 = 80. Roll 70 <= 80 → success
      const dice = makeDiceFromD100([70])
      const result = disarmTrap(game, 'scout', dice)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.disarmed).toBe(true)
    })

    it('wrong class gets rejected', () => {
      const game = makePartyGame()
      const dice = makeDiceFromD100([50])
      const result = disarmTrap(game, 'warrior', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('requires_scout')
    })

    it('solo player gets rejected', () => {
      const scout = createCharacter({ name: 'scout', klass: 'Scout' })
      const game = createGame({
        id: 'rpg_solo',
        players: [scout],
        dungeon: [{ type: 'rest', description: 'start' }],
      })
      const dice = makeDiceFromD100([50])
      const result = disarmTrap(game, 'scout', dice)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('need_party')
    })
  })

  describe('enemy tactics', () => {
    it('goblins target the Mage when present (hit-and-run squishy focus)', () => {
      const warrior = createCharacter({ name: 'w', klass: 'Warrior' })
      const healer = createCharacter({ name: 'h', klass: 'Healer' })
      const mage = createCharacter({ name: 'm', klass: 'Mage' })

      // Make the healer the lowest HP to prove goblins still prefer a Mage.
      healer.hp = 1
      mage.hp = 10

      const game = createGame({
        id: 'rpg_goblin_target_mage',
        players: [warrior, healer, mage],
        dungeon: [{ type: 'combat', description: 'fight', enemies: [{ name: 'Goblin', hp: 10, DEX: 40, attack: 30, dodge: 20 }] }],
      })

      const enemy = { name: 'Goblin', hp: 10, maxHp: 10, DEX: 40, attack: 30, dodge: 20, tactics: { kind: 'goblin' as const } }
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      const target = selectTarget({ enemy, party: game.party, dice })
      expect(target?.name).toBe('m')
    })

    it('goblins target the lowest-HP living character when no Mage is present', () => {
      const warrior = createCharacter({ name: 'w', klass: 'Warrior' })
      const healer = createCharacter({ name: 'h', klass: 'Healer' })
      warrior.hp = 8
      healer.hp = 3

      const enemy = { name: 'Goblin', hp: 10, maxHp: 10, DEX: 40, attack: 30, dodge: 20, tactics: { kind: 'goblin' as const } }
      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      const target = selectTarget({ enemy, party: [warrior, healer], dice })
      expect(target?.name).toBe('h')
    })

    it('goblins flee when below 30% HP', () => {
      const warrior = createCharacter({ name: 'w', klass: 'Warrior' })
      const healer = createCharacter({ name: 'h', klass: 'Healer' })
      const game = createGame({
        id: 'rpg_goblin_flee',
        players: [warrior, healer],
        dungeon: [
          {
            type: 'combat',
            description: 'fight',
            enemies: [
              { name: 'Goblin', hp: 2, maxHp: 10, DEX: 40, attack: 30, dodge: 20, tactics: { kind: 'goblin' } },
            ],
          },
        ],
      })

      const dice = createTestDice({ d100: () => 50, d: () => 1 })
      const result = enemyTakeTurn(game, { dice })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action).toBe('flee')
        expect(game.combat!.enemies[0]!.hp).toBe(0)
      }
    })

    it('orcs use power attack (+10 damage, -10 hit chance)', () => {
      const warrior = createCharacter({ name: 'w', klass: 'Warrior' })
      const mage = createCharacter({ name: 'm', klass: 'Mage' })
      warrior.hp = 30
      mage.hp = 30

      const game = createGame({
        id: 'rpg_orc_power',
        players: [warrior, mage],
        dungeon: [
          {
            type: 'combat',
            description: 'fight',
            enemies: [{ name: 'Orc', hp: 20, maxHp: 20, DEX: 45, attack: 40, dodge: 25, tactics: { kind: 'orc' } }],
          },
        ],
      })

      // Enemy attack roll 20 succeeds; defender dodge roll 100 fails; damage roll 2.
      // Power attack adds +10 damage.
      const dice = makeDice({ d100Rolls: [20, 100], dRolls: [2] })
      const hpBefore = game.party.find((p) => p.name === 'w')!.hp
      enemyTakeTurn(game, { dice })
      const hpAfter = game.party.find((p) => p.name === 'w')!.hp
      const expectedDamage = Math.floor(2 * soloMultiplier(game.party.length)) + 10
      expect(hpAfter).toBe(hpBefore - expectedDamage)

      // Prove the -10 hit chance matters: roll 25 would succeed on skill 30, but fails at 20.
      const game2 = createGame({
        id: 'rpg_orc_power_miss',
        players: [createCharacter({ name: 'w', klass: 'Warrior' }), createCharacter({ name: 'm', klass: 'Mage' })],
        dungeon: [
          {
            type: 'combat',
            description: 'fight',
            enemies: [{ name: 'Orc', hp: 20, maxHp: 20, DEX: 45, attack: 30, dodge: 25, tactics: { kind: 'orc' } }],
          },
        ],
      })
      const dice2 = makeDice({ d100Rolls: [25, 100], dRolls: [6] })
      const before2 = game2.party.find((p) => p.name === 'w')!.hp
      enemyTakeTurn(game2, { dice: dice2 })
      const after2 = game2.party.find((p) => p.name === 'w')!.hp
      expect(after2).toBe(before2)
    })

    it('skeletons target random living party members', () => {
      const a = createCharacter({ name: 'a', klass: 'Warrior' })
      const b = createCharacter({ name: 'b', klass: 'Scout' })
      const c = createCharacter({ name: 'c', klass: 'Healer' })
      const enemy = { name: 'Skeleton', hp: 10, maxHp: 10, DEX: 40, attack: 30, dodge: 20, tactics: { kind: 'skeleton' as const } }

      // rollDie(d, 3) => 2 => index 1 => 'b'
      const dice = createTestDice({ d100: () => 50, d: () => 2 })
      const target = selectTarget({ enemy, party: [a, b, c], dice })
      expect(target?.name).toBe('b')
    })

    it('skeletons are resistant to piercing and vulnerable to blunt when attacked', () => {
      const scout = createCharacter({ name: 'scout', klass: 'Scout' })
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })
      const game = createGame({
        id: 'rpg_skeleton_resist',
        players: [scout, warrior],
        dungeon: [
          {
            type: 'combat',
            description: 'fight',
            enemies: [{ name: 'Skeleton', hp: 30, maxHp: 30, DEX: 40, attack: 30, dodge: 1, tactics: { kind: 'skeleton' } }],
          },
        ],
      })

      // Two attacks. Always hit (dodge fails). Base dmg for both is d6(6) + STR bonus (scout 1, warrior 3).
      const dice = makeDice({ d100Rolls: [10, 100, 10, 100], dRolls: [6, 6] })
      const e = game.combat!.enemies[0]!

      const beforePierce = e.hp
      attackEnemy(game, { attacker: 'scout', enemyIndex: 0, dice })
      const afterPierce = e.hp
      expect(afterPierce).toBe(beforePierce - 3) // floor((6+1)*0.5)=3

      const beforeBlunt = e.hp
      attackEnemy(game, { attacker: 'warrior', enemyIndex: 0, dice })
      const afterBlunt = e.hp
      expect(afterBlunt).toBe(beforeBlunt - 13) // floor((6+3)*1.5)=13
    })

    it('bosses have 2 phases: healer focus above 50% HP, enraged AoE below 50% HP', () => {
      const healer = createCharacter({ name: 'healer', klass: 'Healer' })
      const mage = createCharacter({ name: 'mage', klass: 'Mage' })
      const warrior = createCharacter({ name: 'warrior', klass: 'Warrior' })

      const game = createGame({
        id: 'rpg_boss_phases',
        players: [healer, mage, warrior],
        dungeon: [
          {
            type: 'boss',
            description: 'fight',
            enemies: [{ name: 'Dungeon Boss', hp: 20, maxHp: 20, DEX: 55, attack: 55, dodge: 35, tactics: { kind: 'boss', specialEveryTurns: 3 } }],
          },
        ],
      })

      const boss = game.combat!.enemies[0]!
      const dice = createTestDice({ d100: () => 50, d: () => 6 })
      const target = selectTarget({ enemy: boss, party: game.party, dice })
      expect(target?.name).toBe('healer')

      // Bloodied: phase 2 (AoE). AoE is half of enraged damage.
      boss.hp = 9 // < 50% of 20
      const hpBefore = new Map(game.party.map((p) => [p.name, p.hp]))
      const dice2 = createTestDice({ d100: () => 50, d: () => 6 })
      const turn = enemyTakeTurn(game, { dice: dice2 })
      expect(turn.ok).toBe(true)
      if (turn.ok) {
        expect(turn.targets.sort()).toEqual(['healer', 'mage', 'warrior'].sort())
        for (const member of game.party) {
          expect(member.hp).toBe((hpBefore.get(member.name) ?? 0) - 3) // floor(floor(6*1.2)/2)=3
        }
      }
    })
  })
})

// ── Persistent character helpers ──────────────────────────────────────

import { persistentToGameCharacter, gameCharacterToPersistent } from './rpg-engine'
import type { PersistentCharacter } from '@atproto-agent/core'

describe('persistentToGameCharacter', () => {
  it('resets HP/MP to max values', () => {
    const pc: PersistentCharacter = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 3,
      xp: 500,
      maxHp: 20,
      maxMp: 5,
      skills: { attack: 60, dodge: 30, cast_spell: 10, use_skill: 40 },
      backstory: 'A dwarf from the Iron Hills.',
      motivation: 'Recover the lost crown.',
      appearance: 'Broad shoulders, braided beard.',
      personalityTraits: ['stubborn', 'loyal'],
      adventureLog: ['Adventure 1'],
      achievements: [],
      inventory: [
        {
          name: 'Sword',
          rarity: 'common',
          slot: 'weapon',
          effects: [{ stat: 'attack', bonus: 2 }],
          description: 'A reliable steel blade.',
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      gamesPlayed: 5,
      deaths: 1,
      dead: false,
    }
    const gc = persistentToGameCharacter(pc, 'player1')
    expect(gc.hp).toBe(20)
    expect(gc.maxHp).toBe(20)
    expect(gc.mp).toBe(5)
    expect(gc.maxMp).toBe(5)
    expect(gc.agent).toBe('player1')
    expect(gc.skills.attack).toBe(60)
  })

  it('does not revive a dead persistent character', () => {
    const pc = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 6,
      xp: 2000,
      maxHp: 45,
      maxMp: 20,
      skills: { attack: 95, dodge: 80, cast_spell: 10, use_skill: 60 },
      backstory: 'Veteran',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: ['A final stand'],
      achievements: ['Dragon Slayer'],
      inventory: [
        {
          name: 'Legendary Axe',
          rarity: 'legendary',
          slot: 'weapon',
          effects: [{ stat: 'attack', bonus: 10 }],
          description: 'A once-in-an-era relic weapon.',
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      gamesPlayed: 9,
      deaths: 3,
      dead: true,
    } as any as PersistentCharacter

    const gc = persistentToGameCharacter(pc, 'player1')

    expect(gc.maxHp).toBeLessThan(45)
    expect(gc.maxMp).toBeLessThan(20)
    expect(gc.skills.attack).toBeLessThan(95)
  })
})

describe('gameCharacterToPersistent', () => {
  it('increments gamesPlayed and deaths when hp <= 0', () => {
    const gc = createCharacter({ name: 'Thorin', klass: 'Warrior', agent: 'p1' })
    gc.hp = 0 // dead
    const existing: PersistentCharacter = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 1,
      xp: 0,
      maxHp: gc.maxHp,
      maxMp: gc.maxMp,
      skills: { ...gc.skills },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: [],
      achievements: [],
      inventory: [],
      createdAt: 1000,
      updatedAt: 1000,
      gamesPlayed: 3,
      deaths: 1,
      dead: false,
    }
    const result = gameCharacterToPersistent(gc, existing, 'Defeated by dragon')
    expect(result.gamesPlayed).toBe(4)
    expect(result.deaths).toBe(2)
  })

  it('does not increment deaths when hp > 0', () => {
    const gc = createCharacter({ name: 'Thorin', klass: 'Warrior', agent: 'p1' })
    const result = gameCharacterToPersistent(gc, null, 'Victory!')
    expect(result.gamesPlayed).toBe(1)
    expect(result.deaths).toBe(0)
  })

  it('caps adventureLog at 10 entries', () => {
    const gc = createCharacter({ name: 'Thorin', klass: 'Warrior', agent: 'p1' })
    const existing: PersistentCharacter = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 1,
      xp: 0,
      maxHp: gc.maxHp,
      maxMp: gc.maxMp,
      skills: { ...gc.skills },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: Array.from({ length: 12 }, (_, i) => `Log ${i}`),
      achievements: [],
      inventory: [],
      createdAt: 1000,
      updatedAt: 1000,
      gamesPlayed: 12,
      deaths: 0,
      dead: false,
    }
    const result = gameCharacterToPersistent(gc, existing, 'New adventure')
    expect(result.adventureLog.length).toBe(10)
    expect(result.adventureLog[9]).toBe('New adventure')
  })

  it('marks permanent death metadata and clears inventory on death', () => {
    const gc = createCharacter({ name: 'Thorin', klass: 'Warrior', agent: 'p1' })
    gc.hp = 0
    ;(gc as any).deathCause = 'slain by Cave Troll in Ashen Reliquary'

    const existing: PersistentCharacter = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 2,
      xp: 220,
      maxHp: gc.maxHp,
      maxMp: gc.maxMp,
      skills: { ...gc.skills },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: ['Won a duel'],
      achievements: ['Bronze Hero'],
      inventory: [
        {
          name: 'Axe',
          rarity: 'common',
          slot: 'weapon',
          effects: [{ stat: 'attack', bonus: 2 }],
          description: 'A sturdy camp axe.',
        },
        {
          name: 'Torch',
          rarity: 'common',
          slot: 'trinket',
          effects: [],
          description: 'A simple light source.',
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
      gamesPlayed: 3,
      deaths: 1,
      dead: false,
    }

    const result = gameCharacterToPersistent(gc, existing, 'Defeated by dragon')

    expect(result.dead).toBe(true)
    expect(typeof result.diedAt).toBe('number')
    expect(result.causeOfDeath).toContain('Cave Troll')
    expect(result.inventory).toEqual([])
    expect(result.adventureLog).toEqual(expect.arrayContaining(['Won a duel', 'Defeated by dragon']))
    expect(result.achievements).toEqual(['Bronze Hero'])
  })

  it('persists living character inventory from in-game loot state', () => {
    const gc = createCharacter({ name: 'Thorin', klass: 'Warrior', agent: 'p1' })
    ;(gc as any).inventory = [
      {
        name: 'Silvered Shortsword',
        rarity: 'uncommon',
        slot: 'weapon',
        effects: [{ stat: 'attack', bonus: 5 }],
        description: 'A silver-inlaid blade balanced for quick strikes.',
      },
    ]
    gc.hp = 5

    const existing: PersistentCharacter = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 2,
      xp: 220,
      maxHp: gc.maxHp,
      maxMp: gc.maxMp,
      skills: { ...gc.skills },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: ['Won a duel'],
      achievements: ['Bronze Hero'],
      inventory: [],
      createdAt: 1000,
      updatedAt: 1000,
      gamesPlayed: 3,
      deaths: 1,
      dead: false,
    }

    const result = gameCharacterToPersistent(gc, existing, 'Kept moving')

    expect(result.dead).toBe(false)
    expect(result.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Silvered Shortsword',
          rarity: 'uncommon',
        }),
      ])
    )
  })
})

describe('awardXp', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makePersistentCharacter(partial?: Partial<PersistentCharacter>): PersistentCharacter {
    const now = Date.now()
    return {
      name: 'Thorin',
      klass: 'Warrior',
      level: 1,
      xp: 0,
      maxHp: 20,
      maxMp: 8,
      skills: { attack: 50, dodge: 40, cast_spell: 10, use_skill: 30 },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: [],
      achievements: [],
      inventory: [],
      createdAt: now,
      updatedAt: now,
      gamesPlayed: 0,
      deaths: 0,
      dead: false,
      ...partial,
    }
  }

  it('XP_TABLE matches the expected level thresholds (levels 1-10)', () => {
    expect(XP_TABLE).toEqual([0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500])
  })

  it('exports milestone XP constants for non-combat encounters', () => {
    expect(XP_PER_TRAP_DISARM).toBe(25)
    expect(XP_PER_BARRIER_CLEAR).toBe(25)
    expect(XP_PER_PUZZLE).toBe(30)
    expect(XP_PER_TREASURE_FIND).toBe(10)
  })

  it('levels up a character when crossing the next XP threshold', () => {
    const pc = makePersistentCharacter({ level: 1, xp: 0 })
    const result = awardXp(pc, 100)
    expect(result).toEqual({ leveledUp: true, newLevel: 2 })
    expect(pc.xp).toBe(100)
    expect(pc.level).toBe(2)
  })

  it('increases HP/MP and adds +5 to a random skill on level up', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // first skill in sorted key order

    const pc = makePersistentCharacter({
      level: 1,
      xp: 0,
      maxHp: 10,
      maxMp: 5,
      skills: { attack: 10, dodge: 10, cast_spell: 10, use_skill: 10 },
    })

    awardXp(pc, 100) // -> level 2

    // On reaching level 2: + (5 + level) HP, + (3 + level) MP
    expect(pc.maxHp).toBe(10 + (5 + 2))
    expect(pc.maxMp).toBe(5 + (3 + 2))
    expect(pc.skills.attack).toBe(15)
  })

  it('supports multiple level-ups from a large XP award', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.0) // attack
      .mockReturnValueOnce(0.3) // cast_spell (sorted keys)
      .mockReturnValueOnce(0.6) // dodge
      .mockReturnValueOnce(0.9) // use_skill

    const pc = makePersistentCharacter({
      level: 1,
      xp: 0,
      maxHp: 10,
      maxMp: 5,
      skills: { attack: 10, dodge: 10, cast_spell: 10, use_skill: 10 },
    })

    const result = awardXp(pc, 1000) // level 1 -> 5

    expect(result).toEqual({ leveledUp: true, newLevel: 5 })
    expect(pc.level).toBe(5)
    expect(pc.xp).toBe(1000)

    // HP increases: +7 (L2) +8 (L3) +9 (L4) +10 (L5) = +34
    // MP increases: +5 (L2) +6 (L3) +7 (L4) +8 (L5) = +26
    expect(pc.maxHp).toBe(10 + 34)
    expect(pc.maxMp).toBe(5 + 26)

    expect(pc.skills.attack).toBe(15)
    expect(pc.skills.cast_spell).toBe(15)
    expect(pc.skills.dodge).toBe(15)
    expect(pc.skills.use_skill).toBe(15)
  })
})

describe('campaign-aware dungeon setup', () => {
  it('builds default hub town state for downtime between adventures', () => {
    expect(createHubTownState()).toEqual({
      location: 'tavern',
      idleTurns: 0,
      autoEmbarkAfter: 5,
    })
  })

  it('advances hub town idle turns and signals when auto-embark threshold is reached', () => {
    const first = createHubTownState({ idleTurns: 0, autoEmbarkAfter: 3 })
    expect(advanceHubTownIdleTurns(first)).toEqual({ state: { location: 'tavern', idleTurns: 1, autoEmbarkAfter: 3 }, shouldEmbark: false })

    const second = createHubTownState({ idleTurns: 2, autoEmbarkAfter: 3, location: 'market' })
    expect(advanceHubTownIdleTurns(second)).toEqual({ state: { location: 'market', idleTurns: 3, autoEmbarkAfter: 3 }, shouldEmbark: true })
  })

  it('threads campaign arcs and world context into a newly created adventure', () => {
    const campaign: CampaignState = {
      id: 'campaign_ironlands',
      name: 'Ironlands War',
      premise: 'The Shadow Court rises in the Ironlands',
      worldState: {
        factions: [
          { id: 'f1', name: 'Shadow Court', disposition: -90, description: 'Ancient nobles bent on conquest.' },
        ],
        locations: [
          { id: 'l1', name: 'Ironlands Keep', status: 'contested', description: 'Frontier stronghold under siege.' },
        ],
        npcs: [
          { id: 'n1', name: 'Marshal Vey', role: 'ally', factionId: 'f1', description: 'A scarred veteran commander.' },
        ],
        events: [],
      },
      storyArcs: [
        {
          id: 'arc_shadow',
          name: 'War for the Ironlands',
          status: 'active',
          plotPoints: [{ id: 'pp1', description: 'Secure a foothold at Ironlands Keep', resolved: false }],
        },
      ],
      adventureCount: 2,
    }

    const game = createGame({ id: 'rpg_campaign_1', players: ['alice', 'bob'], campaignState: campaign })

    expect(game.campaignId).toBe(campaign.id)
    expect(game.campaignAdventureNumber).toBe(3)
    expect(game.campaignContext?.activeArcs[0]).toContain('War for the Ironlands')
    expect(`${game.theme.name} ${game.theme.backstory}`).toContain('War for the Ironlands')
  })
})

describe('faction disposition helpers', () => {
  it('maps disposition values to tiers at threshold boundaries', () => {
    expect(getDispositionTier(-80)).toBe('hostile')
    expect(getDispositionTier(-51)).toBe('hostile')
    expect(getDispositionTier(-50)).toBe('unfriendly')
    expect(getDispositionTier(-10)).toBe('unfriendly')
    expect(getDispositionTier(-9)).toBe('neutral')
    expect(getDispositionTier(0)).toBe('neutral')
    expect(getDispositionTier(9)).toBe('neutral')
    expect(getDispositionTier(10)).toBe('friendly')
    expect(getDispositionTier(49)).toBe('friendly')
    expect(getDispositionTier(50)).toBe('allied')
    expect(getDispositionTier(80)).toBe('allied')
  })

  it('adjusts faction disposition and appends a campaign event', () => {
    const campaign: CampaignState = {
      id: 'campaign_reputation_1',
      name: 'Ironlands Reputation',
      premise: 'A brewing civil war',
      worldState: {
        factions: [{ id: 'iron', name: 'Iron Brotherhood', disposition: 40, description: 'Militant defenders.' }],
        locations: [],
        events: [],
      },
      storyArcs: [],
      adventureCount: 0,
    }

    const updated = adjustDisposition(campaign, 'iron', 25, 'Negotiated safe passage after a tense standoff.')

    expect(updated.worldState.factions[0]?.disposition).toBe(65)
    expect(updated.worldState.events).toHaveLength(1)
    expect(updated.worldState.events[0]).toContain('Iron Brotherhood')
    expect(updated.worldState.events[0]).toContain('+25')
    expect(updated.worldState.events[0]).toContain('Negotiated safe passage')
    expect(campaign.worldState.factions[0]?.disposition).toBe(40)
    expect(campaign.worldState.events).toEqual([])
  })

  it('returns the original campaign when faction id is unknown', () => {
    const campaign: CampaignState = {
      id: 'campaign_reputation_2',
      name: 'Ironlands Reputation',
      premise: 'A brewing civil war',
      worldState: {
        factions: [{ id: 'iron', name: 'Iron Brotherhood', disposition: 0, description: 'Militant defenders.' }],
        locations: [],
        events: [],
      },
      storyArcs: [],
      adventureCount: 0,
    }

    const updated = adjustDisposition(campaign, 'missing', -20, 'Killed patrol')
    expect(updated).toBe(campaign)
  })
})
