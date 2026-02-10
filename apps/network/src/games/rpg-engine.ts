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

export type RoomMeta = {
  // GM-injected annotations that should not break existing rooms.
  hazards?: string[]
  gmEvents?: Array<{ at: number; kind: string; text: string }>

  // Barrier tuning knobs (defaults preserve legacy behavior).
  autoCrumbleAttempts?: number
  skillCheckTarget?: number
}

export type Room = (
  | { type: 'combat'; description: string; enemies: Enemy[] }
  | { type: 'trap'; description: string }
  | { type: 'treasure'; description: string }
  | { type: 'rest'; description: string }
  | { type: 'puzzle'; description: string }
  | { type: 'boss'; description: string; enemies: Enemy[] }
  | { type: 'barrier'; description: string; requiredClass: RpgClass }
) &
  RoomMeta

export type RpgMode = 'exploring' | 'combat' | 'finished'

export type RpgActionHistoryEntry = {
  action: string
  target: string
  roomIndex: number
}

export type NarrativeBeatKind = 'kill' | 'near_death' | 'barrier' | 'treasure' | 'gm'

export type NarrativeBeat = {
  at: number
  roomIndex: number
  kind: NarrativeBeatKind
  text: string
}

export type DungeonTheme = {
  name: string
  backstory: string
}

export type RpgGameState = {
  id: string
  type: 'rpg'
  phase: 'playing' | 'finished'
  mode: RpgMode
  roomIndex: number
  theme: DungeonTheme
  dungeon: Room[]
  party: Character[]
  turnOrder: Character[]
  currentPlayer: string
  combat?: { enemies: Enemy[] }
  // GM lookups from pdf-brain keyed by query string (optional for backwards compat).
  libraryContext?: Record<string, string>
  // Tracks recent actions per player to detect stuck agent loops.
  // Optional for backwards compatibility with persisted games.
  actionHistory?: Record<string, RpgActionHistoryEntry[]>
  // Tracks repeated failed attempts on a given barrier room index.
  // Optional for backwards compatibility with persisted games.
  barrierAttempts?: Record<string, number>
  // Key story beats extracted from play (no need to parse the entire log at render time).
  // Optional for backwards compatibility with persisted games.
  narrativeContext?: NarrativeBeat[]
  log: Array<{ at: number; who: string; what: string }>
}

export type GeneratedDungeon = {
  theme: DungeonTheme
  rooms: Room[]
}

function clampNarrativeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 240)
}

export function recordNarrativeBeat(
  game: RpgGameState,
  input: { kind: NarrativeBeatKind; text: string; roomIndex?: number; at?: number }
): void {
  const kind = input.kind
  const text = clampNarrativeText(input.text)
  if (!text) return

  const at = Number.isFinite(input.at) ? Math.floor(input.at as number) : Date.now()
  const roomIndex = Number.isFinite(input.roomIndex) ? Math.floor(input.roomIndex as number) : game.roomIndex

  game.narrativeContext ??= []
  const list = game.narrativeContext

  // Deduplicate consecutive identical beats to avoid noisy context on retries.
  const last = list[list.length - 1]
  if (last && last.kind === kind && last.text === text && last.roomIndex === roomIndex) return

  list.push({ at, roomIndex, kind, text })
  if (list.length > 50) {
    list.splice(0, list.length - 50)
  }
}

const TREASURE_ITEMS = ['soot-black opal', 'cracked sunstone', 'silvered map scrap', 'bone-carved die'] as const

function pickTreasureItem(game: RpgGameState, roomIndex: number): string {
  // Deterministic so tests and narrative callbacks are stable.
  void game
  const idx = Math.abs((roomIndex + TREASURE_ITEMS.length - 1) % TREASURE_ITEMS.length)
  return TREASURE_ITEMS[idx]!
}

function formatBeatForRoom(beat: NarrativeBeat): string {
  switch (beat.kind) {
    case 'treasure':
      return `The ${beat.text} in your pack feels heavier than it should.`
    case 'barrier':
      if (beat.text === 'brute_force') return 'Your bruised shoulder still aches from forcing the archway open.'
      if (beat.text === 'auto_crumble') return 'You can still hear stone cracking as the barrier finally gave way.'
      if (beat.text === 'skill_check') return 'You remember the barrier yielding to careful, measured effort.'
      if (beat.text === 'mp_sacrifice') return 'Your veins still feel cold from the magic you bled into that seal.'
      return 'You remember the barrier giving way, one way or another.'
    case 'near_death':
      return `${beat.text} still breathes shallowly after that close call.`
    case 'kill':
      return `The memory of the ${beat.text} you felled follows you onward.`
    case 'gm':
      return 'The dungeon itself seems to remember your hesitation.'
  }
}

function formatBeatForBoss(beat: NarrativeBeat): string {
  switch (beat.kind) {
    case 'treasure':
      return `The ${beat.text} you claimed whispers in your pack.`
    case 'barrier':
      if (beat.text === 'brute_force') return 'Your bruised shoulder recalls the archway you broke through.'
      if (beat.text === 'auto_crumble') return 'You recall the barrier crumbling at last, like a promise kept.'
      if (beat.text === 'skill_check') return 'You recall the seal yielding to clever hands.'
      if (beat.text === 'mp_sacrifice') return 'You recall spending your own magic to force the way.'
      return 'You recall the barrier that tried to turn you back.'
    case 'near_death':
      return `${beat.text} remembers the edge of death, and chooses life anyway.`
    case 'kill':
      return `The foe you slew, the ${beat.text}, feels like a rehearsal for what waits here.`
    case 'gm':
      return 'Even the corridors feel like they have been watching you.'
  }
}

export function describeRoom(game: RpgGameState, roomIndex: number): string {
  const idx = Number.isFinite(roomIndex) ? Math.floor(roomIndex) : game.roomIndex
  const room = game.dungeon[idx]
  const base = room?.description ?? ''
  if (!room) return base

  const context = (game.narrativeContext ?? []).filter((b) => b && b.roomIndex < idx)
  if (context.length === 0) return base

  // Only start adding callbacks once the party has had time to *do* things.
  const shouldCallback = idx >= 2 || room.type === 'boss'
  if (!shouldCallback) return base

  if (room.type === 'boss') {
    const first = context[0]
    const last = context[context.length - 1]
    const picks: NarrativeBeat[] = []
    if (first) picks.push(first)
    if (last && (picks.length === 0 || last.kind !== picks[0]!.kind || last.text !== picks[0]!.text)) picks.push(last)
    while (picks.length < 2 && context.length >= 2) {
      const candidate = context[Math.max(0, context.length - 2)]
      if (
        candidate &&
        !picks.some((p) => p.kind === candidate.kind && p.text === candidate.text && p.roomIndex === candidate.roomIndex)
      ) {
        picks.push(candidate)
      } else {
        break
      }
    }

    const lines = picks.slice(0, 3).map((b) => `- ${formatBeatForBoss(b)}`)
    return `${base}\n\nYour journey catches up with you:\n${lines.join('\n')}`
  }

  const recent = context.slice(-2)
  const echo = recent.map(formatBeatForRoom).join(' ')
  return `${base}\n\nEchoes: ${echo}`
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
  return generateDungeon(12, createDice(), { partyClasses: uniquePartyClasses(party) }).rooms
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

const DUNGEON_THEMES: DungeonTheme[] = [
  {
    name: 'Ashen Reliquary',
    backstory: 'A monastery burned to cinders, its relics still humming with old vows.',
  },
  {
    name: 'Gilded Catacombs',
    backstory: 'A dynastys tomb where greed outlived the kings that fed it.',
  },
  {
    name: 'Glass Labyrinth',
    backstory: 'A maze of mirrored corridors that remembers every footstep.',
  },
  {
    name: 'Ironroot Hollow',
    backstory: 'A cavern where metal veins grow like roots, and the earth tastes of rust.',
  },
  {
    name: 'Moonlit Sepulcher',
    backstory: 'A crypt washed in pale light, as if the moon itself were buried here.',
  },
  {
    name: 'Saltworn Archives',
    backstory: 'A library drowned long ago, its pages preserved in brine and myth.',
  },
  {
    name: 'Thorn Choir',
    backstory: 'A ruin that sings through briars; every wound is a note in its hymn.',
  },
  {
    name: 'Verdigris Vault',
    backstory: 'Bronze doors and copper bones, corroded into something almost alive.',
  },
  {
    name: 'Wicker Sanctum',
    backstory: 'A shrine woven from reeds and secrets, crackling with dry prayers.',
  },
  {
    name: 'Winterhall Depths',
    backstory: 'A buried keep sealed by ice, keeping its last breath for the unwary.',
  },
]

function pickDungeonTheme(dice: Dice): DungeonTheme {
  const idx = rollDie(dice, DUNGEON_THEMES.length) - 1
  return DUNGEON_THEMES[Math.max(0, Math.min(DUNGEON_THEMES.length - 1, idx))]!
}

function withThemeDescription(theme: DungeonTheme, description: string): string {
  const base = String(description || '').trim()
  // Keep it obvious for tests and for humans scanning logs.
  if (!base) return theme.name
  if (base.includes(theme.name)) return base
  return `${theme.name}: ${base}`
}

function buildCombatRoom(input: { tier: 'early' | 'mid'; dice: Dice; theme: DungeonTheme }): Room {
  const { tier, dice, theme } = input
  const hp = tier === 'early' ? 5 + rollDie(dice, 3) : 9 + rollDie(dice, 5)

  const enemy: Enemy =
    tier === 'early'
      ? { name: 'Goblin', hp, DEX: 40, attack: 30, dodge: 20 }
      : { name: 'Orc', hp, DEX: 45, attack: 40, dodge: 25 }

  return {
    type: 'combat',
    description: withThemeDescription(theme, `A ${enemy.name.toLowerCase()} stalks the shadows.`),
    enemies: [enemy],
  }
}

function buildBossRoom(dice: Dice, theme: DungeonTheme): Room {
  const hp = 29 + rollDie(dice, 20) // 30+
  const enemy: Enemy = { name: 'Dungeon Boss', hp, DEX: 55, attack: 55, dodge: 35 }
  return { type: 'boss', description: withThemeDescription(theme, 'A hulking presence fills the chamber.'), enemies: [enemy] }
}

export function generateDungeon(
  depth: number = 12,
  dice: Dice,
  options?: { partyClasses?: RpgClass[] }
): GeneratedDungeon {
  const rooms = safeInt(depth, 12)
  if (rooms < 6) throw new Error('generateDungeon requires depth >= 6')

  const lastIndex = rooms - 1
  const theme = pickDungeonTheme(dice)
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
        description: withThemeDescription(theme, `A sealed archway bars the way. Only a ${requiredClass} can open it.`),
      })
      continue
    }

    const type = fillerCycle[fillCursor % fillerCycle.length]!
    fillCursor += 1

    if (type === 'combat') {
      const tier: 'early' | 'mid' = index < midpoint ? 'early' : 'mid'
      dungeon.push(buildCombatRoom({ tier, dice, theme }))
      continue
    }

    if (type === 'rest') {
      dungeon.push({ type: 'rest', description: withThemeDescription(theme, 'A quiet alcove.' ) })
      continue
    }

    if (type === 'trap') {
      dungeon.push({ type: 'trap', description: withThemeDescription(theme, 'A pressure plate clicks underfoot.' ) })
      continue
    }

    if (type === 'treasure') {
      dungeon.push({ type: 'treasure', description: withThemeDescription(theme, 'A small chest with a few coins.' ) })
      continue
    }

    dungeon.push({ type: 'puzzle', description: withThemeDescription(theme, 'A rune-locked door hums with strange energy.' ) })
  }

  dungeon.push(buildBossRoom(dice, theme))
  return { theme, rooms: dungeon }
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
  const themeRng = createDice()
  const generated = input.dungeon ? null : generateDungeon(12, themeRng, { partyClasses: uniquePartyClasses(party) })
  const theme = generated?.theme ?? pickDungeonTheme(themeRng)
  const dungeon = (input.dungeon ? input.dungeon : generated!.rooms).map((room) => ({
    ...room,
    description: withThemeDescription(theme, room.description),
  }))

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
    theme,
    dungeon,
    party,
    turnOrder,
    currentPlayer: turnOrder[0]?.name ?? party[0]?.name ?? 'unknown',
    combat,
    actionHistory: {},
    barrierAttempts: {},
    narrativeContext: [],
    log: [],
  }
}

export function findCharacter(game: RpgGameState, name: string): Character | undefined {
  return game.party.find((p) => p.name === name)
}

const ACTION_HISTORY_LIMIT = 25
const STUCK_REPEAT_THRESHOLD = 5

function clampActionToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  // Keep keys/logs small and stable.
  return value.trim().slice(0, 120)
}

export function recordActionHistory(
  game: RpgGameState,
  input: { player: string; action: string; target: string; roomIndex?: number }
): { repeatCount: number; stuck: boolean } {
  const player = clampActionToken(input.player) || game.currentPlayer || 'unknown'
  const action = clampActionToken(input.action) || 'action'
  const target = clampActionToken(input.target)
  const roomIndex = Number.isFinite(input.roomIndex) ? Math.floor(input.roomIndex as number) : game.roomIndex

  game.actionHistory ??= {}
  const list = (game.actionHistory[player] ??= [])
  list.push({ action, target, roomIndex })
  if (list.length > ACTION_HISTORY_LIMIT) {
    list.splice(0, list.length - ACTION_HISTORY_LIMIT)
  }

  let repeatCount = 1
  for (let i = list.length - 2; i >= 0; i -= 1) {
    const prev = list[i]
    if (!prev) break
    if (prev.action !== action) break
    if (prev.target !== target) break
    repeatCount += 1
    if (repeatCount >= STUCK_REPEAT_THRESHOLD) break
  }

  return { repeatCount, stuck: repeatCount >= STUCK_REPEAT_THRESHOLD }
}

function setRoomModeFromIndex(game: RpgGameState, roomIndex: number): void {
  const room = game.dungeon[roomIndex]
  if (room && (room.type === 'combat' || room.type === 'boss')) {
    game.mode = 'combat'
    game.combat = { enemies: room.enemies.map((e) => ({ ...e })) }
  } else if (game.phase === 'playing') {
    game.mode = 'exploring'
    game.combat = undefined
  }
}

export function gmInterveneIfStuck(
  game: RpgGameState,
  input: { player: string; action: string; target: string }
): { intervened: boolean; repeatCount: number } {
  const player = clampActionToken(input.player) || game.currentPlayer || 'unknown'
  const action = clampActionToken(input.action) || 'action'
  const target = clampActionToken(input.target)

  const recorded = recordActionHistory(game, { player, action, target })
  if (!recorded.stuck) return { intervened: false, repeatCount: recorded.repeatCount }

  game.log.push({
    at: Date.now(),
    who: 'GM',
    what: `warning: stuck_detected (${player} repeated ${action} ${recorded.repeatCount}x; target=${target || 'none'})`,
  })

  // Auto-resolve the current obstacle.
  const actor = findCharacter(game, player) ?? findCharacter(game, game.currentPlayer) ?? game.party[0]
  if (game.mode === 'combat' && game.combat?.enemies?.some((e) => (e?.hp ?? 0) > 0)) {
    // Kill everything in the room at a small HP cost to keep the story moving.
    const cost = actor ? Math.max(1, Math.ceil(actor.maxHp * 0.1)) : 0
    if (actor && cost > 0) {
      applyDamage(actor, cost)
      partyWipe(game)
    }
    for (const enemy of game.combat.enemies) {
      enemy.hp = 0
    }
    game.mode = 'exploring'
    game.combat = undefined
    game.log.push({
      at: Date.now(),
      who: 'GM',
      what: cost > 0 ? `gm: auto_resolve combat (enemy slain at -${cost} HP)` : 'gm: auto_resolve combat (enemy slain)',
    })
  } else {
    const nextRoom = game.dungeon[game.roomIndex + 1]
    const currentRoom = game.dungeon[game.roomIndex]
    if (nextRoom?.type === 'barrier') {
      game.log.push({ at: Date.now(), who: 'GM', what: 'gm: auto_resolve barrier (opens)' })
    } else if (currentRoom?.type === 'puzzle') {
      game.log.push({ at: Date.now(), who: 'GM', what: 'gm: auto_resolve puzzle (skipped)' })
    } else {
      game.log.push({ at: Date.now(), who: 'GM', what: 'gm: auto_resolve obstacle' })
    }
  }

  game.log.push({ at: Date.now(), who: 'GM', what: 'The dungeon shifts around you, opening a new path...' })
  recordNarrativeBeat(game, { kind: 'gm', text: 'dungeon_shift', roomIndex: game.roomIndex })

  // Move the party forward one room.
  if (game.phase !== 'playing') return { intervened: true, repeatCount: recorded.repeatCount }
  if (game.roomIndex >= game.dungeon.length - 1) {
    game.phase = 'finished'
    game.mode = 'finished'
    game.combat = undefined
    return { intervened: true, repeatCount: recorded.repeatCount }
  }

  game.roomIndex += 1
  setRoomModeFromIndex(game, game.roomIndex)

  return { intervened: true, repeatCount: recorded.repeatCount }
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

  // Stuck detection: if an agent repeats the same failing "explore next room" action,
  // the GM will auto-resolve the obstacle and advance the party one room.
  // Use the attempted next room index as the target so normal exploration (changing targets)
  // does not trigger the stuck detector.
  {
    const attempted = Math.min(game.roomIndex + 1, game.dungeon.length - 1)
    const nextRoom = game.dungeon[attempted]

    // Barriers already have their own auto-crumble threshold (default 5). If we intervene on the
    // same threshold we prevent barrierAttempts from reaching the crumble point.
    let allowStuckIntervention = true
    if (nextRoom?.type === 'barrier') {
      const requiredClass = (nextRoom as { requiredClass?: string }).requiredClass ?? ''
      const hasRequiredClass = game.party.some((p) => p.klass === requiredClass)
      const autoCrumbleAttemptsRaw = (nextRoom as { autoCrumbleAttempts?: unknown }).autoCrumbleAttempts
      const autoCrumbleAttempts =
        typeof autoCrumbleAttemptsRaw === 'number' && Number.isFinite(autoCrumbleAttemptsRaw)
          ? Math.max(1, Math.min(20, Math.floor(autoCrumbleAttemptsRaw)))
          : 5

      if (!hasRequiredClass && autoCrumbleAttempts <= STUCK_REPEAT_THRESHOLD) {
        allowStuckIntervention = false
      }
    }

    if (allowStuckIntervention) {
      const stuck = gmInterveneIfStuck(game, {
        player: game.currentPlayer,
        action: 'explore',
        target: `room:${attempted}`,
      })
      if (stuck.intervened) {
        const room = game.dungeon[game.roomIndex] ?? null
        return { ok: true, room }
      }
    }
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
        // Don't resurrect: dead characters stay at 0 HP until an explicit mechanic revives them.
        if ((member.hp ?? 0) <= 0) continue
        member.hp = Math.min(member.maxHp, member.hp + 2)
        member.mp = Math.min(member.maxMp, member.mp + 1)
      }
    }

    if (room.type === 'treasure') {
      const actor = findCharacter(game, game.currentPlayer)
      if (actor) {
        actor.mp = Math.min(actor.maxMp, actor.mp + 1)
      }
      const item = pickTreasureItem(game, game.roomIndex)
      game.log.push({ at: Date.now(), who: game.currentPlayer, what: `treasure: found ${item}` })
      recordNarrativeBeat(game, { kind: 'treasure', text: item, roomIndex: game.roomIndex })
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
          if (actor.hp > 0 && actor.hp <= Math.max(1, Math.ceil(actor.maxHp * 0.2))) {
            game.log.push({ at: Date.now(), who: 'GM', what: `near-death: ${actor.name}` })
            recordNarrativeBeat(game, { kind: 'near_death', text: actor.name, roomIndex: game.roomIndex })
          }
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
	      const autoCrumbleAttemptsRaw = (room as { autoCrumbleAttempts?: unknown }).autoCrumbleAttempts
	      const autoCrumbleAttempts =
	        typeof autoCrumbleAttemptsRaw === 'number' && Number.isFinite(autoCrumbleAttemptsRaw)
	          ? Math.max(1, Math.min(20, Math.floor(autoCrumbleAttemptsRaw)))
	          : 5
	      const skillCheckTargetRaw = (room as { skillCheckTarget?: unknown }).skillCheckTarget
	      const skillCheckTarget =
	        typeof skillCheckTargetRaw === 'number' && Number.isFinite(skillCheckTargetRaw)
	          ? Math.max(1, Math.min(100, Math.floor(skillCheckTargetRaw)))
	          : 30
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
          recordNarrativeBeat(game, { kind: 'barrier', text: 'brute_force', roomIndex: game.roomIndex })
	        } else {
	          // 2) Skill check: INT/WIS at Hard difficulty (30%)
	          const check = resolveSkillCheck({ skill: skillCheckTarget, dice: input.dice })
	          if (check.success) {
	            delete game.barrierAttempts[barrierKey]
	            game.log.push({
	              at: Date.now(),
	              who: actor?.name ?? game.currentPlayer,
	              what: `barrier: skill_check success (roll ${check.roll} <= ${skillCheckTarget})`,
	            })
	            game.log.push({ at: Date.now(), who: game.currentPlayer, what: `barrier: bypassed (need ${requiredClass})` })
	            recordNarrativeBeat(game, { kind: 'barrier', text: 'skill_check', roomIndex: game.roomIndex })
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
              recordNarrativeBeat(game, { kind: 'barrier', text: 'mp_sacrifice', roomIndex: game.roomIndex })
	            } else {
	              // Failed attempt: count and potentially auto-crumble.
	              const next = (game.barrierAttempts[barrierKey] ?? 0) + 1
	              game.barrierAttempts[barrierKey] = next
	
		              // 4) Auto-crumble after N failed attempts.
		              if (next >= autoCrumbleAttempts) {
		                // Treat auto-crumble as a GM intervention event as well, so engine-only callers
		                // (tests, tools) see the same "unstuck" trace as the environment wrapper.
		                game.log.push({
		                  at: Date.now(),
		                  who: 'GM',
		                  what: `warning: stuck_detected (${game.currentPlayer} repeated explore ${next}x; target=room:${barrierIndex})`,
		                })
		                game.log.push({ at: Date.now(), who: 'GM', what: 'gm: auto_resolve barrier (opens)' })
		                game.log.push({ at: Date.now(), who: 'GM', what: 'The dungeon shifts around you, opening a new path...' })
		                game.log.push({
		                  at: Date.now(),
		                  who: game.currentPlayer,
		                  what: 'barrier: auto_crumble (The ancient seal weakens and shatters)',
		                })
		                recordNarrativeBeat(game, { kind: 'barrier', text: 'auto_crumble', roomIndex: game.roomIndex })
	              } else {
	                // Block: can't pass yet, stay on previous room
	                game.roomIndex -= 1
	                game.log.push({
	                  at: Date.now(),
	                  who: game.currentPlayer,
	                  what: `barrier: blocked (need ${requiredClass}) attempt ${next}/${autoCrumbleAttempts}`,
	                })
	                return { ok: true, room }
	              }
	            }
	          } else {
	            // No actor; treat as a failed attempt so the barrier can still crumble.
	            const next = (game.barrierAttempts[barrierKey] ?? 0) + 1
	            game.barrierAttempts[barrierKey] = next
		            if (next >= autoCrumbleAttempts) {
		              game.log.push({
		                at: Date.now(),
		                who: 'GM',
		                what: `warning: stuck_detected (${game.currentPlayer} repeated explore ${next}x; target=room:${barrierIndex})`,
		              })
		              game.log.push({ at: Date.now(), who: 'GM', what: 'gm: auto_resolve barrier (opens)' })
		              game.log.push({ at: Date.now(), who: 'GM', what: 'The dungeon shifts around you, opening a new path...' })
		              game.log.push({
		                at: Date.now(),
		                who: game.currentPlayer,
		                what: 'barrier: auto_crumble (The ancient seal weakens and shatters)',
		              })
	              recordNarrativeBeat(game, { kind: 'barrier', text: 'auto_crumble', roomIndex: game.roomIndex })
	            } else {
	              game.roomIndex -= 1
	              game.log.push({
	                at: Date.now(),
	                who: game.currentPlayer,
	                what: `barrier: blocked (need ${requiredClass}) attempt ${next}/${autoCrumbleAttempts}`,
	              })
	              return { ok: true, room }
	            }
	          }
	        }
	      } else {
        // Party has the class — barrier resolved, continue
        delete game.barrierAttempts?.[barrierKey]
        game.log.push({ at: Date.now(), who: game.currentPlayer, what: `barrier: resolved by ${requiredClass}` })
        recordNarrativeBeat(game, { kind: 'barrier', text: 'resolved', roomIndex: game.roomIndex })
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
