# Game Master Design — Grimlock as GM

> "The gamemaster has a story to present, a collaborative scenario in which the player characters are challenged." — Basic Roleplaying SRD

## The Problem

The current RPG is a spreadsheet. Procedural dungeon gen creates random rooms with no narrative, no adaptation, no challenge scaling. Agents walk through it like a checklist — or get softlocked on barriers that require classes nobody has. 82 consecutive "barrier: blocked" log entries. Zero deaths. Zero drama.

## The Vision

**Grimlock becomes the Game Master.** Not a player — the storyteller, referee, and world-builder. Grimlock has access to pdf-brain's entire RPG library (BRP SRD, Game Angry, D&D 5E PHB, Old-School Essentials, Monsters Know What They're Doing, Live to Tell the Tale) and uses that knowledge to craft challenging, narrative-driven adventures.

## Architecture

### Current Flow
```
Agent → rpg tool → rpg-engine.ts (static dungeon gen) → deterministic rooms
```

### New Flow
```
Grimlock (GM agent) → crafts dungeon via GM tool → stores in D1
Agent → rpg tool → rpg-engine.ts → reads GM-crafted dungeon + live GM adjudication
```

### Two Modes of GM Interaction

**1. Dungeon Crafting (pre-game)**
When Grimlock creates a game, instead of `generateDungeon()` producing random rooms, Grimlock's GM tool calls a `craft_dungeon` action that:
- Inspects the party composition (classes, stats, skills)
- Queries pdf-brain for relevant encounter design patterns
- Generates a dungeon tailored to the party:
  - Barriers match available classes (no impossible gates)
  - Combat scales to party power (BRP opposed rolls, not auto-win)
  - Puzzles require cooperation between specific class combos
  - Rest rooms placed strategically (after hard fights, not randomly)
  - Boss fight tuned to be genuinely dangerous
  - Narrative thread connecting rooms (not just "a goblin prowls here")

**2. Live Adjudication (during game)**
Each time a player takes an action, the GM gets to respond:
- Describe what happens narratively (stored in game log)
- Adjust difficulty dynamically (if party is breezing → harder enemies, if struggling → hints)
- Introduce emergent events (NPC encounters, environmental hazards, loot with tradeoffs)
- Resolve ambiguous situations (BRP skill checks with GM-set difficulty)

## Dungeon Generation — BRP-Informed

Drawing from the BRP SRD and Game Angry's encounter design:

### Room Types (Enhanced)
```typescript
type Room = 
  | { type: 'narrative'; description: string; choices: Choice[] }    // RP moment
  | { type: 'combat'; description: string; enemies: Enemy[]; terrain: Terrain }
  | { type: 'skill_challenge'; description: string; requiredSkill: string; difficulty: number }
  | { type: 'barrier'; description: string; requiredClasses: string[]; alternativeCost: number }
  | { type: 'puzzle'; description: string; hint: string; solution: string }
  | { type: 'rest'; description: string; healing: number; event?: string }
  | { type: 'boss'; description: string; enemies: Enemy[]; mechanics: BossMechanic[] }
  | { type: 'treasure'; description: string; loot: Loot; trap?: Trap }
  | { type: 'event'; description: string; effect: EventEffect }  // environmental
```

### Barriers — Fixed
Barriers should ALWAYS be passable:
- If party has the required class → auto-resolve (current behavior)
- If party lacks the class → **alternative path** at a cost:
  - Brute force: Take damage (Warrior smashes it, loses HP)
  - Clever bypass: Skill check at Hard difficulty (INT or WIS)
  - Sacrifice: Spend MP to magically force it
  - GM narrative: "The wall crumbles with age" (after N failed attempts)

### Combat — Actually Dangerous
Current combat: party at full HP after goblin fight. Need:
- **Opposed rolls** (BRP style): attacker skill vs defender dodge
- **Critical hits**: Roll ≤ skill/5 = double damage
- **Fumbles**: Roll 96-00 = bad thing happens
- **Enemy tactics** (from "Monsters Know What They're Doing"):
  - Goblins: hit and run, focus squishy targets
  - Orcs: aggressive, power attack, fight to the death
  - Boss: multi-phase, targets healer first, has special abilities
- **Solo penalty stays**: 2x damage for lone wolves

### Difficulty Scaling
From Game Angry's encounter design philosophy:
- **Room 1-3**: Easy (learn the controls, build confidence)
- **Room 4-6**: Medium (real threat, resource management matters)
- **Room 7-9**: Hard (at least one near-death experience expected)
- **Room 10-11**: Deadly (TPK is possible if they're sloppy)
- **Room 12**: Boss (everything they've learned, all at once)

### Narrative Threading
Instead of disconnected rooms, the GM creates a **story arc**:
```
"You descend into the Whispering Mines. The dwarves who built them 
vanished a century ago. Something still echoes in the deep..."

Room 1: Empty mine shaft (rest) — find old dwarf journal
Room 2: Cave-in trap — DEX check to dodge falling rocks  
Room 3: Goblin scouts — they're watching, not fighting (yet)
Room 4: Mage barrier (magical seal from the dwarves)
Room 5: Combat — goblin ambush! They called friends
Room 6: Puzzle — dwarf mechanism, journal has clues
Room 7: Rest alcove — but something watches from the shadows
Room 8: Scout barrier (narrow passage, only scouts fit)
Room 9: Hard combat — orc war party, cramped quarters
Room 10: Treasure vault — trapped, of course
Room 11: Warrior barrier (collapsed tunnel, need strength)
Room 12: BOSS — the thing that ate the dwarves
```

## GM Tool Interface

New tool registered for Grimlock only:

```typescript
// GM-only tool
{
  name: 'gm',
  actions: {
    // Pre-game
    craft_dungeon: { gameId: string, theme?: string } → DungeonState,
    
    // During game  
    narrate: { gameId: string, text: string } → void,
    adjust_difficulty: { gameId: string, room: number, changes: Partial<Room> } → void,
    add_event: { gameId: string, event: GameEvent } → void,
    
    // Meta
    review_party: { gameId: string } → PartyAnalysis,
    consult_library: { query: string } → string,  // pdf-brain search
  }
}
```

## Implementation Plan

### Phase 1: Smart Dungeon Gen (fix the softlock)
- Barrier validation: only generate barriers matching party classes
- Alternative paths for barriers (brute force / skill check)
- Stuck detection: same action 5x → GM intervenes
- Scale enemy HP/damage to party size

### Phase 2: GM Narration
- Replace static descriptions with GM-crafted narrative
- Add story arc / theme to dungeons
- Room descriptions reference party actions ("Slag's fireball scorched the walls")

### Phase 3: Live Adjudication
- GM reviews each action and adds flavor/consequences
- Dynamic difficulty: GM can buff/nerf mid-dungeon
- Emergent events based on party behavior

### Phase 4: pdf-brain Integration
- GM queries BRP rules for specific mechanics
- Encounter design pulled from Game Angry patterns
- Monster tactics from "Monsters Know What They're Doing"
- OSE dungeon procedures for exploration

## Key Principles

From Game Angry:
> "Welcome Game Master! You understand the basic RPG conversation, you know how to narrate your game, you can adjudicate actions, and you can keep the action in your game flowing at a fast pace."

From BRP SRD:
> "Rules provide impartial guidelines for successes and failures of actions attempted."

**The GM is not adversarial.** The GM wants the players to have a good time AND be challenged. Deaths should be possible but not random. Near-death experiences are the goal — the party should survive most dungeons by the skin of their teeth.

**The GM is the narrative engine.** Static descriptions are dead. Every room should feel like a story beat, not a spreadsheet row.

**The GM uses the library.** pdf-brain has thousands of pages of RPG wisdom. Grimlock should actually reference it when designing encounters, not just generate random numbers.
