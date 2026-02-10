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
  /** The agent controlling this character (e.g. 'slag'). When set, turn matching uses this instead of name. */
  agent?: string
  klass: RpgClass
  // Optional narrative fields (backwards compatible with persisted games).
  backstory?: string
  stats: Stats
  skills: Skills
  // Optional for backwards compatibility with persisted games.
  armor?: number
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  level?: number
  xp?: number
}

export type Enemy = {
  name: string
  hp: number
  // Optional for backwards compatibility with persisted games and older tests.
  maxHp?: number
  DEX: number
  attack: number
  dodge: number
  // Optional, but when present it drives target selection and special behaviors.
  tactics?: EnemyTactics
  // Optional per-enemy turn counter for multi-phase behaviors.
  turnsTaken?: number
}

export type EnemyTacticKind = 'goblin' | 'orc' | 'skeleton' | 'boss' | 'unknown'

export type EnemyTactics = {
  kind: EnemyTacticKind
  // Boss-only knob: special ability cadence in phase 1.
  specialEveryTurns?: number
}

export type DifficultyTier = 'easy' | 'medium' | 'hard' | 'deadly' | 'boss'

// ── XP + leveling ────────────────────────────────────────────────────────────

export const XP_PER_ENEMY_KILL = 25
export const XP_PER_ROOM_CLEAR = 50
export const XP_PER_BOSS_KILL = 100
export const XP_PER_ADVENTURE_COMPLETE = 200

// XP needed to reach each level (1..10). Index is (level - 1).
export const XP_TABLE = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500]

export type BossPhase = {
  name: string
  trigger: 'start' | 'bloodied' | 'near_death'
  enemies: Enemy[]
  tactics: string[]
}

export type RoomMeta = {
  // GM-injected annotations that should not break existing rooms.
  hazards?: string[]
  gmEvents?: Array<{ at: number; kind: string; text: string }>

  // Barrier tuning knobs (defaults preserve legacy behavior).
  autoCrumbleAttempts?: number
  skillCheckTarget?: number

  // Dungeon-crafting metadata (optional for backwards compatibility).
  difficultyTier?: DifficultyTier
  tactics?: string[]
  bossPhases?: BossPhase[]
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

export type DungeonContext = {
  craftedAt: number
  // Stored for live adjudication and future tool calls (e.g. gm.adjust_difficulty).
  libraryContext: Record<string, string>
  // Human-readable notes derived from library context to explain why the dungeon is shaped this way.
  designNotes: string[]
  // Expected fight progression for pacing verification.
  difficultyCurve: DifficultyTier[]
}

export type FeedMessageType = 'ic' | 'ooc'

export type FeedMessage = {
  sender: string
  to: string
  message: string
  type: FeedMessageType
  timestamp: number
}

export type RpgGameState = {
  id: string
  type: 'rpg'
  phase: 'setup' | 'playing' | 'finished'
  mode: RpgMode
  // Turn-cycle counter. Used for rate limiting and other per-round mechanics.
  // Optional for backwards compatibility with persisted games.
  round?: number
  roomIndex: number
  theme: DungeonTheme
  dungeon: Room[]
  party: Character[]
  turnOrder: Character[]
  currentPlayer: string
  // XP earned during this adventure (keyed by agent id, i.e. Character.agent).
  // Optional for backwards compatibility with persisted games.
  xpEarned?: Record<string, number>
  // Optional setup interview between DM and players (only present for new characters).
  setupPhase?: {
    currentPlayerIndex: number
    exchangeCount: number
    maxExchanges: number
    dialogues: Record<string, string[]>
    complete: boolean
  }
  combat?: { enemies: Enemy[] }
  // GM lookups from pdf-brain keyed by query string (optional for backwards compat).
  libraryContext?: Record<string, string>
  // Dungeon-level notes and cached library context for adjudication (optional for backwards compat).
  dungeonContext?: DungeonContext
  // Tracks recent actions per player to detect stuck agent loops.
  // Optional for backwards compatibility with persisted games.
  actionHistory?: Record<string, RpgActionHistoryEntry[]>
  // Tracks repeated failed attempts on a given barrier room index.
  // Optional for backwards compatibility with persisted games.
  barrierAttempts?: Record<string, number>
  // Key story beats extracted from play (no need to parse the entire log at render time).
  // Optional for backwards compatibility with persisted games.
  narrativeContext?: NarrativeBeat[]
  // Agent-to-agent table talk / dialogue on the game feed.
  // Optional for backwards compatibility with persisted games.
  feedMessages?: FeedMessage[]
  campaignLog?: string[]
  // Per-round spam guard for send_message.
  // Optional for backwards compatibility with persisted games.
  messageRateLimit?: { round: number; counts: Record<string, number> }
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

export function createCharacter(input: { name: string; klass: RpgClass; agent?: string }): Character {
  const stats = classStats(input.klass)
  const skills = deriveSkills(stats)
  const maxHp = deriveMaxHp(stats)
  const maxMp = deriveMaxMp(stats)

  return {
    name: input.name,
    ...(input.agent ? { agent: input.agent } : {}),
    klass: input.klass,
    stats,
    skills,
    armor: 0,
    hp: maxHp,
    maxHp,
    mp: maxMp,
    maxMp,
    level: 1,
    xp: 0,
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
      ? { name: 'Goblin', hp, maxHp: hp, DEX: 40, attack: 30, dodge: 20, tactics: { kind: 'goblin' } }
      : { name: 'Orc', hp, maxHp: hp, DEX: 45, attack: 40, dodge: 25, tactics: { kind: 'orc' } }

  return {
    type: 'combat',
    description: withThemeDescription(theme, `A ${enemy.name.toLowerCase()} stalks the shadows.`),
    enemies: [enemy],
  }
}

function buildBossRoom(dice: Dice, theme: DungeonTheme): Room {
  const hp = 29 + rollDie(dice, 20) // 30+
  const enemy: Enemy = { name: 'Dungeon Boss', hp, maxHp: hp, DEX: 55, attack: 55, dodge: 35, tactics: { kind: 'boss', specialEveryTurns: 3 } }
  return { type: 'boss', description: withThemeDescription(theme, 'A hulking presence fills the chamber.'), enemies: [enemy] }
}

function clampLibrarySnippet(text: string, max = 220): string {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(0, max)
}

function extractTacticsFromLibrary(input: { text: string; keyword: string; defaults: string[] }): string[] {
  const text = String(input.text || '')
  const out = new Set<string>()
  for (const d of input.defaults) out.add(d)

  // Keep this intentionally simple and robust: preserve recognizable phrases if present.
  const normalized = text.toLowerCase()
  if (normalized.includes(input.keyword.toLowerCase())) out.add(input.keyword)
  if (normalized.includes('hit-and-run')) out.add('hit-and-run')
  if (normalized.includes('power attack')) out.add('power attack')
  if (normalized.includes('ambush')) out.add('ambush')
  if (normalized.includes('press the advantage')) out.add('press the advantage')

  return Array.from(out)
}

export function craftDungeonFromLibrary(input: {
  theme: DungeonTheme
  party: Character[]
  libraryContext: Record<string, string>
}): { rooms: Room[]; difficultyCurve: DifficultyTier[]; designNotes: string[] } {
  const theme = input.theme
  const party = Array.isArray(input.party) ? input.party : []
  const libraryContext = input.libraryContext ?? {}

  const pacingQuery = 'encounter design pacing and difficulty curve (Game Angry)'
  const brpQuery = 'BRP opposed roll mechanics combat (BRP SRD)'
  const tacticsQuery = "monster tactics for goblins and orcs (The Monsters Know What They're Doing)"
  const proceduresQuery = 'dungeon exploration procedures (OSE)'

  const designNotes: string[] = []
  const pacing = clampLibrarySnippet(libraryContext[pacingQuery] ?? '')
  const brp = clampLibrarySnippet(libraryContext[brpQuery] ?? '')
  const tactics = clampLibrarySnippet(libraryContext[tacticsQuery] ?? '')
  const procedures = clampLibrarySnippet(libraryContext[proceduresQuery] ?? '')

  if (pacing) designNotes.push(`Pacing (Game Angry): ${pacing}`)
  if (brp) designNotes.push(`Combat (BRP SRD): ${brp}`)
  if (tactics) designNotes.push(`Tactics (Monsters Know): ${tactics}`)
  if (procedures) designNotes.push(`Exploration (OSE): ${procedures}`)

  const partyClasses = uniquePartyClasses(party)
  const requiredClass: RpgClass = partyClasses[0] ?? 'Warrior'
  const partyScale = soloMultiplier(party.length)

  const goblinTactics = extractTacticsFromLibrary({
    text: libraryContext[tacticsQuery] ?? '',
    keyword: 'hit-and-run',
    defaults: ['hit-and-run', 'focus fire', 'disengage when hurt'],
  })

  const orcTactics = extractTacticsFromLibrary({
    text: libraryContext[tacticsQuery] ?? '',
    keyword: 'power attack',
    defaults: ['power attack', 'bully the weakest', 'press the advantage'],
  })

  const easy: Room = {
    type: 'combat',
    difficultyTier: 'easy',
    tactics: goblinTactics,
    description: withThemeDescription(theme, 'A lone goblin scout tests your defenses, then darts back into cover.'),
    enemies: [
      {
        name: 'Goblin',
        hp: Math.floor(6 * partyScale),
        maxHp: Math.floor(6 * partyScale),
        DEX: 45,
        attack: 25,
        dodge: 30,
        tactics: { kind: 'goblin' },
      },
    ],
  }

  const medium: Room = {
    type: 'combat',
    difficultyTier: 'medium',
    tactics: goblinTactics,
    description: withThemeDescription(theme, 'A goblin pack sets a crossfire in the cramped corridor.'),
    enemies: [
      {
        name: 'Goblin',
        hp: Math.floor(6 * partyScale),
        maxHp: Math.floor(6 * partyScale),
        DEX: 45,
        attack: 28,
        dodge: 32,
        tactics: { kind: 'goblin' },
      },
      {
        name: 'Goblin',
        hp: Math.floor(6 * partyScale),
        maxHp: Math.floor(6 * partyScale),
        DEX: 45,
        attack: 28,
        dodge: 32,
        tactics: { kind: 'goblin' },
      },
    ],
  }

  const hard: Room = {
    type: 'combat',
    difficultyTier: 'hard',
    tactics: orcTactics,
    description: withThemeDescription(theme, 'Orc raiders hold the choke point, daring you to break their line.'),
    enemies: [
      {
        name: 'Orc',
        hp: Math.floor(11 * partyScale),
        maxHp: Math.floor(11 * partyScale),
        DEX: 45,
        attack: 45,
        dodge: 28,
        tactics: { kind: 'orc' },
      },
      {
        name: 'Orc',
        hp: Math.floor(11 * partyScale),
        maxHp: Math.floor(11 * partyScale),
        DEX: 45,
        attack: 45,
        dodge: 28,
        tactics: { kind: 'orc' },
      },
    ],
  }

  const deadly: Room = {
    type: 'combat',
    difficultyTier: 'deadly',
    tactics: orcTactics,
    description: withThemeDescription(theme, 'An orc berserker crashes in with brutal swings while skirmishers harry the flanks.'),
    enemies: [
      {
        name: 'Orc',
        hp: Math.floor(16 * partyScale),
        maxHp: Math.floor(16 * partyScale),
        DEX: 50,
        attack: 55,
        dodge: 30,
        tactics: { kind: 'orc' },
      },
      {
        name: 'Goblin',
        hp: Math.floor(6 * partyScale),
        maxHp: Math.floor(6 * partyScale),
        DEX: 55,
        attack: 25,
        dodge: 35,
        tactics: { kind: 'goblin' },
      },
    ],
  }

  const bossPhase1Hp = Math.floor(40 * partyScale)
  const bossPhase2Hp = Math.floor(26 * partyScale)
  const bossPhase1: Enemy[] = [
    { name: 'Dungeon Boss', hp: bossPhase1Hp, maxHp: bossPhase1Hp, DEX: 55, attack: 55, dodge: 35, tactics: { kind: 'boss', specialEveryTurns: 3 } },
  ]
  const bossPhase2: Enemy[] = [
    { name: 'Dungeon Boss', hp: bossPhase2Hp, maxHp: bossPhase2Hp, DEX: 60, attack: 65, dodge: 40, tactics: { kind: 'boss', specialEveryTurns: 3 } },
  ]

  const boss: Room = {
    type: 'boss',
    difficultyTier: 'boss',
    tactics: ['multi-phase', 'terrain pressure', 'target the healer'],
    bossPhases: [
      { name: 'Phase 1: The Warden Stirs', trigger: 'start', enemies: bossPhase1, tactics: ['test defenses', 'probe weaknesses'] },
      { name: 'Phase 2: Brine-Fury Unsealed', trigger: 'bloodied', enemies: bossPhase2, tactics: ['all-in offense', 'deny rest', 'focus fire'] },
    ],
    description: withThemeDescription(theme, 'The master of this place rises, and the room itself feels like a weapon.'),
    enemies: bossPhase1.map((e) => ({ ...e })),
  }

  const rooms: Room[] = [
    { type: 'rest', description: withThemeDescription(theme, 'You stand at the threshold, counting torchlight and steps.') },
    easy,
    { type: 'trap', description: withThemeDescription(theme, 'A simple hazard invites care: mark time, test stones, listen first.') },
    medium,
    { type: 'treasure', description: withThemeDescription(theme, 'A salt-stiffened satchel holds coins and a half-ruined note.') },
    hard,
    { type: 'rest', description: withThemeDescription(theme, 'A sheltered alcove where the air is still enough to catch your breath.') },
    deadly,
    { type: 'rest', description: withThemeDescription(theme, 'A sealed side-room offers a rare moment to bind wounds and steady hands.') },
    {
      type: 'barrier',
      requiredClass,
      description: withThemeDescription(theme, `A sealed archway bars the way. Only a ${requiredClass} can open it.`),
    },
    { type: 'puzzle', description: withThemeDescription(theme, 'A door of etched sigils demands patience, not haste.') },
    boss,
  ]

  const difficultyCurve: DifficultyTier[] = ['easy', 'medium', 'hard', 'deadly', 'boss']
  return { rooms, difficultyCurve, designNotes }
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

/** Fantasy name pools for character generation */
const FANTASY_FIRST_NAMES: Record<RpgClass, string[]> = {
  Warrior: ['Kaelen', 'Bjorn', 'Theron', 'Grak', 'Voss', 'Draven', 'Kord', 'Ragnar'],
  Scout: ['Mira', 'Shade', 'Wren', 'Kael', 'Nyx', 'Riven', 'Talon', 'Zephyr'],
  Mage: ['Thorin', 'Elara', 'Caius', 'Lysara', 'Orion', 'Vex', 'Sable', 'Ashwin'],
  Healer: ['Lyra', 'Sera', 'Aldric', 'Enna', 'Solenne', 'Briar', 'Idris', 'Rowan'],
}

const FANTASY_EPITHETS: Record<RpgClass, string[]> = {
  Warrior: ['the Bold', 'Ironhand', 'Stoneshield', 'the Unyielding', 'Thunderfist', 'Steelborne'],
  Scout: ['Shadowstep', 'Nightwhisper', 'the Swift', 'Silentfoot', 'Duskwalker', 'Windrunner'],
  Mage: ['Starweaver', 'the Wise', 'Flamecaller', 'Spellwright', 'Voidtouched', 'Runebound'],
  Healer: ['Moonwhisper', 'Dawnbringer', 'the Merciful', 'Lightkeeper', 'Gracewalker', 'Sunblessed'],
}

export function generateFantasyName(klass: RpgClass, index: number): string {
  const firsts = FANTASY_FIRST_NAMES[klass]
  const epithets = FANTASY_EPITHETS[klass]
  return `${firsts[index % firsts.length]} ${epithets[index % epithets.length]}`
}

function toCharacter(value: string | Character, index: number): Character {
  if (typeof value !== 'string') return value
  const classes: RpgClass[] = ['Warrior', 'Scout', 'Mage', 'Healer']
  const klass = classes[index % classes.length]!
  const fantasyName = generateFantasyName(klass, Math.floor(index / classes.length))
  return createCharacter({ name: fantasyName, klass, agent: value })
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
    round: 1,
    roomIndex: 0,
    theme,
    dungeon,
    party,
    turnOrder,
    currentPlayer: turnOrder[0]?.agent ?? turnOrder[0]?.name ?? party[0]?.agent ?? party[0]?.name ?? 'unknown',
    combat,
    actionHistory: {},
    barrierAttempts: {},
    narrativeContext: [],
    feedMessages: [],
    campaignLog: [],
    log: [],
  }
}

export function findCharacter(game: RpgGameState, name: string): Character | undefined {
  // Match by agent field first (agent→character mapping), then by name (backwards compat)
  return game.party.find((p) => p.agent === name) ?? game.party.find((p) => p.name === name)
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

  // BRP-informed combat:
  // - Opposed rolls: success beats failure; if both succeed, compare margins.
  // - Critical hits: roll <= skill/5 => double damage.
  // - Fumbles: roll 96-00 => attacker hurts themselves for half damage.

  const atkSkill = clampSkill(attacker.skills.attack)
  const dodSkill = clampSkill(defender.skills.dodge)
  const strBonus = Math.floor(attacker.stats.STR / 25)
  const armorRaw = (defender as any).armor
  const armor = Number.isFinite(armorRaw) ? Math.max(0, Math.floor(armorRaw as number)) : 0

  const isFumble = atk.roll >= 96
  const critThreshold = Math.max(1, Math.floor(atkSkill / 5))
  const isCrit = !isFumble && atk.roll <= critThreshold

  if (isFumble) {
    const base = rollDie(input.dice, 6) + strBonus
    const selfDamage = Math.max(1, Math.floor(base / 2))
    applyDamage(attacker, selfDamage)
    partyWipe(game)
    game.log.push({ at: Date.now(), who: attacker.name, what: `fumble: hurt self for ${selfDamage}` })
    return { ok: true, hit: false, detail: 'fumble' }
  }

  const atkMargin = atk.success ? atkSkill - atk.roll : -Infinity
  const dodMargin = dod.success ? dodSkill - dod.roll : -Infinity

  const hit =
    atk.success &&
    (!dod.success || isCrit || atkMargin > dodMargin)

  if (hit) {
    const base = rollDie(input.dice, 6) + strBonus
    const raw = (isCrit ? base * 2 : base) - armor
    const damage = Math.max(0, raw)
    applyDamage(defender, damage)
    partyWipe(game)
    attacker.skills.attack = atk.nextSkill
    game.log.push({
      at: Date.now(),
      who: attacker.name,
      what: isCrit ? `critical hit ${defender.name} for ${damage}` : `hit ${defender.name} for ${damage}`,
    })
    return { ok: true, hit: true, detail: isCrit ? 'critical' : 'hit' }
  }

  if (dod.success) {
    defender.skills.dodge = dod.nextSkill
  }

  game.log.push({ at: Date.now(), who: attacker.name, what: `missed ${defender.name}` })
  return { ok: true, hit: false, detail: 'miss' }
}

function normalizeEnemyMaxHp(enemy: Enemy): number {
  const raw = (enemy as any).maxHp
  const maxHp =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : Math.max(1, Math.floor(enemy.hp ?? 1))
  if (!Number.isFinite((enemy as any).maxHp)) enemy.maxHp = maxHp
  return maxHp
}

function inferEnemyTactics(enemy: Enemy): EnemyTactics {
  const existing = (enemy as any).tactics as EnemyTactics | undefined
  if (existing && typeof existing === 'object' && typeof existing.kind === 'string') {
    return existing
  }

  const name = String(enemy?.name ?? '').toLowerCase()
  if (name.includes('goblin')) return { kind: 'goblin' }
  if (name.includes('orc')) return { kind: 'orc' }
  if (name.includes('skeleton')) return { kind: 'skeleton' }
  if (name.includes('boss')) return { kind: 'boss', specialEveryTurns: 3 }
  return { kind: 'unknown' }
}

function livingParty(party: Character[]): Character[] {
  return (Array.isArray(party) ? party : []).filter((p) => p && (p.hp ?? 0) > 0)
}

function pickLowestHp(candidates: Character[]): Character | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => {
    const hp = (a.hp ?? 0) - (b.hp ?? 0)
    if (hp !== 0) return hp
    const max = (a.maxHp ?? 0) - (b.maxHp ?? 0)
    if (max !== 0) return max
    return a.name.localeCompare(b.name)
  })[0]!
}

function pickHighestMaxHp(candidates: Character[]): Character | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => {
    const max = (b.maxHp ?? 0) - (a.maxHp ?? 0)
    if (max !== 0) return max
    const hp = (b.hp ?? 0) - (a.hp ?? 0)
    if (hp !== 0) return hp
    return a.name.localeCompare(b.name)
  })[0]!
}

export function selectTarget(input: { enemy: Enemy; party: Character[]; dice: Dice }): Character | null {
  const enemy = input.enemy
  const dice = input.dice
  const party = livingParty(input.party)
  if (party.length === 0) return null

  const tactics = inferEnemyTactics(enemy)

  if (tactics.kind === 'boss') {
    const healers = party.filter((p) => p.klass === 'Healer')
    return pickLowestHp(healers) ?? pickLowestHp(party)
  }

  if (tactics.kind === 'goblin') {
    const mages = party.filter((p) => p.klass === 'Mage')
    return pickLowestHp(mages) ?? pickLowestHp(party)
  }

  if (tactics.kind === 'orc') {
    // Aggressive: challenge the toughest target.
    return pickHighestMaxHp(party)
  }

  if (tactics.kind === 'skeleton') {
    const idx = rollDie(dice, party.length) - 1
    return party[Math.max(0, Math.min(party.length - 1, idx))] ?? null
  }

  const idx = rollDie(dice, party.length) - 1
  return party[Math.max(0, Math.min(party.length - 1, idx))] ?? null
}

type DamageType = 'piercing' | 'blunt' | 'magic' | 'unknown'

function damageTypeForCharacter(attacker: Character): DamageType {
  switch (attacker.klass) {
    case 'Scout':
      return 'piercing'
    case 'Warrior':
      return 'blunt'
    case 'Mage':
      return 'magic'
    case 'Healer':
      return 'blunt'
    default:
      return 'unknown'
  }
}

function adjustDamageAgainstEnemy(enemy: Enemy, amount: number, damageType: DamageType): number {
  const tactics = inferEnemyTactics(enemy)
  const dmg = Math.max(0, Math.floor(amount))
  if (dmg === 0) return 0

  if (tactics.kind === 'skeleton') {
    if (damageType === 'piercing') return Math.floor(dmg * 0.5)
    if (damageType === 'blunt') return Math.floor(dmg * 1.5)
  }

  return dmg
}

export function attackEnemy(
  game: RpgGameState,
  input: { attacker: string; enemyIndex?: number; dice: Dice }
): { ok: true; hit: boolean; damage: number; detail: string } {
  const attacker = findCharacter(game, input.attacker)
  const enemies = game.combat?.enemies ?? []
  const idx = Number.isFinite(input.enemyIndex) ? Math.max(0, Math.floor(input.enemyIndex as number)) : 0
  const enemy = enemies[idx]
  if (!attacker || !enemy) return { ok: true, hit: false, damage: 0, detail: 'invalid combatants' }

  normalizeEnemyMaxHp(enemy)

  const atk = resolveSkillCheck({ skill: attacker.skills.attack, dice: input.dice })
  const dod = resolveSkillCheck({ skill: enemy.dodge, dice: input.dice })
  const atkMargin = atk.success ? attacker.skills.attack - atk.roll : -Infinity
  const dodMargin = dod.success ? enemy.dodge - dod.roll : -Infinity
  const hit = atk.success && (!dod.success || atkMargin > dodMargin)

  if (!hit) {
    game.log.push({ at: Date.now(), who: attacker.name, what: `missed ${enemy.name}` })
    return { ok: true, hit: false, damage: 0, detail: 'miss' }
  }

  const strBonus = Math.floor(attacker.stats.STR / 25)
  const base = rollDie(input.dice, 6) + strBonus
  const damageType = damageTypeForCharacter(attacker)
  const damage = adjustDamageAgainstEnemy(enemy, base, damageType)

  enemy.hp = Math.max(0, enemy.hp - damage)
  attacker.skills.attack = atk.nextSkill

  game.log.push({ at: Date.now(), who: attacker.name, what: `hit ${enemy.name} for ${damage}` })
  return { ok: true, hit: true, damage, detail: 'hit' }
}

export type EnemyTurnResult = {
  ok: true
  action: 'attack' | 'flee' | 'idle'
  enemy: string
  targets: string[]
  damageByTarget: Record<string, number>
  detail: string
}

export function enemyTakeTurn(game: RpgGameState, input: { enemyIndex?: number; enemyName?: string; dice: Dice }): EnemyTurnResult {
  const enemies = game.combat?.enemies ?? []
  if (enemies.length === 0) {
    return { ok: true, action: 'idle', enemy: 'none', targets: [], damageByTarget: {}, detail: 'no enemies' }
  }

  let enemy: Enemy | undefined
  if (typeof input.enemyName === 'string' && input.enemyName.trim()) {
    const name = input.enemyName.trim()
    enemy = enemies.find((e) => e?.name === name && (e.hp ?? 0) > 0)
  } else if (Number.isFinite(input.enemyIndex)) {
    const idx = Math.max(0, Math.floor(input.enemyIndex as number))
    enemy = enemies[idx]
    if (enemy && (enemy.hp ?? 0) <= 0) enemy = undefined
  }

  enemy ??= enemies.find((e) => (e?.hp ?? 0) > 0)
  if (!enemy) {
    return { ok: true, action: 'idle', enemy: 'none', targets: [], damageByTarget: {}, detail: 'no living enemies' }
  }

  const maxHp = normalizeEnemyMaxHp(enemy)
  const tactics = inferEnemyTactics(enemy)

  const turnsTaken = Math.max(0, Math.floor((enemy as any).turnsTaken ?? 0)) + 1
  enemy.turnsTaken = turnsTaken

  // Goblin: flee when hurt.
  if (tactics.kind === 'goblin') {
    const ratio = maxHp > 0 ? enemy.hp / maxHp : 1
    if (ratio < 0.3) {
      enemy.hp = 0
      ;(enemy as any).fled = true
      game.log.push({ at: Date.now(), who: enemy.name, what: 'fled' })
      return { ok: true, action: 'flee', enemy: enemy.name, targets: [], damageByTarget: {}, detail: 'flee' }
    }
  }

  const party = livingParty(game.party)
  if (party.length === 0) {
    partyWipe(game)
    return { ok: true, action: 'idle', enemy: enemy.name, targets: [], damageByTarget: {}, detail: 'no targets' }
  }

  // Boss phase 2: enraged AoE (unavoidable half damage).
  if (tactics.kind === 'boss') {
    const ratio = maxHp > 0 ? enemy.hp / maxHp : 1
    const phase: 1 | 2 = ratio < 0.5 ? 2 : 1
    ;(enemy as any).phase = phase

    if (phase === 2) {
      const raw = rollDie(input.dice, 6)
      const scaled = Math.max(0, Math.floor(raw * soloMultiplier(game.party.length)))
      const enraged = Math.floor(scaled * 1.2)
      const perTarget = Math.floor(enraged / 2)

      const damageByTarget: Record<string, number> = {}
      const targets = party.map((p) => p.name)
      for (const member of party) {
        applyDamage(member, perTarget)
        damageByTarget[member.name] = perTarget
      }
      partyWipe(game)
      game.log.push({ at: Date.now(), who: enemy.name, what: `aoe ${perTarget} to all (enraged)` })
      return { ok: true, action: 'attack', enemy: enemy.name, targets, damageByTarget, detail: 'enraged_aoe' }
    }

    const target = selectTarget({ enemy, party, dice: input.dice }) ?? party[0]!
    const specialEvery = Math.max(1, Math.floor(tactics.specialEveryTurns ?? 3))
    const useSpecial = turnsTaken % specialEvery === 0

    if (useSpecial) {
      const raw = rollDie(input.dice, 6)
      const scaled = Math.max(0, Math.floor(raw * soloMultiplier(game.party.length)))
      const damage = scaled + 4
      applyDamage(target, damage)
      partyWipe(game)
      game.log.push({ at: Date.now(), who: enemy.name, what: `special hit ${target.name} for ${damage}` })
      return {
        ok: true,
        action: 'attack',
        enemy: enemy.name,
        targets: [target.name],
        damageByTarget: { [target.name]: damage },
        detail: 'special',
      }
    }

    // Default boss attack (single target, avoidable).
    const atk = resolveSkillCheck({ skill: enemy.attack, dice: input.dice })
    const dod = resolveSkillCheck({ skill: target.skills.dodge, dice: input.dice })
    const atkMargin = atk.success ? enemy.attack - atk.roll : -Infinity
    const dodMargin = dod.success ? target.skills.dodge - dod.roll : -Infinity
    const hit = atk.success && (!dod.success || atkMargin > dodMargin)
    if (hit) {
      const raw = rollDie(input.dice, 6)
      const scaled = Math.max(0, Math.floor(raw * soloMultiplier(game.party.length)))
      applyDamage(target, scaled)
      partyWipe(game)
      game.log.push({ at: Date.now(), who: enemy.name, what: `hit ${target.name} for ${scaled}` })
      return {
        ok: true,
        action: 'attack',
        enemy: enemy.name,
        targets: [target.name],
        damageByTarget: { [target.name]: scaled },
        detail: 'hit',
      }
    }

    game.log.push({ at: Date.now(), who: enemy.name, what: `missed ${target.name}` })
    return { ok: true, action: 'attack', enemy: enemy.name, targets: [target.name], damageByTarget: {}, detail: 'miss' }
  }

  const target = selectTarget({ enemy, party, dice: input.dice }) ?? party[0]!

  const powerAttack = tactics.kind === 'orc'
  const hitPenalty = powerAttack ? 10 : 0
  const damageBonus = powerAttack ? 10 : 0

  const atkSkill = clampSkill(enemy.attack - hitPenalty)
  const atk = resolveSkillCheck({ skill: atkSkill, dice: input.dice })
  const dod = resolveSkillCheck({ skill: target.skills.dodge, dice: input.dice })

  const atkMargin = atk.success ? atkSkill - atk.roll : -Infinity
  const dodMargin = dod.success ? target.skills.dodge - dod.roll : -Infinity
  const hit = atk.success && (!dod.success || atkMargin > dodMargin)

  if (hit) {
    const raw = rollDie(input.dice, 6)
    const scaled = Math.max(0, Math.floor(raw * soloMultiplier(game.party.length)))
    const damage = scaled + damageBonus
    applyDamage(target, damage)
    partyWipe(game)
    game.log.push({ at: Date.now(), who: enemy.name, what: `hit ${target.name} for ${damage}` })
    return {
      ok: true,
      action: 'attack',
      enemy: enemy.name,
      targets: [target.name],
      damageByTarget: { [target.name]: damage },
      detail: powerAttack ? 'power_attack_hit' : 'hit',
    }
  }

  game.log.push({ at: Date.now(), who: enemy.name, what: `missed ${target.name}` })
  return {
    ok: true,
    action: 'attack',
    enemy: enemy.name,
    targets: [target.name],
    damageByTarget: {},
    detail: powerAttack ? 'power_attack_miss' : 'miss',
  }
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

// ── Persistent character helpers ──────────────────────────────────────

import type { PersistentCharacter } from '@atproto-agent/core'

/**
 * Convert a persistent character into an in-game Character.
 * HP/MP are reset to max for each new adventure.
 */
export function persistentToGameCharacter(pc: PersistentCharacter, agent: string): Character {
  // Use createCharacter to get proper stats for the class, then override with persistent data
  const base = createCharacter({ name: pc.name, klass: pc.klass as RpgClass, agent })
  return {
    ...base,
    ...(pc.backstory ? { backstory: pc.backstory } : {}),
    hp: pc.maxHp,
    maxHp: pc.maxHp,
    mp: pc.maxMp,
    maxMp: pc.maxMp,
    skills: {
      attack: pc.skills.attack ?? base.skills.attack,
      dodge: pc.skills.dodge ?? base.skills.dodge,
      cast_spell: pc.skills.cast_spell ?? base.skills.cast_spell,
      use_skill: pc.skills.use_skill ?? base.skills.use_skill,
    },
  }
}

/**
 * Update (or create) a persistent character from in-game state after an adventure.
 */
export function gameCharacterToPersistent(
  gc: Character,
  existing: PersistentCharacter | null,
  adventureSummary?: string
): PersistentCharacter {
  const now = Date.now()
  const fallback: PersistentCharacter = {
    name: gc.name,
    klass: gc.klass,
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
    createdAt: now,
    updatedAt: now,
    gamesPlayed: 0,
    deaths: 0,
  }
  const base: PersistentCharacter = existing ? { ...fallback, ...existing } : fallback
  return {
    ...base,
    backstory: (gc.backstory && gc.backstory.trim()) ? gc.backstory : base.backstory,
    skills: { ...gc.skills },
    updatedAt: now,
    gamesPlayed: base.gamesPlayed + 1,
    deaths: gc.hp <= 0 ? base.deaths + 1 : base.deaths,
    adventureLog: adventureSummary
      ? [...base.adventureLog.slice(-9), adventureSummary]
      : base.adventureLog,
  }
}

export function awardXp(pc: PersistentCharacter, amount: number): { leveledUp: boolean; newLevel: number } {
  const amt = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  pc.xp = (Number.isFinite(pc.xp) ? pc.xp : 0) + amt

  const startLevel = Number.isFinite(pc.level) ? Math.max(1, Math.floor(pc.level)) : 1
  pc.level = startLevel

  let leveledUp = false
  // XP_TABLE[n] is the XP required to reach level (n+1).
  while (pc.level < XP_TABLE.length && pc.xp >= XP_TABLE[pc.level]!) {
    pc.level += 1
    leveledUp = true

    // Stat growth scales with the new level.
    pc.maxHp = (Number.isFinite(pc.maxHp) ? pc.maxHp : 0) + (5 + pc.level)
    pc.maxMp = (Number.isFinite(pc.maxMp) ? pc.maxMp : 0) + (3 + pc.level)

    // +5 to a random skill (stable ordering for deterministic tests).
    const skills = pc.skills && typeof pc.skills === 'object' ? pc.skills : {}
    const keys = Object.keys(skills).sort()
    if (keys.length > 0) {
      const idx = Math.min(keys.length - 1, Math.floor(Math.random() * keys.length))
      const k = keys[idx]!
      const cur = Number((skills as any)[k])
      ;(skills as any)[k] = (Number.isFinite(cur) ? cur : 0) + 5
    }
    pc.skills = skills
  }

  return { leveledUp, newLevel: pc.level }
}
