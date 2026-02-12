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

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'legendary'
export type ItemSlot = 'weapon' | 'armor' | 'consumable' | 'trinket'

export type LootItem = {
  name: string
  rarity: ItemRarity
  slot: ItemSlot
  effects: { stat: string; bonus: number }[]
  consumable?: { type: 'heal' | 'mp' | 'buff'; amount: number }
  gold?: number
  description: string
}

export type LootTier = 'early' | 'mid' | 'boss'
export type LootSource = 'treasure' | 'combat'
export type GeneratedLoot = { items: LootItem[]; gold: number }

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
  // Adventure-local death/resurrection state (optional for persisted compatibility).
  diedThisAdventure?: boolean
  deathCause?: string
  deathNarrated?: boolean
  resurrectionFailedThisAdventure?: boolean
  resurrectionWeakness?: number
  // Adventure inventory and economy.
  inventory: LootItem[]
  gold: number
}

export type Enemy = {
  name: string
  hp: number
  // Optional for backwards compatibility with persisted games and older tests.
  maxHp?: number
  DEX: number
  attack: number
  dodge: number
  // OSE-style morale (2-12). When low, creatures may flee/surrender.
  // Optional for backwards compatibility with persisted games.
  morale?: number
  // If true, the party can plausibly negotiate instead of fighting.
  // Optional for backwards compatibility with persisted games.
  negotiable?: boolean
  // Short per-monster description used to enrich encounter text.
  // Optional for backwards compatibility with persisted games.
  flavorText?: string
  // Optional damage reduction.
  armor?: number
  // Optional, but when present it drives target selection and special behaviors.
  tactics?: EnemyTactics
  // Optional per-enemy turn counter for multi-phase behaviors.
  turnsTaken?: number
}

export type EnemyTacticKind =
  | 'goblin'
  | 'orc'
  | 'skeleton'
  | 'boss'
  | 'unknown'
  // Expanded tactical archetypes for the bestiary.
  | 'pack'
  | 'ambush'
  | 'ranged'
  | 'spellcaster'
  | 'berserker'
  | 'retreater'
  | 'swarm'
  | 'guardian'

export type EnemyMoraleState = 'shaken' | 'steady' | 'fearless'

function clampEnemyStat(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(100, Math.floor(n)))
}

function clampMorale(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(12, Math.floor(n)))
}

export function enemyMoraleState(enemy: Enemy): EnemyMoraleState {
  const morale = clampMorale(enemy.morale, 9)
  if (morale <= 6) return 'shaken'
  if (morale >= 11) return 'fearless'
  return 'steady'
}

export function enemyIsMindless(enemy: Enemy): boolean {
  const kind = enemy.tactics?.kind ?? 'unknown'
  if (kind === 'skeleton' || kind === 'guardian' || kind === 'swarm') return true
  const name = String(enemy.name || '').toLowerCase()
  // Heuristic: keep simple and test-friendly.
  if (name.includes('skeleton') || name.includes('zombie') || name.includes('golem') || name.includes('construct')) return true
  if (name.includes('wolf') || name.includes('bear') || name.includes('spider') || name.includes('rat') || name.includes('boar')) return true
  return false
}

export function enemyIsNegotiable(enemy: Enemy): boolean {
  if (enemyIsMindless(enemy)) return false
  if (enemy.negotiable === true) return true
  if (enemy.negotiable === false) return false
  const kind = enemy.tactics?.kind ?? 'unknown'
  // Default: humanoids and intelligent foes can be negotiated with.
  if (kind === 'goblin' || kind === 'orc' || kind === 'ranged' || kind === 'spellcaster' || kind === 'berserker' || kind === 'ambush' || kind === 'retreater') {
    return true
  }
  return false
}

export function partyAverageLevel(party: Character[]): number {
  const list = Array.isArray(party) ? party : []
  if (list.length === 0) return 1
  const total = list.reduce((sum, member) => {
    const level = Number.isFinite(member?.level) ? Math.max(1, Math.floor(member.level as number)) : 1
    return sum + level
  }, 0)
  return Math.max(1, Math.floor(total / list.length))
}

export function encounterXpValue(enemies: Enemy[]): number {
  // Used by non-lethal resolutions (e.g. negotiate) to derive partial encounter XP.
  const list = Array.isArray(enemies) ? enemies : []
  let total = 0
  for (const enemy of list) {
    total += XP_PER_ENEMY_KILL
    if (enemy?.tactics?.kind === 'boss') total += XP_PER_BOSS_KILL
  }
  return total
}

// ─── Spell & Ability System ─────────────────────────────────────────────────

export interface SpellDef {
  name: string
  mpCost: number
  /** 'single' targets first living enemy, 'aoe' hits all, 'heal' targets ally */
  target: 'single' | 'aoe' | 'heal'
  /** Base damage dice (e.g. 2 means 2d6) — for heal spells this is heal dice */
  dice: number
  /** Flat bonus added to roll result */
  bonus: number
  /** Skill check required (cast_spell skill) */
  description: string
}

export interface AbilityDef {
  name: string
  /** Which class can use it */
  klass: RpgClass
  /** 'attack' modifies next attack, 'utility' is non-damage, 'heal' restores HP */
  type: 'attack' | 'utility' | 'heal'
  /** MP cost (0 for martial abilities) */
  mpCost: number
  description: string
}

export const SPELLS: Record<string, SpellDef> = {
  fireball:     { name: 'Fireball',     mpCost: 3, target: 'aoe',    dice: 2, bonus: 0, description: '2d6 fire damage to ALL enemies' },
  ice_lance:    { name: 'Ice Lance',    mpCost: 2, target: 'single', dice: 2, bonus: 4, description: '2d6+4 cold damage to one enemy' },
  lightning:    { name: 'Lightning',    mpCost: 4, target: 'single', dice: 3, bonus: 2, description: '3d6+2 lightning to one enemy' },
  heal:         { name: 'Heal',         mpCost: 2, target: 'heal',   dice: 2, bonus: 3, description: 'Restore 2d6+3 HP to wounded ally' },
  shield:       { name: 'Shield',       mpCost: 1, target: 'heal',   dice: 0, bonus: 0, description: '+10 dodge to caster for this round' },
  smite:        { name: 'Smite',        mpCost: 2, target: 'single', dice: 2, bonus: 2, description: '2d6+2 holy damage (Healer offensive)' },
}

export const ABILITIES: Record<string, AbilityDef> = {
  power_strike: { name: 'Power Strike', klass: 'Warrior', type: 'attack',  mpCost: 0, description: 'STR-boosted attack: +50% damage, -10 dodge this round' },
  shield_bash:  { name: 'Shield Bash',  klass: 'Warrior', type: 'utility', mpCost: 0, description: 'Stun one enemy (skip their next attack)' },
  aimed_shot:   { name: 'Aimed Shot',   klass: 'Scout',   type: 'attack',  mpCost: 0, description: 'DEX-based precision attack: +20 attack, double damage on crit' },
  stealth:      { name: 'Stealth',      klass: 'Scout',   type: 'utility', mpCost: 0, description: 'Become hidden — next attack auto-crits, enemies skip you' },
  heal_touch:   { name: 'Heal Touch',   klass: 'Healer',  type: 'heal',    mpCost: 2, description: 'Heal lowest HP ally for 2d6+WIS/10 HP' },
  protect:      { name: 'Protect',      klass: 'Healer',  type: 'utility', mpCost: 1, description: 'Grant +15 dodge to one ally for this round' },
}

export interface SpellResult {
  success: boolean
  damage: number
  healed: number
  targets: string[]
  narrative: string
  spellDef: SpellDef
}

export function resolveSpell(
  caster: Character,
  spellName: string,
  enemies: Enemy[],
  party: Character[],
  dice: Dice
): SpellResult {
  const def = SPELLS[spellName.toLowerCase()]
  if (!def) return { success: false, damage: 0, healed: 0, targets: [], narrative: `Unknown spell: ${spellName}`, spellDef: SPELLS.fireball! }

  // Skill check
  const check = resolveSkillCheck({ skill: caster.skills.cast_spell, dice })
  if (check.success) caster.skills.cast_spell = check.nextSkill

  if (!check.success) {
    return { success: false, damage: 0, healed: 0, targets: [], narrative: `${def.name} fizzles! (rolled ${check.roll} vs ${caster.skills.cast_spell})`, spellDef: def }
  }

  // Roll damage/healing
  let total = def.bonus + Math.floor(caster.stats.INT / 20)
  for (let i = 0; i < def.dice; i++) total += dice.d(6)

  if (def.target === 'heal') {
    // Heal lowest HP living ally
    const wounded = party.filter(p => p.hp > 0 && p.hp < p.maxHp).sort((a, b) => a.hp - b.hp)
    const target = wounded[0]
    if (!target) return { success: true, damage: 0, healed: 0, targets: [], narrative: `${def.name}: No wounded allies to heal.`, spellDef: def }
    const before = target.hp
    target.hp = Math.min(target.maxHp, target.hp + total)
    const healed = target.hp - before
    return { success: true, damage: 0, healed, targets: [target.name], narrative: `${def.name} heals ${target.name} for ${healed} HP! (${target.hp}/${target.maxHp})`, spellDef: def }
  }

  if (def.target === 'aoe') {
    // Hit all living enemies
    const living = enemies.filter(e => e.hp > 0)
    const names: string[] = []
    let totalDmg = 0
    for (const enemy of living) {
      const dmg = Math.max(1, total - Math.floor((enemy.armor ?? 0) / 2))
      enemy.hp = Math.max(0, enemy.hp - dmg)
      totalDmg += dmg
      names.push(`${enemy.name}(-${dmg})`)
    }
    return { success: true, damage: totalDmg, healed: 0, targets: names, narrative: `${def.name} hits ALL enemies for ${total} damage! ${names.join(', ')}`, spellDef: def }
  }

  // Single target — hit first living enemy
  const target = enemies.find(e => e.hp > 0)
  if (!target) return { success: true, damage: 0, healed: 0, targets: [], narrative: `${def.name}: No enemies to target.`, spellDef: def }
  const dmg = Math.max(1, total - Math.floor((target.armor ?? 0) / 2))
  target.hp = Math.max(0, target.hp - dmg)
  return { success: true, damage: dmg, healed: 0, targets: [target.name], narrative: `${def.name} strikes ${target.name} for ${dmg} damage! (${target.hp} HP left)`, spellDef: def }
}

export interface AbilityResult {
  success: boolean
  narrative: string
  damage: number
  healed: number
  abilityDef: AbilityDef
  /** Side effects to apply (e.g. dodge modifier, stun) */
  effects: { type: string; target: string; value: number }[]
}

export function resolveAbility(
  user: Character,
  abilityName: string,
  enemies: Enemy[],
  party: Character[],
  dice: Dice
): AbilityResult {
  const def = ABILITIES[abilityName.toLowerCase()]
  if (!def) return { success: false, narrative: `Unknown ability: ${abilityName}`, damage: 0, healed: 0, abilityDef: ABILITIES.power_strike!, effects: [] }

  const effects: { type: string; target: string; value: number }[] = []

  switch (abilityName.toLowerCase()) {
    case 'power_strike': {
      // STR-boosted attack with damage bonus
      const enemy = enemies.find(e => e.hp > 0)
      if (!enemy) return { success: false, narrative: 'No enemies to strike.', damage: 0, healed: 0, abilityDef: def, effects: [] }
      const check = resolveSkillCheck({ skill: user.skills.attack + 10, dice })
      if (!check.success) return { success: false, narrative: `Power Strike misses ${enemy.name}! (rolled ${check.roll})`, damage: 0, healed: 0, abilityDef: def, effects: [] }
      const baseDmg = dice.d(6) + Math.floor(user.stats.STR / 15)
      const dmg = Math.max(1, Math.floor(baseDmg * 1.5))
      enemy.hp = Math.max(0, enemy.hp - dmg)
      effects.push({ type: 'dodge_penalty', target: user.name, value: -10 })
      return { success: true, narrative: `POWER STRIKE smashes ${enemy.name} for ${dmg} damage! (${enemy.hp} HP left) [dodge -10 this round]`, damage: dmg, healed: 0, abilityDef: def, effects }
    }
    case 'shield_bash': {
      const enemy = enemies.find(e => e.hp > 0)
      if (!enemy) return { success: false, narrative: 'No enemies to bash.', damage: 0, healed: 0, abilityDef: def, effects: [] }
      const check = resolveSkillCheck({ skill: user.skills.attack, dice })
      if (!check.success) return { success: false, narrative: `Shield Bash misses ${enemy.name}.`, damage: 0, healed: 0, abilityDef: def, effects: [] }
      const dmg = Math.max(1, dice.d(4) + Math.floor(user.stats.STR / 25))
      enemy.hp = Math.max(0, enemy.hp - dmg)
      effects.push({ type: 'stun', target: enemy.name, value: 1 })
      return { success: true, narrative: `Shield Bash stuns ${enemy.name} for ${dmg} damage! Stunned enemies skip their next attack.`, damage: dmg, healed: 0, abilityDef: def, effects }
    }
    case 'aimed_shot': {
      const enemy = enemies.find(e => e.hp > 0)
      if (!enemy) return { success: false, narrative: 'No enemies to target.', damage: 0, healed: 0, abilityDef: def, effects: [] }
      const check = resolveSkillCheck({ skill: user.skills.attack + 20, dice })
      if (!check.success) return { success: false, narrative: `Aimed Shot misses ${enemy.name}. (rolled ${check.roll})`, damage: 0, healed: 0, abilityDef: def, effects: [] }
      const baseDmg = dice.d(6) + Math.floor(user.stats.DEX / 15)
      const crit = check.roll <= Math.floor(user.skills.attack / 5)
      const dmg = crit ? baseDmg * 2 : baseDmg
      enemy.hp = Math.max(0, enemy.hp - dmg)
      return { success: true, narrative: `${crit ? 'CRITICAL ' : ''}Aimed Shot hits ${enemy.name} for ${dmg} damage!${crit ? ' (double damage!)' : ''} (${enemy.hp} HP left)`, damage: dmg, healed: 0, abilityDef: def, effects }
    }
    case 'stealth': {
      effects.push({ type: 'hidden', target: user.name, value: 1 })
      return { success: true, narrative: `${user.name} vanishes into the shadows. Next attack will auto-crit. Enemies will skip you this round.`, damage: 0, healed: 0, abilityDef: def, effects }
    }
    case 'heal_touch': {
      const wounded = party.filter(p => p.hp > 0 && p.hp < p.maxHp).sort((a, b) => a.hp - b.hp)
      const target = wounded[0]
      if (!target) return { success: true, narrative: 'No wounded allies to heal.', damage: 0, healed: 0, abilityDef: def, effects: [] }
      const heal = dice.d(6) + dice.d(6) + Math.floor(user.stats.WIS / 10)
      const before = target.hp
      target.hp = Math.min(target.maxHp, target.hp + heal)
      const healed = target.hp - before
      return { success: true, narrative: `Heal Touch restores ${healed} HP to ${target.name}! (${target.hp}/${target.maxHp})`, damage: 0, healed, abilityDef: def, effects }
    }
    case 'protect': {
      const ally = party.filter(p => p.hp > 0).sort((a, b) => a.hp - b.hp)[0]
      if (!ally) return { success: false, narrative: 'No ally to protect.', damage: 0, healed: 0, abilityDef: def, effects: [] }
      effects.push({ type: 'dodge_bonus', target: ally.name, value: 15 })
      return { success: true, narrative: `${user.name} shields ${ally.name} with divine protection! (+15 dodge this round)`, damage: 0, healed: 0, abilityDef: def, effects }
    }
    default:
      return { success: false, narrative: `Unknown ability: ${abilityName}`, damage: 0, healed: 0, abilityDef: def, effects: [] }
  }
}

/** Get available spells for a class */
export function getClassSpells(klass: RpgClass): SpellDef[] {
  switch (klass) {
    case 'Mage':   return [SPELLS.fireball!, SPELLS.ice_lance!, SPELLS.lightning!, SPELLS.shield!]
    case 'Healer': return [SPELLS.heal!, SPELLS.smite!, SPELLS.shield!]
    case 'Scout':  return [] // Scouts don't cast
    case 'Warrior': return [] // Warriors don't cast
  }
}

/** Get available abilities for a class */
export function getClassAbilities(klass: RpgClass): AbilityDef[] {
  return Object.values(ABILITIES).filter(a => a.klass === klass)
}

/** Build combat ability menu for a character */
export function buildAbilityMenu(char: Character): string {
  const lines: string[] = []
  const spells = getClassSpells(char.klass)
  const abilities = getClassAbilities(char.klass)

  if (spells.length > 0) {
    lines.push(`SPELLS (MP: ${char.mp}/${char.maxMp}):`)
    for (const s of spells) {
      const canCast = char.mp >= s.mpCost ? '✓' : '✗'
      lines.push(`  ${canCast} cast_spell ${s.name.toLowerCase()} — ${s.description} (${s.mpCost} MP)`)
    }
  }

  if (abilities.length > 0) {
    lines.push(`ABILITIES:`)
    for (const a of abilities) {
      const canUse = a.mpCost === 0 || char.mp >= a.mpCost ? '✓' : '✗'
      lines.push(`  ${canUse} use_skill ${a.name.toLowerCase()} — ${a.description}${a.mpCost > 0 ? ` (${a.mpCost} MP)` : ' (free)'}`)
    }
  }

  return lines.join('\n')
}

export function nextEncounterRoomIndex(game: RpgGameState): number | null {
  if (game.phase !== 'playing') return null
  const next = game.roomIndex + 1
  if (next < 0 || next >= game.dungeon.length) return null
  const room = game.dungeon[next]
  if (room?.type === 'combat' || room?.type === 'boss') return next
  return null
}

export function isBossEncounterRoom(game: RpgGameState): boolean {
  const room = game.dungeon[game.roomIndex]
  if (room?.type === 'boss') return true
  const enemies = game.combat?.enemies ?? []
  return enemies.some((enemy) => (enemy?.hp ?? 0) > 0 && enemy?.tactics?.kind === 'boss')
}

export function normalizeEnemyForCombat(enemy: Enemy): Enemy {
  const kind = enemy.tactics?.kind ?? 'unknown'
  const maxHp = Number.isFinite(enemy.maxHp) ? Math.max(1, Math.floor(enemy.maxHp as number)) : Math.max(1, Math.floor(enemy.hp))
  const moraleDefault =
    kind === 'goblin' ? 6 :
    kind === 'orc' ? 8 :
    kind === 'boss' ? 12 :
    kind === 'skeleton' ? 12 :
    kind === 'guardian' ? 12 :
    kind === 'swarm' ? 10 :
    9

  const morale = clampMorale(enemy.morale, moraleDefault)
  const attack = clampEnemyStat(enemy.attack, 30)
  const dodge = clampEnemyStat(enemy.dodge, 20)
  const DEX = clampEnemyStat(enemy.DEX, 40)
  const negotiable = enemy.negotiable ?? enemyIsNegotiable(enemy)

  return {
    ...enemy,
    maxHp,
    morale,
    attack,
    dodge,
    DEX,
    negotiable,
  }
}

export function cloneEnemiesForCombat(enemies: Enemy[]): Enemy[] {
  const list = Array.isArray(enemies) ? enemies : []
  return list.map((e) => normalizeEnemyForCombat({ ...e }))
}

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
export const XP_PER_TRAP_DISARM = 25
export const XP_PER_BARRIER_CLEAR = 25
export const XP_PER_BARRIER_BRUTE_FORCE = 15
export const XP_PER_PUZZLE = 30
export const XP_PER_TREASURE_FIND = 10

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

export type NarrativeBeatKind = 'kill' | 'near_death' | 'death' | 'barrier' | 'treasure' | 'gm'

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

export type Faction = {
  id: string
  name: string
  disposition: number
  description: string
}

export type PlotPoint = {
  id: string
  description: string
  resolved: boolean
  adventureId?: string
}

export type StoryArc = {
  id: string
  name: string
  status: 'seeded' | 'active' | 'climax' | 'resolved' | 'failed'
  plotPoints: PlotPoint[]
}

export type WorldState = {
  factions: Faction[]
  locations: Array<{ id: string; name: string; description: string }>
  events: string[]
}

export type CampaignState = {
  id: string
  name: string
  premise: string
  worldState: WorldState
  storyArcs: StoryArc[]
  adventureCount: number
}

export type CampaignContextSummary = {
  id: string
  name: string
  premise: string
  activeArcs: string[]
  factions: string[]
  npcs: string[]
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
  campaignId?: string
  campaignAdventureNumber?: number
  campaignContext?: CampaignContextSummary
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

function copyLootItem(item: LootItem): LootItem {
  return {
    ...item,
    effects: Array.isArray(item.effects) ? item.effects.map((effect) => ({ ...effect })) : [],
    ...(item.consumable ? { consumable: { ...item.consumable } } : {}),
  }
}

function clampCurrency(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

function goldInRange(dice: Dice, min: number, max: number): number {
  const lo = Math.max(0, Math.floor(min))
  const hi = Math.max(lo, Math.floor(max))
  return lo + rollDie(dice, hi - lo + 1) - 1
}

function minorHealingPotion(dice: Dice): LootItem {
  return {
    name: 'Minor Healing Potion',
    rarity: 'common',
    slot: 'consumable',
    effects: [],
    consumable: { type: 'heal', amount: rollDie(dice, 6) },
    description: 'A corked vial that closes light cuts and bruises.',
  }
}

function sturdyHealingPotion(dice: Dice): LootItem {
  return {
    name: 'Healing Potion',
    rarity: 'uncommon',
    slot: 'consumable',
    effects: [],
    consumable: { type: 'heal', amount: rollDie(dice, 6) + rollDie(dice, 6) + 3 },
    description: 'A practiced alchemical blend used by veteran delvers.',
  }
}

function pickLootOption(options: LootItem[], dice: Dice, seedIndex?: number): LootItem {
  if (Number.isFinite(seedIndex)) {
    const idx = Math.abs((Math.floor(seedIndex as number) + options.length - 1) % options.length)
    return copyLootItem(options[idx]!)
  }
  return copyLootItem(options[rollDie(dice, options.length) - 1]!)
}

function itemByTier(tier: LootTier, dice: Dice, seedIndex?: number): LootItem {
  if (tier === 'early') {
    const options: LootItem[] = [
      {
        name: 'soot-black opal',
        rarity: 'common',
        slot: 'trinket',
        effects: [],
        gold: 15,
        description: 'A thumb-sized opal that drinks torchlight.',
      },
      {
        name: 'Rusty Shortsword',
        rarity: 'common',
        slot: 'weapon',
        effects: [{ stat: 'attack', bonus: 2 }],
        description: 'Rust blooms along the edge, but it still bites.',
      },
      minorHealingPotion(dice),
    ]
    return pickLootOption(options, dice, seedIndex)
  }

  if (tier === 'mid') {
    const options: LootItem[] = [
      {
        name: 'Silvered Shortsword',
        rarity: 'uncommon',
        slot: 'weapon',
        effects: [{ stat: 'attack', bonus: 5 }],
        description: 'A polished blade that turns aside foul ichor.',
      },
      {
        name: 'Silverweave Jerkin',
        rarity: 'uncommon',
        slot: 'armor',
        effects: [{ stat: 'dodge', bonus: 5 }],
        description: 'Fine links of silver thread that lighten your steps.',
      },
      sturdyHealingPotion(dice),
    ]
    return pickLootOption(options, dice, seedIndex)
  }

  const options: LootItem[] = [
    {
      name: 'Sunforged Greatblade',
      rarity: 'legendary',
      slot: 'weapon',
      effects: [{ stat: 'attack', bonus: 10 }],
      description: 'A rune-lit edge that hums like a struck bell.',
    },
    {
      name: 'Enchanted Bastion Plate',
      rarity: 'rare',
      slot: 'armor',
      effects: [{ stat: 'armor', bonus: 5 }],
      description: 'Layered plates that ring with warding sigils.',
    },
    {
      name: 'Scroll of Storm Spear',
      rarity: 'rare',
      slot: 'consumable',
      effects: [],
      consumable: { type: 'buff', amount: 10 },
      description: 'A one-use invocation that sharpens killing intent.',
    },
  ]
  return pickLootOption(options, dice, seedIndex)
}

export function generateLoot(input: { tier: LootTier; source: LootSource; dice: Dice; seedIndex?: number }): GeneratedLoot {
  const tier = input.tier
  const source = input.source
  const dice = input.dice
  const seedIndex = input.seedIndex

  if (source === 'combat') {
    if (tier === 'early') {
      const roll = rollDie(dice, 3)
      if (roll === 1) return { items: [], gold: goldInRange(dice, 1, 5) }
      if (roll === 2) return { items: [minorHealingPotion(dice)], gold: goldInRange(dice, 1, 3) }
      return {
        items: [
          {
            name: 'Copper Fang Charm',
            rarity: 'common',
            slot: 'trinket',
            effects: [],
            gold: 8,
            description: 'A crude trophy tied to sinew.',
          },
        ],
        gold: goldInRange(dice, 1, 5),
      }
    }

    if (tier === 'mid') {
      return {
        items: [itemByTier('mid', dice, seedIndex)],
        gold: goldInRange(dice, 5, 15),
      }
    }

    return {
      items: [itemByTier('boss', dice, seedIndex)],
      gold: goldInRange(dice, 50, 200),
    }
  }

  if (tier === 'early') {
    return {
      items: [itemByTier('early', dice, seedIndex)],
      gold: goldInRange(dice, 5, 20),
    }
  }

  if (tier === 'mid') {
    return {
      items: [itemByTier('mid', dice, seedIndex)],
      gold: goldInRange(dice, 20, 50),
    }
  }

  return {
    items: [itemByTier('boss', dice, seedIndex)],
    gold: goldInRange(dice, 50, 200),
  }
}

function applyLootEffect(character: Character, effect: { stat: string; bonus: number }): void {
  const stat = String(effect.stat ?? '').trim().toLowerCase()
  const bonus = Number.isFinite(effect.bonus) ? Math.floor(effect.bonus) : 0
  if (bonus === 0) return

  if (stat === 'attack') {
    character.skills.attack = clampSkill(character.skills.attack + bonus)
    return
  }
  if (stat === 'dodge') {
    character.skills.dodge = clampSkill(character.skills.dodge + bonus)
    return
  }
  if (stat === 'cast_spell') {
    character.skills.cast_spell = clampSkill(character.skills.cast_spell + bonus)
    return
  }
  if (stat === 'use_skill') {
    character.skills.use_skill = clampSkill(character.skills.use_skill + bonus)
    return
  }
  if (stat === 'armor') {
    const baseArmor = Number.isFinite(character.armor) ? Math.floor(character.armor as number) : 0
    character.armor = Math.max(0, baseArmor + bonus)
  }
}

export function applyLootToCharacter(character: Character, loot: GeneratedLoot): void {
  if (!character) return
  character.inventory = Array.isArray(character.inventory) ? character.inventory : []
  character.gold = clampCurrency(character.gold)

  const grantedGold = clampCurrency(loot.gold)
  if (grantedGold > 0) character.gold += grantedGold

  const items = Array.isArray(loot.items) ? loot.items : []
  for (const item of items) {
    const safe = copyLootItem(item)
    character.inventory.push(safe)
    if (safe.slot === 'consumable') continue
    for (const effect of safe.effects) applyLootEffect(character, effect)
  }
}

function describeLootItem(item: LootItem): string {
  const effects = Array.isArray(item.effects) ? item.effects : []
  if (effects.length === 0) return item.name
  const fx = effects.map((effect) => `${effect.bonus >= 0 ? '+' : ''}${effect.bonus} ${effect.stat}`).join(', ')
  return `${item.name} (${fx})`
}

function joinHuman(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export function formatLootSummary(loot: GeneratedLoot): string {
  const chunks: string[] = []
  const items = Array.isArray(loot.items) ? loot.items : []
  if (items.length > 0) chunks.push(joinHuman(items.map(describeLootItem)))
  const gold = clampCurrency(loot.gold)
  if (gold > 0) chunks.push(`${gold} gold pieces`)
  if (chunks.length === 0) return 'nothing of value'
  return chunks.join(' and ')
}

function normalizeLootInventory(raw: unknown): LootItem[] {
  if (!Array.isArray(raw)) return []
  const out: LootItem[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const name = entry.trim()
      if (!name) continue
      out.push({
        name,
        rarity: 'common',
        slot: 'trinket',
        effects: [],
        description: `Legacy item: ${name}`,
      })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    if (!name) continue
    const rarityRaw = typeof rec.rarity === 'string' ? rec.rarity : 'common'
    const rarity: ItemRarity =
      rarityRaw === 'common' || rarityRaw === 'uncommon' || rarityRaw === 'rare' || rarityRaw === 'legendary'
        ? rarityRaw
        : 'common'
    const slotRaw = typeof rec.slot === 'string' ? rec.slot : 'trinket'
    const slot: ItemSlot =
      slotRaw === 'weapon' || slotRaw === 'armor' || slotRaw === 'consumable' || slotRaw === 'trinket'
        ? slotRaw
        : 'trinket'
    const effects = Array.isArray(rec.effects)
      ? rec.effects
          .filter((effect) => effect && typeof effect === 'object')
          .map((effect) => ({
            stat: String((effect as Record<string, unknown>).stat ?? ''),
            bonus: Number.isFinite((effect as Record<string, unknown>).bonus)
              ? Math.floor((effect as Record<string, unknown>).bonus as number)
              : 0,
          }))
      : []
    const consumable = rec.consumable && typeof rec.consumable === 'object'
      ? (() => {
          const c = rec.consumable as Record<string, unknown>
          const typeRaw = typeof c.type === 'string' ? c.type : null
          const type = typeRaw === 'heal' || typeRaw === 'mp' || typeRaw === 'buff' ? typeRaw : null
          const amount = Number.isFinite(c.amount) ? Math.max(0, Math.floor(c.amount as number)) : 0
          if (!type) return undefined
          return { type, amount } as { type: 'heal' | 'mp' | 'buff'; amount: number }
        })()
      : undefined
    out.push({
      name,
      rarity,
      slot,
      effects,
      ...(consumable ? { consumable } : {}),
      ...(Number.isFinite(rec.gold) ? { gold: clampCurrency(rec.gold) } : {}),
      description: typeof rec.description === 'string' && rec.description.trim()
        ? rec.description.trim()
        : `${name} salvaged from a prior adventure.`,
    })
  }
  return out
}

function formatBeatForRoom(beat: NarrativeBeat): string {
  switch (beat.kind) {
    case 'treasure':
      return `The ${beat.text} in your pack feels heavier than it should.`
    case 'death':
      return `${beat.text} fell once in these halls, and the memory still lingers.`
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
    case 'death':
      return `${beat.text} crossed death's threshold and came back altered.`
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

function clampDeathCause(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 180)
}

function characterIdentity(character: Character): string {
  const id = typeof character.agent === 'string' && character.agent.trim() ? character.agent : character.name
  return String(id ?? '').trim()
}

export function markCharacterDeath(
  game: RpgGameState,
  character: Character,
  causeOfDeath?: string
): boolean {
  if (!character || (character.hp ?? 0) > 0) return false

  character.diedThisAdventure = true
  const cause = clampDeathCause(causeOfDeath)
  if (cause) {
    character.deathCause = cause
  } else if (!clampDeathCause(character.deathCause)) {
    const locale = clampDeathCause(game.theme?.name) || 'the dungeon'
    character.deathCause = `slain in ${locale}`
  }

  if (character.deathNarrated) return false

  game.log.push({
    at: Date.now(),
    who: 'GM',
    what: `${character.name} has fallen! Their adventure ends here.`,
  })
  recordNarrativeBeat(game, { kind: 'death', text: character.name, roomIndex: game.roomIndex })

  const healerAlive = game.party.some((member) => {
    if (!member || characterIdentity(member) === characterIdentity(character)) return false
    return member.klass === 'Healer' && (member.hp ?? 0) > 0
  })
  if (healerAlive) {
    game.log.push({
      at: Date.now(),
      who: 'GM',
      what: 'A resurrection may yet be possible...',
    })
  }

  character.deathNarrated = true
  return true
}

export function markPartyDeaths(
  game: RpgGameState,
  causesByCharacterId?: Record<string, string>
): string[] {
  const fallen: string[] = []
  const map = causesByCharacterId ?? {}

  for (const member of game.party) {
    if (!member || (member.hp ?? 0) > 0) continue
    const id = characterIdentity(member)
    const cause = map[id] ?? map[member.name]
    const newlyMarked = markCharacterDeath(game, member, cause)
    if (newlyMarked) fallen.push(id)
  }

  return fallen
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
    inventory: [],
    gold: 0,
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

function campaignArcFocus(campaignState: CampaignState): string[] {
  const active = (Array.isArray(campaignState.storyArcs) ? campaignState.storyArcs : [])
    .filter((arc) => arc && arc.status === 'active')
    .map((arc) => String(arc.name || '').trim())
    .filter(Boolean)
  if (active.length > 0) return active.slice(0, 2)

  const fallback = campaignState.storyArcs?.[0]?.name ? [campaignState.storyArcs[0].name] : []
  return fallback.filter(Boolean)
}

function withCampaignTheme(baseTheme: DungeonTheme, campaignState: CampaignState): DungeonTheme {
  const arcs = campaignArcFocus(campaignState)
  const arcText = arcs.length > 0 ? arcs.join(' / ') : 'Unfolding campaign arc'
  const premise = String(campaignState.premise || '').trim()
  return {
    name: `${baseTheme.name} - ${arcText}`,
    backstory: `${baseTheme.backstory} Campaign premise: ${premise}. Arc focus: ${arcText}.`,
  }
}

function withThemeDescription(theme: DungeonTheme, description: string): string {
  const base = String(description || '').trim()
  // Keep it obvious for tests and for humans scanning logs.
  if (!base) return theme.name
  if (base.includes(theme.name)) return base
  return `${theme.name}: ${base}`
}

// ── BESTIARY ─────────────────────────────────────────────────────────────────
// Stats sourced from OSE Classic Fantasy Rules Tome + Advanced Expansion Set.
// Tactical behaviors from "The Monsters Know What They're Doing" (Keith Ammann).
// Morale scores use the OSE 2-12 scale (2d6 vs morale; higher = braver).
//
// Our combat uses BRP-style d100 skill checks, so we map OSE HD/THAC0 to:
//   attack = 25 + (HD * 5), dodge = 15 + (HD * 3), DEX = 30 + (HD * 4)
//   HP = OSE average hp ± dice variance for variety.

type BestiaryEntry = {
  name: string
  /** Base HP (dice roll added on top) */
  hp: number
  /** Extra random HP via rollDie(dice, hpDie) */
  hpDie: number
  DEX: number
  attack: number
  dodge: number
  morale: number
  negotiable: boolean
  tactics: EnemyTactics
  flavorText: string
}

// ── EARLY TIER (HD 1-2): dungeon fodder ──────────────────────────────────────
// From OSE: Goblin HD 1-1 (ML 7), Kobold HD ½ (ML 6), Skeleton HD 1 (ML 12),
// Fire Beetle HD 1+2 (ML 7), Giant Rat HD ½ (ML 8), Stirge HD 1* (ML 9),
// Giant Centipede HD ½ (ML 7), Zombie HD 2 (ML 12), Bat Swarm HD 2 (ML 6)

const EARLY_ENEMIES: BestiaryEntry[] = [
  // OSE: Goblin AC 6[13], HD 1-1 (3hp), Att 1×weapon (1d6), ML 7
  // Monsters Know: goblins are sneaky ambushers, use hit-and-run, never fight fair
  { name: 'Goblin', hp: 4, hpDie: 3, DEX: 35, attack: 30, dodge: 22, morale: 7, negotiable: true,
    tactics: { kind: 'goblin' }, flavorText: 'A wiry goblin crouches in shadow, blade drawn, eyes glinting.' },
  // OSE: Kobold AC 7[12], HD ½ (2hp), Att 1×weapon (1d4), ML 6
  // Monsters Know: kobolds use traps and pack tactics, flee when cornered alone
  { name: 'Kobold', hp: 3, hpDie: 2, DEX: 32, attack: 25, dodge: 18, morale: 6, negotiable: true,
    tactics: { kind: 'pack' }, flavorText: 'A small, scaly kobold clutches a crude spear, yipping to its fellows.' },
  // OSE: Skeleton AC 7[12], HD 1 (4hp), Att 1×weapon (1d6), ML 12 (undead, fights to destruction)
  { name: 'Skeleton', hp: 4, hpDie: 3, DEX: 30, attack: 30, dodge: 18, morale: 12, negotiable: false,
    tactics: { kind: 'skeleton' }, flavorText: 'Bones clatter as a skeletal warrior rises, weapon in hand.' },
  // OSE: Fire Beetle AC 4[15], HD 1+2 (6hp), Att 1×bite (2d4), ML 7
  { name: 'Fire Beetle', hp: 5, hpDie: 4, DEX: 34, attack: 32, dodge: 20, morale: 7, negotiable: false,
    tactics: { kind: 'swarm' }, flavorText: 'A dog-sized beetle with glowing nodules scuttles forward, mandibles snapping.' },
  // OSE: Giant Rat AC 7[12], HD ½ (2hp), Att 1×bite (1d3 + disease), ML 8
  { name: 'Giant Rat', hp: 3, hpDie: 2, DEX: 38, attack: 25, dodge: 20, morale: 8, negotiable: false,
    tactics: { kind: 'swarm' }, flavorText: 'A mangy rat the size of a terrier bares yellowed fangs.' },
  // OSE: Stirge AC 7[12], HD 1* (4hp), Att 1×proboscis (1d3 + blood drain), ML 9
  { name: 'Stirge', hp: 4, hpDie: 2, DEX: 40, attack: 33, dodge: 25, morale: 9, negotiable: false,
    tactics: { kind: 'ambush' }, flavorText: 'A bat-winged mosquito-thing drops from the ceiling, proboscis extended.' },
  // OSE: Giant Centipede AC 9[10], HD ½ (2hp), Att 1×bite (poison), ML 7
  { name: 'Giant Centipede', hp: 3, hpDie: 2, DEX: 36, attack: 28, dodge: 18, morale: 7, negotiable: false,
    tactics: { kind: 'ambush' }, flavorText: 'A segmented horror as long as your arm writhes out of a crack in the wall.' },
  // OSE: Zombie AC 8[11], HD 2 (9hp), Att 1×weapon (1d8), ML 12 (undead)
  { name: 'Zombie', hp: 8, hpDie: 4, DEX: 25, attack: 30, dodge: 15, morale: 12, negotiable: false,
    tactics: { kind: 'berserker' }, flavorText: 'A shambling corpse lurches forward, dead eyes fixed on the living.' },
  // OSE: Bat Swarm - Normal Bat AC 6[13], HD 2 (as swarm), Att confusion, ML 6
  { name: 'Bat Swarm', hp: 6, hpDie: 4, DEX: 42, attack: 28, dodge: 30, morale: 6, negotiable: false,
    tactics: { kind: 'swarm' }, flavorText: 'A cloud of shrieking bats erupts from the darkness, filling the passage.' },
  // OSE: Carcass Crawler (Carrion Crawler) AC 7[12], HD 3+1 (14hp), Att 8×tentacle (paralysis), ML 9
  // Slightly tough for early but keeps things spicy
  { name: 'Carcass Crawler', hp: 10, hpDie: 6, DEX: 35, attack: 35, dodge: 22, morale: 9, negotiable: false,
    tactics: { kind: 'ambush' }, flavorText: 'A pale, segmented worm with writhing tentacles drops from above.' },
]

// ── MID TIER (HD 3-5): dungeon threats ───────────────────────────────────────
// From OSE: Orc HD 1 but tougher group (ML 8), Bugbear HD 3+1 (ML 9),
// Hobgoblin HD 1+1 (ML 8), Ghoul HD 2* (ML 9), Gnoll HD 2 (ML 8),
// Ogre HD 4+1 (ML 10), Wight HD 3* (ML 12), Gargoyle HD 4** (ML 11),
// Gelatinous Cube HD 4* (ML 12), Ghast HD 4* (ML 9)

const MID_ENEMIES: BestiaryEntry[] = [
  // OSE: Orc AC 6[13], HD 1 (4hp), Att 1×weapon (1d6), ML 8 (but we scale up for mid-tier)
  // Monsters Know: orcs are aggressive, fight in groups, press advantage on weakest
  { name: 'Orc Warrior', hp: 10, hpDie: 6, DEX: 40, attack: 42, dodge: 25, morale: 8, negotiable: true,
    tactics: { kind: 'orc' }, flavorText: 'A brutish orc with a notched blade snarls a challenge.' },
  // OSE: Bugbear HD 3+1 (14hp), Att 1×weapon (2d4), ML 9
  // Monsters Know: bugbears are stealthy brutes, surprise attack then press
  { name: 'Bugbear', hp: 12, hpDie: 6, DEX: 38, attack: 45, dodge: 25, morale: 9, negotiable: false,
    tactics: { kind: 'ambush' }, flavorText: 'A hulking, hairy goblinoid emerges from hiding, mace raised high.' },
  // OSE: Hobgoblin AC 6[13], HD 1+1 (5hp), Att 1×weapon (1d8), ML 8
  // Monsters Know: disciplined soldiers, fight in formation, use tactics
  { name: 'Hobgoblin', hp: 8, hpDie: 4, DEX: 38, attack: 40, dodge: 24, morale: 8, negotiable: true,
    tactics: { kind: 'guardian' }, flavorText: 'A heavily-armored hobgoblin stands in disciplined formation.' },
  // OSE: Ghoul AC 6[13], HD 2* (9hp), Att 2×claw (1d3 + paralysis), 1×bite (1d3 + paralysis), ML 9
  { name: 'Ghoul', hp: 9, hpDie: 4, DEX: 42, attack: 40, dodge: 24, morale: 9, negotiable: false,
    tactics: { kind: 'pack' }, flavorText: 'A hunched, grey-skinned corpse-eater licks its claws, reeking of the grave.' },
  // OSE: Gnoll HD 2 (9hp), Att 1×weapon (2d4 or by weapon +1), ML 8
  { name: 'Gnoll', hp: 9, hpDie: 5, DEX: 38, attack: 42, dodge: 22, morale: 8, negotiable: true,
    tactics: { kind: 'pack' }, flavorText: 'A hyena-headed gnoll lopes forward, flind bar crackling with menace.' },
  // OSE: Ogre HD 4+1 (18hp), Att 1×club (1d10), ML 10
  // Monsters Know: ogres are stupid but strong, charge the biggest target
  { name: 'Ogre', hp: 16, hpDie: 8, DEX: 35, attack: 48, dodge: 22, morale: 10, negotiable: true,
    tactics: { kind: 'berserker' }, flavorText: 'A massive ogre fills the corridor, dragging a tree-trunk club.' },
  // OSE: Wight AC 5[14], HD 3* (13hp), Att 1×touch (energy drain), ML 12 (undead)
  { name: 'Wight', hp: 12, hpDie: 6, DEX: 40, attack: 45, dodge: 28, morale: 12, negotiable: false,
    tactics: { kind: 'guardian' }, flavorText: 'A fell presence in corroded armor, its touch drains life itself.' },
  // OSE: Gargoyle AC 5[14], HD 4** (18hp), Att 2×claw (1d3), 1×bite (1d6), 1×horn (1d4), ML 11
  { name: 'Gargoyle', hp: 15, hpDie: 6, DEX: 42, attack: 46, dodge: 30, morale: 11, negotiable: false,
    tactics: { kind: 'ambush' }, flavorText: 'Stone wings unfold as a gargoyle drops from its perch, talons extended.' },
  // OSE: Gelatinous Cube AC 8[11], HD 4* (18hp), Att 1×touch (2d4 + paralysis), ML 12
  { name: 'Gelatinous Cube', hp: 16, hpDie: 6, DEX: 15, attack: 35, dodge: 8, morale: 12, negotiable: false,
    tactics: { kind: 'guardian' }, flavorText: 'A translucent cube of quivering jelly fills the passage, bones floating within.' },
  // Advanced OSE: Ghast AC 3[16], HD 4* (18hp), Att 2×claw (1d4+paralysis), 1×bite (1d8+paralysis), ML 9
  { name: 'Ghast', hp: 14, hpDie: 6, DEX: 44, attack: 48, dodge: 28, morale: 9, negotiable: false,
    tactics: { kind: 'pack' }, flavorText: 'A foul stench precedes this grotesque undead, stronger and fouler than any ghoul.' },
]

// ── BOSS TIER (HD 6+): dungeon lords ─────────────────────────────────────────
// From OSE: Troll HD 6+3 (ML 10), Wraith HD 4** (ML 12), Minotaur HD 6 (ML 12),
// Manticore HD 6+1 (ML 9), Owlbear HD 5 (ML 9), Basilisk HD 6** (ML 9),
// Hydra HD 5-12 (ML 9+), Black Pudding HD 10* (ML 12)

type BossEntry = BestiaryEntry & { minionPool: BestiaryEntry[] }

const BOSS_ENEMIES: BossEntry[] = [
  // OSE: Troll HD 6+3 (30hp), Att 2×claw (1d6), 1×bite (1d10), ML 10
  // Monsters Know: trolls regenerate, fight recklessly, focus one target
  { name: 'Cave Troll', hp: 30, hpDie: 12, DEX: 48, attack: 55, dodge: 35, morale: 10, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 2 },
    flavorText: 'A lanky, green-skinned troll unfolds to its full height, wounds already closing.',
    minionPool: [MID_ENEMIES[0]!, MID_ENEMIES[4]!] }, // Orc Warriors + Gnolls
  // OSE: Wraith AC 3[16], HD 4** (18hp), Att 1×touch (1d6 + energy drain), ML 12
  { name: 'Tomb Wraith', hp: 28, hpDie: 10, DEX: 55, attack: 58, dodge: 40, morale: 12, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 2 },
    flavorText: 'A shrieking specter in tattered robes, its mere presence saps warmth from the air.',
    minionPool: [EARLY_ENEMIES[2]!, EARLY_ENEMIES[7]!] }, // Skeletons + Zombies
  // OSE: Minotaur HD 6 (27hp), Att 1×gore (1d6), 1×bite (1d6) or weapon (1d6+2), ML 12
  // Monsters Know: minotaurs are territorial, charge, use labyrinth knowledge
  { name: 'Minotaur', hp: 28, hpDie: 10, DEX: 50, attack: 56, dodge: 32, morale: 12, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 2 },
    flavorText: 'A bull-headed horror snorts in rage, lowering its horns for a devastating charge.',
    minionPool: [EARLY_ENEMIES[0]!, EARLY_ENEMIES[1]!] }, // Goblins + Kobolds (enslaved servants)
  // OSE: Manticore HD 6+1 (28hp), Att 2×claw (1d4), 1×bite (2d4) or 6×tail spikes (1d6 each), ML 9
  { name: 'Manticore', hp: 26, hpDie: 12, DEX: 52, attack: 54, dodge: 35, morale: 9, negotiable: true,
    tactics: { kind: 'boss', specialEveryTurns: 3 },
    flavorText: 'A lion-bodied beast with a human face grins wickedly, tail bristling with spikes.',
    minionPool: [EARLY_ENEMIES[4]!, EARLY_ENEMIES[5]!] }, // Giant Rats + Stirges
  // OSE: Owlbear HD 5 (22hp), Att 2×claw (1d8), 1×bite (1d8), ML 9
  { name: 'Owlbear', hp: 24, hpDie: 10, DEX: 45, attack: 52, dodge: 30, morale: 9, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 2 },
    flavorText: 'A feathered ursine monstrosity shrieks with an owl\'s cry and charges.',
    minionPool: [EARLY_ENEMIES[3]!, EARLY_ENEMIES[6]!] }, // Fire Beetles + Giant Centipedes
  // OSE: Basilisk AC 4[15], HD 6+1** (28hp), Att 1×bite (1d10 + petrification gaze), ML 9
  { name: 'Basilisk', hp: 26, hpDie: 10, DEX: 35, attack: 50, dodge: 28, morale: 9, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 2 },
    flavorText: 'An eight-legged serpent with deadly eyes. Do NOT meet its gaze.',
    minionPool: [EARLY_ENEMIES[6]!, EARLY_ENEMIES[8]!] }, // Giant Centipedes + Bat Swarms
  // Advanced OSE: Demonic Knight HD 10*** (45hp), Att 1×magic sword (1d8+6), ML 12
  { name: 'Demonic Knight', hp: 40, hpDie: 15, DEX: 55, attack: 60, dodge: 40, morale: 12, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 2 },
    flavorText: 'A fell warrior in black plate, undead flame burning behind its visor.',
    minionPool: [MID_ENEMIES[6]!, EARLY_ENEMIES[2]!] }, // Wights + Skeletons
  // OSE: Hydra HD 5-12, Att 5-12×bite (1d10 each), ML 11
  { name: 'Hydra', hp: 35, hpDie: 15, DEX: 40, attack: 55, dodge: 30, morale: 11, negotiable: false,
    tactics: { kind: 'boss', specialEveryTurns: 1 },
    flavorText: 'Multiple serpentine heads weave and strike from a massive reptilian body.',
    minionPool: [EARLY_ENEMIES[4]!, EARLY_ENEMIES[3]!] }, // Giant Rats + Fire Beetles
]

function pickFromPool<T>(pool: T[], dice: Dice): T {
  return pool[rollDie(dice, pool.length) - 1]!
}

function spawnEnemy(entry: BestiaryEntry, dice: Dice, index: number): Enemy {
  const hp = entry.hp + rollDie(dice, entry.hpDie)
  return {
    name: index === 0 ? entry.name : `${entry.name} ${index + 1}`,
    hp, maxHp: hp,
    DEX: entry.DEX, attack: entry.attack, dodge: entry.dodge,
    morale: entry.morale, negotiable: entry.negotiable,
    flavorText: entry.flavorText,
    tactics: { ...entry.tactics },
  }
}

function buildCombatRoom(input: { tier: 'early' | 'mid'; dice: Dice; theme: DungeonTheme }): Room {
  const { tier, dice, theme } = input

  // Multiple enemies per room — action economy matters!
  // From "The Monsters Know": never pit a solo creature against a party.
  const pool = tier === 'early' ? EARLY_ENEMIES : MID_ENEMIES
  const template = pickFromPool(pool, dice)

  // Vary group size: 2-3 for early, 1-3 for mid (tougher creatures appear in fewer numbers)
  const count = tier === 'early'
    ? 2 + (rollDie(dice, 2) === 2 ? 1 : 0)  // 2-3
    : 1 + (rollDie(dice, 3) >= 2 ? 1 : 0)   // 1-2

  const enemies: Enemy[] = Array.from({ length: count }, (_, i) => spawnEnemy(template, dice, i))

  // Sometimes add a second type for mixed encounters (from Phandelver: varied groups are more interesting)
  if (rollDie(dice, 4) === 1 && pool.length > 1) {
    let other = pickFromPool(pool, dice)
    // Avoid duplicates
    let attempts = 0
    while (other.name === template.name && attempts < 3) { other = pickFromPool(pool, dice); attempts++ }
    if (other.name !== template.name) {
      enemies.push(spawnEnemy(other, dice, 0))
    }
  }

  // Build thematic description
  const names = [...new Set(enemies.map(e => e.name.replace(/ \d+$/, '')))]
  const nameList = names.join(' and ')
  const desc = enemies.length === 1
    ? `A lone ${nameList} blocks the passage.`
    : `${enemies.length} creatures — ${nameList} — lurk ahead.`

  return { type: 'combat', description: withThemeDescription(theme, desc), enemies }
}

function buildBossRoom(dice: Dice, theme: DungeonTheme): Room {
  const bossTemplate = pickFromPool(BOSS_ENEMIES, dice)
  const boss = spawnEnemy(bossTemplate, dice, 0)

  // Boss always has minions — from "The Monsters Know": never run a solo boss
  const minionCount = 1 + (rollDie(dice, 2) === 2 ? 1 : 0) // 1-2 minions
  const minionTemplate = pickFromPool(bossTemplate.minionPool, dice)
  const minions: Enemy[] = Array.from({ length: minionCount }, (_, i) =>
    spawnEnemy(minionTemplate, dice, i)
  )

  const desc = `${boss.name} dominates the chamber${minions.length > 0 ? `, flanked by ${minions.map(m => m.name).join(' and ')}` : ''}.`
  return {
    type: 'boss',
    description: withThemeDescription(theme, desc),
    enemies: [boss, ...minions],
  }
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
  options?: { partyClasses?: RpgClass[]; campaignState?: CampaignState }
): GeneratedDungeon {
  const rooms = safeInt(depth, 12)
  if (rooms < 6) throw new Error('generateDungeon requires depth >= 6')

  const lastIndex = rooms - 1
  const baseTheme = pickDungeonTheme(dice)
  const theme = options?.campaignState ? withCampaignTheme(baseTheme, options.campaignState) : baseTheme
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
  if (typeof value !== 'string') {
    value.inventory = normalizeLootInventory((value as any).inventory)
    value.gold = clampCurrency((value as any).gold)
    return value
  }
  const classes: RpgClass[] = ['Warrior', 'Scout', 'Mage', 'Healer']
  const klass = classes[index % classes.length]!
  const fantasyName = generateFantasyName(klass, Math.floor(index / classes.length))
  return createCharacter({ name: fantasyName, klass, agent: value })
}

export function createGame(input: {
  id: string
  players: Array<string | Character>
  dungeon?: Room[]
  campaignState?: CampaignState
}): RpgGameState {
  const party = input.players.map(toCharacter)
  const turnOrder = computeTurnOrder(party)
  const themeRng = createDice()
  const generated = input.dungeon
    ? null
    : generateDungeon(12, themeRng, {
        partyClasses: uniquePartyClasses(party),
        campaignState: input.campaignState,
      })
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
      ? { enemies: cloneEnemiesForCombat(initialRoom.enemies) }
      : undefined
  const campaignState = input.campaignState
  const campaignContext: CampaignContextSummary | undefined = campaignState
    ? {
        id: campaignState.id,
        name: campaignState.name,
        premise: campaignState.premise,
        activeArcs: campaignArcFocus(campaignState),
        factions: (campaignState.worldState?.factions ?? []).slice(0, 4).map((faction) => faction.name),
        npcs: [],
      }
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
    campaignId: campaignState?.id,
    campaignAdventureNumber: campaignState ? Math.max(1, Math.floor(campaignState.adventureCount) + 1) : undefined,
    campaignContext,
    campaignLog: campaignState
      ? [
          `Campaign: ${campaignState.name}`,
          `Arc focus: ${(campaignContext?.activeArcs ?? []).join(', ') || 'none'}`,
          `Premise: ${campaignState.premise}`,
        ]
      : [],
    log: [],
  }
}

export function findCharacter(game: RpgGameState, name: string): Character | undefined {
  // Match by agent field first (agent→character mapping), then by name (backwards compat)
  return game.party.find((p) => p.agent === name) ?? game.party.find((p) => p.name === name)
}

const ACTION_HISTORY_LIMIT = 25
const STUCK_REPEAT_THRESHOLD = 5
const STUCK_COMBAT_FIRST_HINT_THRESHOLD = 3
const STUCK_COMBAT_SECOND_HINT_THRESHOLD = 5
const STUCK_COMBAT_THRESHOLD = 7
const STUCK_COMBAT_AUTO_RESOLVE_HP_COST = 0.3

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

  const maxRepeatThreshold = Math.max(STUCK_REPEAT_THRESHOLD, STUCK_COMBAT_THRESHOLD)
  let repeatCount = 1
  for (let i = list.length - 2; i >= 0; i -= 1) {
    const prev = list[i]
    if (!prev) break
    if (prev.action !== action) break
    if (prev.target !== target) break
    repeatCount += 1
    if (repeatCount >= maxRepeatThreshold) break
  }

  return { repeatCount, stuck: repeatCount >= STUCK_REPEAT_THRESHOLD }
}

function setRoomModeFromIndex(game: RpgGameState, roomIndex: number): void {
  const room = game.dungeon[roomIndex]
  if (room && (room.type === 'combat' || room.type === 'boss')) {
    game.mode = 'combat'
    game.combat = { enemies: cloneEnemiesForCombat(room.enemies) }
  } else if (game.phase === 'playing') {
    game.mode = 'exploring'
    game.combat = undefined
  }
}

function buildCombatStuckHint(game: RpgGameState, enemies: Enemy[]): string {
  const livingEnemies = (Array.isArray(enemies) ? enemies : []).filter((enemy) => (enemy?.hp ?? 0) > 0)
  if (livingEnemies.length === 0) {
    return 'GM whispers: Press the attack now and end this quickly.'
  }

  const intimidatable = findIntimidatableEnemies(livingEnemies)
  if (intimidatable.length > 0) {
    const target = intimidatable[0]?.name ?? 'the weakest foe'
    return `GM whispers: ${target} is bloodied and wavering. Try intimidate now.`
  }

  if (livingEnemies.every((enemy) => enemyIsNegotiable(enemy))) {
    return 'GM whispers: They might bargain. Try negotiate before this gets worse.'
  }

  const weakestEnemy = [...livingEnemies].sort((a, b) => {
    const hpDiff = (a.hp ?? 0) - (b.hp ?? 0)
    if (hpDiff !== 0) return hpDiff
    return String(a.name ?? '').localeCompare(String(b.name ?? ''))
  })[0]

  const woundedPartyMember = livingParty(game.party).some((member) => member.hp <= Math.ceil(member.maxHp * 0.35))
  if (woundedPartyMember || isBossEncounterRoom(game)) {
    return "GM whispers: You're getting overwhelmed. Try flee, regroup, and re-engage."
  }

  if (weakestEnemy) {
    return `GM whispers: Focus your attacks on ${weakestEnemy.name} to break their line.`
  }

  return 'GM whispers: Break the pattern with attack, negotiate, flee, or intimidate.'
}

export function gmInterveneIfStuck(
  game: RpgGameState,
  input: { player: string; action: string; target: string }
): { intervened: boolean; repeatCount: number } {
  const player = clampActionToken(input.player) || game.currentPlayer || 'unknown'
  const action = clampActionToken(input.action) || 'action'
  const target = clampActionToken(input.target)

  const recorded = recordActionHistory(game, { player, action, target })
  const actor = findCharacter(game, player) ?? findCharacter(game, game.currentPlayer) ?? game.party[0]
  if (game.mode === 'combat' && game.combat?.enemies?.some((e) => (e?.hp ?? 0) > 0)) {
    const repeat = recorded.repeatCount
    if (repeat < STUCK_COMBAT_FIRST_HINT_THRESHOLD) {
      return { intervened: false, repeatCount: repeat }
    }

    if (repeat === STUCK_COMBAT_FIRST_HINT_THRESHOLD) {
      game.log.push({
        at: Date.now(),
        who: 'GM',
        what: `warning: stuck_detected (${player} repeated ${action} ${repeat}x; target=${target || 'none'})`,
      })
      game.log.push({
        at: Date.now(),
        who: 'GM',
        what: 'GM whispers: Try different tactics — attack, negotiate, flee, or intimidate',
      })
      return { intervened: false, repeatCount: repeat }
    }

    if (repeat === STUCK_COMBAT_SECOND_HINT_THRESHOLD) {
      game.log.push({
        at: Date.now(),
        who: 'GM',
        what: `warning: stuck_detected (${player} repeated ${action} ${repeat}x; target=${target || 'none'})`,
      })
      game.log.push({
        at: Date.now(),
        who: 'GM',
        what: buildCombatStuckHint(game, game.combat.enemies),
      })
      return { intervened: false, repeatCount: repeat }
    }

    if (repeat < STUCK_COMBAT_THRESHOLD) {
      return { intervened: false, repeatCount: repeat }
    }

    // Last resort at 7 repeats: force resolution with a significant HP penalty.
    game.log.push({
      at: Date.now(),
      who: 'GM',
      what: `warning: stuck_detected (${player} repeated ${action} ${repeat}x; target=${target || 'none'})`,
    })

    const cost = actor ? Math.max(1, Math.ceil(actor.maxHp * STUCK_COMBAT_AUTO_RESOLVE_HP_COST)) : 0
    if (actor && cost > 0) {
      applyDamage(actor, cost)
      partyWipe(game)
      markPartyDeaths(game, { [characterIdentity(actor)]: `crushed by falling stone in ${game.theme?.name ?? 'the dungeon'}` })
    }
    for (const enemy of game.combat.enemies) {
      enemy.hp = 0
    }
    game.mode = 'exploring'
    game.combat = undefined
    game.log.push({
      at: Date.now(),
      who: 'GM',
      what: 'GM deus ex machina — the ceiling caves in',
    })
  } else if (!recorded.stuck) {
    return { intervened: false, repeatCount: recorded.repeatCount }
  } else {
    game.log.push({
      at: Date.now(),
      who: 'GM',
      what: `warning: stuck_detected (${player} repeated ${action} ${recorded.repeatCount}x; target=${target || 'none'})`,
    })

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
    markPartyDeaths(game, { [characterIdentity(attacker)]: `${attacker.name} fell to a catastrophic fumble in ${game.theme?.name ?? 'the dungeon'}` })
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
    markPartyDeaths(game, { [characterIdentity(defender)]: `slain by ${attacker.name} in ${game.theme?.name ?? 'the dungeon'}` })
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

export function findIntimidatableEnemies(enemies: Enemy[]): Enemy[] {
  // Candidates for the intimidate command: low morale and already bloodied.
  const list = Array.isArray(enemies) ? enemies : []
  return list.filter((enemy) => {
    if ((enemy?.hp ?? 0) <= 0) return false
    const morale = clampMorale(enemy.morale, 9)
    if (morale > 8) return false
    const maxHp = normalizeEnemyMaxHp(enemy)
    return maxHp > 0 && enemy.hp < Math.ceil(maxHp * 0.5)
  })
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

export function livingParty(party: Character[]): Character[] {
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
      const deathCauses: Record<string, string> = {}
      const targets = party.map((p) => p.name)
      for (const member of party) {
        applyDamage(member, perTarget)
        damageByTarget[member.name] = perTarget
        deathCauses[characterIdentity(member)] = `slain by ${enemy.name} in ${game.theme?.name ?? 'the dungeon'}`
      }
      partyWipe(game)
      markPartyDeaths(game, deathCauses)
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
      markPartyDeaths(game, { [characterIdentity(target)]: `slain by ${enemy.name} in ${game.theme?.name ?? 'the dungeon'}` })
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
      markPartyDeaths(game, { [characterIdentity(target)]: `slain by ${enemy.name} in ${game.theme?.name ?? 'the dungeon'}` })
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
    markPartyDeaths(game, { [characterIdentity(target)]: `slain by ${enemy.name} in ${game.theme?.name ?? 'the dungeon'}` })
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
  if (game.mode === 'combat') {
    // Command-level handlers should reject explore during combat; keep engine behavior side-effect free.
    return { ok: true, room: game.dungeon[game.roomIndex] ?? null }
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
    game.combat = { enemies: cloneEnemiesForCombat(room.enemies) }
    // Environmental hazard on combat entry: 50% chance of ambush damage
    // From "The Monsters Know": intelligent monsters set ambushes and use terrain.
    if (rollDie(input.dice, 2) === 1) {
      const victim = livingParty(game.party)[rollDie(input.dice, livingParty(game.party).length) - 1]
      if (victim) {
        const hazardDmg = rollDie(input.dice, 4) + 1 // d4+1 environmental
        applyDamage(victim, hazardDmg)
        game.log.push({ at: Date.now(), who: 'Environment', what: `ambush! ${victim.name} takes ${hazardDmg} damage from a trap/hazard` })
        partyWipe(game)
        markPartyDeaths(game, { [characterIdentity(victim)]: `slain by a dungeon hazard in ${game.theme?.name ?? 'the dungeon'}` })
      }
    }
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
    }

    if (room.type === 'trap') {
      const actor = findCharacter(game, game.currentPlayer)
      if (actor) {
        const check = resolveSkillCheck({ skill: actor.skills.use_skill, dice: input.dice })
        if (check.success) {
          actor.skills.use_skill = check.nextSkill
        } else {
          // Traps should HURT. d6+2 damage, potentially lethal.
          const trapDmg = rollDie(input.dice, 6) + 2
          applyDamage(actor, trapDmg)
          partyWipe(game)
          markPartyDeaths(game, { [characterIdentity(actor)]: `slain by a trap in ${game.theme?.name ?? 'the dungeon'}` })
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
          markPartyDeaths(game, { [characterIdentity(warrior)]: `slain while forcing a barrier in ${game.theme?.name ?? 'the dungeon'}` })
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
  if (pc.dead === true) {
    return createCharacter({ name: pc.name, klass: pc.klass as RpgClass, agent })
  }

  // Use createCharacter to get proper stats for the class, then override with persistent data
  const base = createCharacter({ name: pc.name, klass: pc.klass as RpgClass, agent })
  const inventory = normalizeLootInventory((pc as any).inventory)
  const gold = clampCurrency((pc as any).gold)
  return {
    ...base,
    ...(pc.backstory ? { backstory: pc.backstory } : {}),
    level: Number.isFinite(pc.level) ? Math.max(1, pc.level) : base.level,
    xp: Number.isFinite(pc.xp) ? Math.max(0, pc.xp) : base.xp,
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
    inventory,
    gold,
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
  const isDead = (gc.hp ?? 0) <= 0
  const deathCauseFromCharacter = clampDeathCause(gc.deathCause)
  const deathCauseFallback = adventureSummary
    ? `fell during: ${String(adventureSummary).slice(0, 140)}`
    : `${gc.name} fell in battle`
  const deathCause = isDead ? (deathCauseFromCharacter || deathCauseFallback) : undefined
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
    dead: false,
  }
  const base: PersistentCharacter = existing ? { ...fallback, ...existing } : fallback
  return {
    ...base,
    backstory: (gc.backstory && gc.backstory.trim()) ? gc.backstory : base.backstory,
    skills: { ...gc.skills },
    updatedAt: now,
    gamesPlayed: base.gamesPlayed + 1,
    deaths: isDead ? base.deaths + 1 : base.deaths,
    dead: isDead,
    diedAt: isDead ? now : undefined,
    causeOfDeath: deathCause,
    inventory: isDead ? [] : normalizeLootInventory((gc as any).inventory ?? base.inventory),
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
