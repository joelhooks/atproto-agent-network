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
  | { type: 'boss'; description: string; enemies: Enemy[] }
  | { type: 'barrier'; description: string; requiredClass: RpgClass }

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
  // Tracks repeated failed attempts on a given barrier room index.
  // Optional for backwards compatibility with persisted games.
  barrierAttempts?: Record<string, number>
  log: Array<{ at: number; who: string; what: string }>
}

export function soloMultiplier(partySize: number): number {
  const size = Number.isFinite(partySize) ? Math.floor(partySize) : 0
  if (size <= 1) return 2.0
  if (size === 2) return 1.5
  return 1.0
}

export function partyWipe(game: RpgGameState): boolean {
  if (!Array.isArray(game.party) || game.party.length === 0) return false
  const wiped = game.party.every((p) => (p?.hp ?? 0) <= 0)
  if (!wiped) return false

  game.phase = 'finished'
  game.mode = 'finished'
  game.combat = undefined
  return true
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

function isRpgClass(value: unknown): value is RpgClass {
  return value === 'Warrior' || value === 'Scout' || value === 'Mage' || value === 'Healer'
}

function uniquePartyClasses(party: Character[]): RpgClass[] {
  const seen = new Set<RpgClass>()
  for (const member of party) {
    if (!member) continue
    if (!isRpgClass((member as any).klass)) continue
    seen.add(member.klass)
  }
  return [...seen]
}

function defaultDungeon(party: Character[]): Room[] {
  return generateDungeon(12, createDice(), { partyClasses: uniquePartyClasses(party) })
}

function safeInt(value: unknown, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.floor(value as number)
}

function rollDie(dice: Dice, sides: number): number {
  const roll = safeInt(dice.d(sides), 1)
  return Math.max(1, Math.min(sides, roll))
}

function shuffle<T>(items: T[], dice: Dice): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rollDie(dice, i + 1) - 1
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

function buildCombatRoom(input: { tier: 'early' | 'mid'; dice: Dice }): Room {
  const { tier, dice } = input
  const hp = tier === 'early' ? 5 + rollDie(dice, 3) : 9 + rollDie(dice, 5)

  const enemy: Enemy =
    tier === 'early'
      ? { name: 'Goblin', hp, DEX: 40, attack: 30, dodge: 20 }
      : { name: 'Orc', hp, DEX: 45, attack: 40, dodge: 25 }

  return { type: 'combat', description: `A ${enemy.name.toLowerCase()} prowls here.`, enemies: [enemy] }
}

function buildBossRoom(dice: Dice): Room {
  const hp = 29 + rollDie(dice, 20) // 30+
  const enemy: Enemy = { name: 'Dungeon Boss', hp, DEX: 55, attack: 55, dodge: 35 }
  return { type: 'boss', description: 'A hulking presence fills the chamber.', enemies: [enemy] }
}

export function generateDungeon(
  depth: number = 12,
  dice: Dice,
  options?: { partyClasses?: RpgClass[] }
): Room[] {
  const rooms = safeInt(depth, 12)
  if (rooms < 6) throw new Error('generateDungeon requires depth >= 6')

  const lastIndex = rooms - 1
  const partyClasses = Array.isArray(options?.partyClasses)
    ? options!.partyClasses.filter(isRpgClass)
    : ([] as RpgClass[])

  const allClasses: RpgClass[] = ['Warrior', 'Scout', 'Mage', 'Healer']
  const uniqueClasses = [...new Set(partyClasses)]
  const classes: RpgClass[] = shuffle(uniqueClasses.length > 0 ? uniqueClasses : allClasses, dice)

  const barrierIndices = new Set<number>()
  for (let i = 1; i <= 4; i += 1) {
    // Evenly spread across the run, but never in the first room or the final boss room.
    let idx = Math.floor((i * lastIndex) / 5)
    idx = Math.max(1, Math.min(lastIndex - 1, idx))
    while (barrierIndices.has(idx)) {
      idx = idx + 1
      if (idx >= lastIndex) idx = 1
    }
    barrierIndices.add(idx)
  }

  const orderedBarrierIndices = [...barrierIndices].sort((a, b) => a - b)
  const requiredClassByIndex = new Map<number, RpgClass>()
  for (let i = 0; i < orderedBarrierIndices.length; i += 1) {
    requiredClassByIndex.set(orderedBarrierIndices[i]!, classes[i % classes.length]!)
  }

  const fillerCycle = ['rest', 'combat', 'trap', 'treasure', 'puzzle'] as const
  const midpoint = Math.floor(rooms / 2)
  let fillCursor = rollDie(dice, fillerCycle.length) - 1

  const dungeon: Room[] = []
  for (let index = 0; index < lastIndex; index += 1) {
    const requiredClass = requiredClassByIndex.get(index)
    if (requiredClass) {
      dungeon.push({
        type: 'barrier',
        requiredClass,
        description: `A sealed archway bars the way. Only a ${requiredClass} can open it.`,
      })
      continue
    }

    const type = fillerCycle[fillCursor % fillerCycle.length]!
    fillCursor += 1

    if (type === 'combat') {
      const tier: 'early' | 'mid' = index < midpoint ? 'early' : 'mid'
      dungeon.push(buildCombatRoom({ tier, dice }))
      continue
    }

    if (type === 'rest') {
      dungeon.push({ type: 'rest', description: 'A quiet alcove.' })
      continue
    }

    if (type === 'trap') {
      dungeon.push({ type: 'trap', description: 'A pressure plate clicks underfoot.' })
      continue
    }

    if (type === 'treasure') {
      dungeon.push({ type: 'treasure', description: 'A small chest with a few coins.' })
      continue
    }

    dungeon.push({ type: 'puzzle', description: 'A rune-locked door hums with strange energy.' })
  }

  dungeon.push(buildBossRoom(dice))
  return dungeon
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
  const dungeon = input.dungeon ?? defaultDungeon(party)

  const initialRoom = dungeon[0]
  const initialMode: RpgMode =
    initialRoom?.type === 'combat' || initialRoom?.type === 'boss' ? 'combat' : 'exploring'
  const combat =
    initialMode === 'combat' && (initialRoom?.type === 'combat' || initialRoom?.type === 'boss')
      ? { enemies: initialRoom.enemies.map((e) => ({ ...e })) }
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
    barrierAttempts: {},
    log: [],
  }
}

export function findCharacter(game: RpgGameState, name: string): Character | undefined {
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
    partyWipe(game)
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

  if (room.type === 'combat' || room.type === 'boss') {
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
          applyDamage(actor, 2 * soloMultiplier(game.party.length))
          partyWipe(game)
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

    if (room.type === 'barrier') {
      const requiredClass = (room as { requiredClass?: string }).requiredClass ?? ''
      const barrierIndex = game.roomIndex
      const barrierKey = String(barrierIndex)
      const actor = findCharacter(game, game.currentPlayer) ?? game.party[0]
      const hasRequiredClass = game.party.some((p) => p.klass === requiredClass)

      if (!hasRequiredClass) {
        game.barrierAttempts ??= {}

        // 1) Brute force: any Warrior can smash through (20% max HP)
        const warrior =
          (actor && actor.klass === 'Warrior' ? actor : undefined) ?? game.party.find((p) => p.klass === 'Warrior')
        if (warrior) {
          const cost = Math.max(1, Math.ceil(warrior.maxHp * 0.2))
          applyDamage(warrior, cost)
          delete game.barrierAttempts[barrierKey]
          game.log.push({
            at: Date.now(),
            who: warrior.name,
            what: `barrier: brute_force (-${cost} HP)`,
          })
          game.log.push({ at: Date.now(), who: game.currentPlayer, what: `barrier: bypassed (need ${requiredClass})` })
        } else {
          // 2) Skill check: INT/WIS at Hard difficulty (30%)
          const check = resolveSkillCheck({ skill: 30, dice: input.dice })
          if (check.success) {
            delete game.barrierAttempts[barrierKey]
            game.log.push({
              at: Date.now(),
              who: actor?.name ?? game.currentPlayer,
              what: `barrier: skill_check success (roll ${check.roll} <= 30)`,
            })
            game.log.push({ at: Date.now(), who: game.currentPlayer, what: `barrier: bypassed (need ${requiredClass})` })
          } else if (actor) {
            // 3) MP sacrifice: spend 50% max MP to force it open
            const mpCost = Math.max(0, Math.ceil(actor.maxMp * 0.5))
            if (actor.mp >= mpCost && mpCost > 0) {
              actor.mp = Math.max(0, actor.mp - mpCost)
              delete game.barrierAttempts[barrierKey]
              game.log.push({
                at: Date.now(),
                who: actor.name,
                what: `barrier: mp_sacrifice (-${mpCost} MP)`,
              })
              game.log.push({
                at: Date.now(),
                who: game.currentPlayer,
                what: `barrier: bypassed (need ${requiredClass})`,
              })
            } else {
              // Failed attempt: count and potentially auto-crumble.
              const next = (game.barrierAttempts[barrierKey] ?? 0) + 1
              game.barrierAttempts[barrierKey] = next

              // 4) Auto-crumble after 5 failed attempts.
              if (next >= 5) {
                game.log.push({
                  at: Date.now(),
                  who: game.currentPlayer,
                  what: 'barrier: auto_crumble (The ancient seal weakens and shatters)',
                })
              } else {
                // Block: can't pass yet, stay on previous room
                game.roomIndex -= 1
                game.log.push({
                  at: Date.now(),
                  who: game.currentPlayer,
                  what: `barrier: blocked (need ${requiredClass}) attempt ${next}/5`,
                })
                return { ok: true, room }
              }
            }
          } else {
            // No actor; treat as a failed attempt so the barrier can still crumble.
            const next = (game.barrierAttempts[barrierKey] ?? 0) + 1
            game.barrierAttempts[barrierKey] = next
            if (next >= 5) {
              game.log.push({
                at: Date.now(),
                who: game.currentPlayer,
                what: 'barrier: auto_crumble (The ancient seal weakens and shatters)',
              })
            } else {
              game.roomIndex -= 1
              game.log.push({
                at: Date.now(),
                who: game.currentPlayer,
                what: `barrier: blocked (need ${requiredClass}) attempt ${next}/5`,
              })
              return { ok: true, room }
            }
          }
        }
      } else {
        // Party has the class — barrier resolved, continue
        delete game.barrierAttempts?.[barrierKey]
        game.log.push({ at: Date.now(), who: game.currentPlayer, what: `barrier: resolved by ${requiredClass}` })
      }
    }
  }

  game.log.push({ at: Date.now(), who: game.currentPlayer, what: `explore: ${room.type}` })
  return { ok: true, room }
}

// --- Role Synergy: Cooperative abilities (require partySize > 1) ---

type SynergyError = { ok: false; reason: string }

function validateSynergy(
  game: RpgGameState,
  characterName: string,
  requiredClass: RpgClass,
): { ok: true; character: Character } | SynergyError {
  if (game.party.length <= 1) return { ok: false, reason: 'need_party' }
  const character = findCharacter(game, characterName)
  if (!character) return { ok: false, reason: 'character_not_found' }
  if (character.klass !== requiredClass) return { ok: false, reason: `requires_${requiredClass.toLowerCase()}` }
  return { ok: true, character }
}

export function healOther(
  game: RpgGameState,
  healerName: string,
  targetName: string,
  dice: Dice,
): { ok: true; healed: string; amount: number } | SynergyError {
  const check = validateSynergy(game, healerName, 'Healer')
  if (!check.ok) return check

  const healer = check.character
  if (healer.mp < 5) return { ok: false, reason: 'not_enough_mp' }

  const target = findCharacter(game, targetName)
  if (!target) return { ok: false, reason: 'target_not_found' }
  if (target.name === healer.name) return { ok: false, reason: 'cannot_heal_self' }

  healer.mp -= 5
  const amount = 10 + dice.d(6)
  target.hp = Math.min(target.maxHp, target.hp + amount)

  game.log.push({ at: Date.now(), who: healerName, what: `healed ${targetName} for ${amount}` })
  return { ok: true, healed: targetName, amount }
}

export function taunt(
  game: RpgGameState,
  warriorName: string,
  dice: Dice,
): { ok: true; taunting: boolean } | SynergyError {
  const check = validateSynergy(game, warriorName, 'Warrior')
  if (!check.ok) return check

  const warrior = check.character as Character & { taunting?: boolean }
  warrior.taunting = true

  game.log.push({ at: Date.now(), who: warriorName, what: 'taunting enemies' })
  return { ok: true, taunting: true }
}

export function aoeSpell(
  game: RpgGameState,
  mageName: string,
  dice: Dice,
): { ok: true; totalDamage: number } | SynergyError {
  const check = validateSynergy(game, mageName, 'Mage')
  if (!check.ok) return check

  const mage = check.character
  if (mage.mp < 8) return { ok: false, reason: 'not_enough_mp' }

  mage.mp -= 8
  const enemies = game.combat?.enemies ?? []
  let totalDamage = 0

  for (const enemy of enemies) {
    const damage = 8 + dice.d(8)
    applyDamage(enemy, damage)
    totalDamage += damage
  }

  game.log.push({ at: Date.now(), who: mageName, what: `aoe spell for ${totalDamage} total damage` })
  return { ok: true, totalDamage }
}

export function disarmTrap(
  game: RpgGameState,
  rogueName: string,
  dice: Dice,
): { ok: true; disarmed: boolean } | SynergyError {
  const check = validateSynergy(game, rogueName, 'Scout')
  if (!check.ok) return check

  const rogue = check.character
  const boostedSkill = Math.min(100, rogue.skills.use_skill + 30)
  const result = resolveSkillCheck({ skill: boostedSkill, dice })
  if (result.success) {
    rogue.skills.use_skill = Math.min(100, rogue.skills.use_skill + 1)
  }

  game.log.push({ at: Date.now(), who: rogueName, what: `disarmed trap (skill ${boostedSkill})` })
  return { ok: true, disarmed: result.success }
}
