export type RpgClass = 'Warrior' | 'Scout' | 'Mage' | 'Healer'

export type Dice = {
  d100: () => number
  d: (sides: number) => number
}

export function createTestDice(dice: Dice): Dice {
  return dice
}

export function createDice(rng: () => number = Math.random): Dice {
  return {
    d100: () => Math.floor(rng() * 100) + 1,
    d: (sides: number) => Math.floor(rng() * sides) + 1,
  }
}

export function rollD100(dice: Dice): number {
  const roll = dice.d100()
  if (!Number.isFinite(roll)) return 100
  return Math.max(1, Math.min(100, Math.floor(roll)))
}

export type Stats = {
  STR: number
  DEX: number
  INT: number
  WIS: number
}

export type Skills = {
  attack: number
  dodge: number
  cast_spell: number
  use_skill: number
}

export type Character = {
  name: string
  klass: RpgClass
  stats: Stats
  skills: Skills
  hp: number
  maxHp: number
  mp: number
  maxMp: number
}

export type Enemy = {
  name: string
  hp: number
  DEX: number
  attack: number
  dodge: number
}

export type Room =
  | { type: 'combat'; description: string; enemies: Enemy[] }
  | { type: 'trap'; description: string }
  | { type: 'treasure'; description: string }
  | { type: 'rest'; description: string }
  | { type: 'puzzle'; description: string }

export type RpgMode = 'exploring' | 'combat' | 'finished'

export type RpgGameState = {
  id: string
  type: 'rpg'
  phase: 'playing' | 'finished'
  mode: RpgMode
  roomIndex: number
  dungeon: Room[]
  party: Character[]
  turnOrder: Character[]
  currentPlayer: string
  combat?: { enemies: Enemy[] }
  log: Array<{ at: number; who: string; what: string }>
}

function clampSkill(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(100, Math.floor(value)))
}

function classStats(klass: RpgClass): Stats {
  switch (klass) {
    case 'Warrior':
      return { STR: 75, DEX: 50, INT: 40, WIS: 40 }
    case 'Scout':
      return { STR: 45, DEX: 75, INT: 45, WIS: 40 }
    case 'Mage':
      return { STR: 35, DEX: 45, INT: 80, WIS: 55 }
    case 'Healer':
      return { STR: 40, DEX: 45, INT: 55, WIS: 80 }
  }
}

function deriveSkills(stats: Stats): Skills {
  return {
    attack: clampSkill(30 + Math.floor(stats.STR * 0.45)),
    dodge: clampSkill(25 + Math.floor(stats.DEX * 0.45)),
    cast_spell: clampSkill(25 + Math.floor(stats.INT * 0.45)),
    use_skill: clampSkill(25 + Math.floor((stats.INT + stats.WIS) * 0.25)),
  }
}

function deriveMaxHp(stats: Stats): number {
  return Math.max(1, 10 + Math.floor((stats.STR + stats.WIS) / 20))
}

function deriveMaxMp(stats: Stats): number {
  return Math.max(0, Math.floor(stats.INT / 10) + Math.floor(stats.WIS / 10))
}

export function createCharacter(input: { name: string; klass: RpgClass }): Character {
  const stats = classStats(input.klass)
  const skills = deriveSkills(stats)
  const maxHp = deriveMaxHp(stats)
  const maxMp = deriveMaxMp(stats)

  return {
    name: input.name,
    klass: input.klass,
    stats,
    skills,
    hp: maxHp,
    maxHp,
    mp: maxMp,
    maxMp,
  }
}

export function resolveSkillCheck(input: { skill: number; dice: Dice }): {
  roll: number
  success: boolean
  nextSkill: number
} {
  const skill = clampSkill(input.skill)
  const roll = rollD100(input.dice)
  const success = roll <= skill
  const nextSkill = success ? Math.min(100, skill + 1) : skill
  return { roll, success, nextSkill }
}

function computeTurnOrder(party: Character[]): Character[] {
  return [...party].sort((a, b) => {
    const dex = b.stats.DEX - a.stats.DEX
    if (dex !== 0) return dex
    return a.name.localeCompare(b.name)
  })
}

function defaultDungeon(): Room[] {
  return [
    { type: 'rest', description: 'A quiet alcove.' },
    { type: 'trap', description: 'A pressure plate clicks underfoot.' },
    {
      type: 'combat',
      description: 'A snarling goblin blocks the way.',
      enemies: [{ name: 'Goblin', hp: 6, DEX: 40, attack: 30, dodge: 20 }],
    },
    { type: 'puzzle', description: 'A rune-locked door hums with strange energy.' },
    { type: 'treasure', description: 'A small chest with a few coins.' },
  ]
}

function toCharacter(value: string | Character, index: number): Character {
  if (typeof value !== 'string') return value
  const classes: RpgClass[] = ['Warrior', 'Scout', 'Mage', 'Healer']
  return createCharacter({ name: value, klass: classes[index % classes.length]! })
}

export function createGame(input: {
  id: string
  players: Array<string | Character>
  dungeon?: Room[]
}): RpgGameState {
  const party = input.players.map(toCharacter)
  const turnOrder = computeTurnOrder(party)
  const dungeon = input.dungeon ?? defaultDungeon()

  const initialMode: RpgMode = dungeon[0]?.type === 'combat' ? 'combat' : 'exploring'
  const combat =
    initialMode === 'combat' && dungeon[0]?.type === 'combat'
      ? { enemies: dungeon[0].enemies.map((e) => ({ ...e })) }
      : undefined

  return {
    id: input.id,
    type: 'rpg',
    phase: 'playing',
    mode: initialMode,
    roomIndex: 0,
    dungeon,
    party,
    turnOrder,
    currentPlayer: turnOrder[0]?.name ?? party[0]?.name ?? 'unknown',
    combat,
    log: [],
  }
}

function findCharacter(game: RpgGameState, name: string): Character | undefined {
  return game.party.find((p) => p.name === name)
}

function applyDamage(target: { hp: number }, amount: number): void {
  target.hp = Math.max(0, target.hp - Math.max(0, Math.floor(amount)))
}

export function attack(
  game: RpgGameState,
  input: { attacker: string; defender: string; dice: Dice }
): { ok: true; hit: boolean; detail: string } {
  const attacker = findCharacter(game, input.attacker)
  const defender = findCharacter(game, input.defender)
  if (!attacker || !defender) {
    return { ok: true, hit: false, detail: 'invalid combatants' }
  }

  const atk = resolveSkillCheck({ skill: attacker.skills.attack, dice: input.dice })
  const dod = resolveSkillCheck({ skill: defender.skills.dodge, dice: input.dice })

  // BRP-inspired opposed roll: success beats failure; if both succeed, margin decides.
  const atkMargin = atk.success ? attacker.skills.attack - atk.roll : -Infinity
  const dodMargin = dod.success ? defender.skills.dodge - dod.roll : -Infinity

  const hit = atk.success && (!dod.success || atkMargin > dodMargin)
  if (hit) {
    const damage = input.dice.d(6) + Math.floor(attacker.stats.STR / 25)
    applyDamage(defender, damage)
    attacker.skills.attack = atk.nextSkill
    game.log.push({ at: Date.now(), who: attacker.name, what: `hit ${defender.name} for ${damage}` })
    return { ok: true, hit: true, detail: 'hit' }
  }

  if (dod.success) {
    defender.skills.dodge = dod.nextSkill
  }

  game.log.push({ at: Date.now(), who: attacker.name, what: `missed ${defender.name}` })
  return { ok: true, hit: false, detail: 'miss' }
}

export function explore(game: RpgGameState, input: { dice: Dice }): { ok: true; room: Room | null } {
  if (game.phase !== 'playing') {
    return { ok: true, room: null }
  }

  if (game.roomIndex >= game.dungeon.length - 1) {
    game.phase = 'finished'
    game.mode = 'finished'
    game.combat = undefined
    return { ok: true, room: null }
  }

  game.roomIndex += 1
  const room = game.dungeon[game.roomIndex] ?? null

  if (!room) return { ok: true, room: null }

  if (room.type === 'combat') {
    game.mode = 'combat'
    game.combat = { enemies: room.enemies.map((e) => ({ ...e })) }
  } else {
    game.mode = 'exploring'
    game.combat = undefined

    // Keep a tiny bit of BRP flavor: some rooms can still grant small improvements.
    if (room.type === 'rest') {
      for (const member of game.party) {
        member.hp = Math.min(member.maxHp, member.hp + 2)
        member.mp = Math.min(member.maxMp, member.mp + 1)
      }
    }

    if (room.type === 'treasure') {
      const actor = findCharacter(game, game.currentPlayer)
      if (actor) {
        actor.mp = Math.min(actor.maxMp, actor.mp + 1)
      }
    }

    if (room.type === 'trap') {
      const actor = findCharacter(game, game.currentPlayer)
      if (actor) {
        const check = resolveSkillCheck({ skill: actor.skills.use_skill, dice: input.dice })
        if (check.success) {
          actor.skills.use_skill = check.nextSkill
        } else {
          applyDamage(actor, 2)
        }
      }
    }

    if (room.type === 'puzzle') {
      const actor = findCharacter(game, game.currentPlayer)
      if (actor) {
        const check = resolveSkillCheck({ skill: actor.skills.use_skill, dice: input.dice })
        if (check.success) actor.skills.use_skill = check.nextSkill
      }
    }
  }

  game.log.push({ at: Date.now(), who: game.currentPlayer, what: `explore: ${room.type}` })
  return { ok: true, room }
}
