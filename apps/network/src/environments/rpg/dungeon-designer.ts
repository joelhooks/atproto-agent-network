/**
 * LLM-Powered Dungeon Designer
 * 
 * Grimlock designs dungeons with wacky themes, tactical encounters,
 * and personality. Uses OpenRouter via AI Gateway for inference.
 */

import type { Character, DifficultyTier, DungeonTheme, Enemy, Room, RpgClass } from '../../games/rpg-engine'

// ============================================================================
// WACKY THEME POOL — Grimlock's imagination runs wild
// ============================================================================

const WACKY_THEMES: DungeonTheme[] = [
  { name: 'The Bureaucracy of Hell', backstory: 'A demonic DMV where lost souls wait in eternal queues. The forms are cursed. The pens never work.' },
  { name: "Chef's Kiss of Death", backstory: "A sentient restaurant that's been cooking adventurers for centuries. The specials are YOU." },
  { name: 'The Library That Reads You', backstory: 'Books fly from shelves and critique your life choices. The librarian is an eldritch horror who just wants quiet.' },
  { name: 'Gnome Home Depot', backstory: 'An abandoned gnomish hardware store. Every aisle is booby-trapped. The power tools are possessed.' },
  { name: "The Tooth Fairy's Vault", backstory: 'Where all stolen teeth end up. The fairy is actually a 12-foot bone golem who REALLY wants your teeth.' },
  { name: 'Tax Season in the Underdark', backstory: 'A drow auditing firm. They will find discrepancies in your adventuring income. Penalties are lethal.' },
  { name: 'The Gym of Eternal Gains', backstory: 'An enchanted fitness dungeon where the equipment fights back. Never skip leg day... or die.' },
  { name: "Grandma's Cursed Kitchen", backstory: "A sweet old hag's cottage. Her cookies are divine. Her basement is where the screaming comes from." },
  { name: 'The Post Office of No Return', backstory: 'Undelivered letters have manifested into angry ghosts. The sorting hat is actually a mimic.' },
  { name: 'Divorce Court of the Lich King', backstory: "A lich and his ex-phylactery are splitting assets. You're the mediators. Both sides have lawyers (demons)." },
  { name: 'The Daycare of Doom', backstory: 'Wizard children with no impulse control and maximum spell slots. Nap time is enforced by a golem.' },
  { name: 'The Infinite IKEA', backstory: 'A pocket dimension of flat-pack furniture and meatball golems. Assembly instructions are in Abyssal.' },
  { name: 'Bard College Finals', backstory: 'A music academy where failed compositions become sonic nightmares. The dean is a banshee with tenure.' },
  { name: 'The Cheese Caves of Curdleton', backstory: 'Sentient cheese civilizations at war. Brie rebels fight the Cheddar Empire. You smell like crackers to them.' },
  { name: 'The Haunted Theme Park', backstory: 'An abandoned amusement park where the rides are sentient and hungry. The mascot costume walks on its own.' },
  { name: "Wizard's HOA Meeting", backstory: "The most dangerous dungeon: a homeowner's association run by petty archmages. Fines are fireballs." },
  { name: 'The Upside-Down Tavern', backstory: 'A bar where gravity reversed. The ale flows upward. The bartender is a gelatinous cube who makes great cocktails.' },
  { name: 'Pet Cemetery Pet Store', backstory: 'Every pet here has died at least twice. The hamsters are liches. The goldfish cast Tsunami.' },
  { name: 'The Retirement Home of Fallen Heroes', backstory: 'Ancient adventurers who refuse to stay retired. They mistake you for their old nemeses.' },
  { name: "The Dragon's Tax Return", backstory: 'A dragon hired an accountant. The accountant is missing. The receipts are enchanted. The IRS sent you.' },
]

/**
 * Pick a random theme, avoiding recently used ones
 */
export function pickTheme(usedThemes?: string[]): DungeonTheme {
  const used = new Set(usedThemes ?? [])
  const available = WACKY_THEMES.filter(t => !used.has(t.name))
  const pool = available.length > 0 ? available : WACKY_THEMES
  return pool[Math.floor(Math.random() * pool.length)]
}

// ============================================================================
// ENEMY GENERATION
// ============================================================================

// Map LLM-provided tactics hint to a real EnemyTacticKind
const TACTIC_MAP: Record<string, string> = {
  'focus-healer': 'goblin', 'assassin': 'ambush', 'flanker': 'pack',
  'sniper': 'ranged', 'caster': 'spellcaster', 'brute': 'berserker',
  'coward': 'retreater', 'horde': 'swarm', 'tank': 'guardian',
  'hit-and-run': 'ambush', 'mindless': 'skeleton',
}

function resolveTacticKind(tier: DifficultyTier, hint?: string): string {
  if (hint) {
    const lower = hint.toLowerCase().trim()
    if (TACTIC_MAP[lower]) return TACTIC_MAP[lower]
    // Direct match against valid kinds
    const validKinds = ['goblin','orc','skeleton','boss','pack','ambush','ranged','spellcaster','berserker','retreater','swarm','guardian']
    if (validKinds.includes(lower)) return lower
  }
  // Default per tier — smarter defaults than before
  switch (tier) {
    case 'boss': return 'boss'
    case 'deadly': return 'berserker'
    case 'hard': return 'ambush'
    case 'medium': return 'pack'
    case 'easy': return 'goblin'
    default: return 'unknown'
  }
}

function makeEnemy(name: string, tier: DifficultyTier, partySize: number, flavorText?: string, tacticsHint?: string): Enemy {
  const scale = { easy: 0.7, medium: 1.0, hard: 1.4, deadly: 1.8, boss: 2.5 }[tier] ?? 1.0
  const sizeScale = partySize >= 4 ? 1.2 : partySize <= 2 ? 0.8 : 1.0
  const baseHp = tier === 'boss' ? 45 : tier === 'deadly' ? 30 : tier === 'hard' ? 22 : tier === 'medium' ? 16 : 10
  const baseAtk = tier === 'boss' ? 55 : tier === 'deadly' ? 48 : tier === 'hard' ? 42 : tier === 'medium' ? 36 : 28
  const baseDex = tier === 'boss' ? 40 : tier === 'deadly' ? 50 : tier === 'hard' ? 45 : tier === 'medium' ? 40 : 35
  const baseDodge = tier === 'boss' ? 30 : tier === 'deadly' ? 35 : tier === 'hard' ? 30 : tier === 'medium' ? 25 : 20
  return {
    name,
    hp: Math.round(baseHp * scale * sizeScale),
    maxHp: Math.round(baseHp * scale * sizeScale),
    attack: Math.round(baseAtk * scale),
    DEX: Math.round(baseDex * scale),
    dodge: Math.round(baseDodge * scale),
    armor: tier === 'boss' ? 3 : tier === 'deadly' ? 2 : tier === 'hard' ? 1 : 0,
    flavorText,
    tactics: { kind: resolveTacticKind(tier, tacticsHint) as any },
  }
}

// ============================================================================
// LLM DUNGEON DESIGN
// ============================================================================

/**
 * Build the LLM prompt for dungeon design
 */
export function buildDungeonDesignPrompt(input: {
  theme: DungeonTheme
  party: Character[]
  compact: boolean
  tacticalResearch?: string
}): string {
  const partyDesc = input.party
    .map(c => `${c.name} (${c.klass})`)
    .join(', ')
  
  const roomCount = input.compact ? 4 : 12

  const tacticalSection = input.tacticalResearch
    ? `\n\nTACTICAL RESEARCH FROM YOUR LIBRARY (use this to inform enemy behavior):\n${input.tacticalResearch}\n`
    : ''

  return `You are Grimlock, a chaotic but brilliant Dungeon Master designing a dungeon crawl.

THEME: "${input.theme.name}"
BACKSTORY: ${input.theme.backstory}

PARTY (${input.party.length} players): ${partyDesc}
${tacticalSection}
Design exactly ${roomCount} rooms. The theme should permeate EVERYTHING.

Rules:
- Room 1: ALWAYS rest/entry (safe, sets the tone with vivid themed description)
- Last room: ALWAYS boss fight (memorable villain with personality)
- Mix: combat, trap, puzzle, treasure, rest rooms
- Enemies: THEMED to the dungeon concept (NOT generic fantasy monsters)
- Descriptions: vivid, funny, 1-2 sentences max
- Each combat room needs: enemy names, difficulty (easy/medium/hard/deadly for regular, boss for final), AND tactics
- TACTICS are crucial — each enemy needs a "tactics" field describing HOW they fight:
  - "pack" = focus-fire the healer/mage, gang up on one target
  - "ambush" = hit-and-run, target squishiest party member
  - "ranged" / "spellcaster" = stay back, target lowest dodge
  - "berserker" = attack the strongest/most dangerous fighter
  - "guardian" = protect something, attack highest level target
  - "boss" = smart targeting, finish off wounded targets, prioritize healers
  - "swarm" / "skeleton" = mindless, attack randomly
  - Or invent one! (e.g. "focus-healer", "assassin", "flanker", "brute")
- Enemies should use DIFFERENT tactics in the same encounter for variety

Respond in EXACT JSON (no markdown, no commentary):
{
  "rooms": [
    {"type": "rest", "description": "..."},
    {"type": "combat", "description": "...", "difficulty": "easy", "enemies": [{"name": "...", "tactics": "pack", "special": "..."}]},
    {"type": "trap", "description": "..."},
    {"type": "boss", "description": "...", "enemies": [{"name": "...", "tactics": "boss", "special": "..."}], "bossPersonality": "..."}
  ],
  "designNotes": ["one-liner about the dungeon's vibe"]
}`
}

/**
 * Parse LLM response into proper Room objects.
 * Falls back to static dungeon if parsing fails.
 */
export function parseDungeonDesign(
  raw: string,
  theme: DungeonTheme,
  party: Character[],
  compact: boolean
): { rooms: Room[]; difficultyCurve: DifficultyTier[]; designNotes: string[] } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return fallbackDungeon(theme, party, compact)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed.rooms) || parsed.rooms.length < 2) {
      return fallbackDungeon(theme, party, compact)
    }

    const partySize = party.length
    const rooms: Room[] = parsed.rooms.map((r: any) => {
      const desc = `${theme.name}: ${r.description || 'A mysterious room.'}`
      
      switch (r.type) {
        case 'combat': {
          const tier: DifficultyTier = r.difficulty || 'medium'
          const enemies = (r.enemies || [{ name: 'Themed Guardian' }]).map((e: any) =>
            makeEnemy(e.name || 'Themed Guardian', tier, partySize, e.special || e.flavorText, e.tactics)
          )
          return { type: 'combat' as const, description: desc, enemies, difficultyTier: tier }
        }
        case 'boss': {
          const enemies = (r.enemies || [{ name: 'The Boss' }]).map((e: any) =>
            makeEnemy(e.name || 'The Boss', 'boss', partySize, e.special || r.bossPersonality || e.flavorText, e.tactics || 'boss')
          )
          return { type: 'boss' as const, description: desc, enemies, difficultyTier: 'boss' as DifficultyTier }
        }
        case 'trap':
          return { type: 'trap' as const, description: desc }
        case 'treasure':
          return { type: 'treasure' as const, description: desc }
        case 'puzzle':
          return { type: 'puzzle' as const, description: desc }
        case 'rest':
        default:
          return { type: 'rest' as const, description: desc }
      }
    })

    const curve: DifficultyTier[] = rooms
      .filter((r): r is Room & { difficultyTier: DifficultyTier } => 'difficultyTier' in r && !!(r as any).difficultyTier)
      .map(r => r.difficultyTier)

    return {
      rooms,
      difficultyCurve: curve,
      designNotes: parsed.designNotes || [`Grimlock-designed: ${theme.name}`],
    }
  } catch {
    return fallbackDungeon(theme, party, compact)
  }
}

/**
 * Static fallback dungeon (when LLM unavailable)
 */
function fallbackDungeon(
  theme: DungeonTheme,
  party: Character[],
  compact: boolean
): { rooms: Room[]; difficultyCurve: DifficultyTier[]; designNotes: string[] } {
  const ps = party.length

  if (compact) {
    return {
      rooms: [
        { type: 'rest', description: `${theme.name}: You stand at the threshold. Something feels very wrong.` },
        { type: 'combat', description: `${theme.name}: Guardians block your path.`, enemies: [makeEnemy('Theme Guardian', 'easy', ps)], difficultyTier: 'easy' },
        { type: 'trap', description: `${theme.name}: A themed hazard awaits the unwary.` },
        { type: 'boss', description: `${theme.name}: The master of this domain rises to face you.`, enemies: [makeEnemy('The Boss', 'boss', ps, 'Devastating themed attack')], difficultyTier: 'boss' },
      ],
      difficultyCurve: ['easy', 'boss'],
      designNotes: ['Fallback static dungeon — LLM unavailable'],
    }
  }

  return {
    rooms: [
      { type: 'rest', description: `${theme.name}: The entrance beckons.` },
      { type: 'combat', description: `${theme.name}: First contact.`, enemies: [makeEnemy('Theme Scout', 'easy', ps)], difficultyTier: 'easy' },
      { type: 'trap', description: `${theme.name}: Watch your step.` },
      { type: 'combat', description: `${theme.name}: They expected you.`, enemies: [makeEnemy('Theme Soldier', 'medium', ps)], difficultyTier: 'medium' },
      { type: 'treasure', description: `${theme.name}: Something glitters.` },
      { type: 'combat', description: `${theme.name}: Defenses tighten.`, enemies: [makeEnemy('Theme Elite', 'hard', ps)], difficultyTier: 'hard' },
      { type: 'rest', description: `${theme.name}: A moment of peace.` },
      { type: 'combat', description: `${theme.name}: Everything at you.`, enemies: [makeEnemy('Theme Champion', 'deadly', ps)], difficultyTier: 'deadly' },
      { type: 'rest', description: `${theme.name}: Calm before the storm.` },
      { type: 'puzzle', description: `${theme.name}: A themed puzzle.` },
      { type: 'trap', description: `${theme.name}: One last trick.` },
      { type: 'boss', description: `${theme.name}: The master awaits.`, enemies: [makeEnemy('The Boss', 'boss', ps, 'Devastating themed attack')], difficultyTier: 'boss' },
    ],
    difficultyCurve: ['easy', 'medium', 'hard', 'deadly', 'boss'],
    designNotes: ['Fallback static dungeon — LLM unavailable'],
  }
}
