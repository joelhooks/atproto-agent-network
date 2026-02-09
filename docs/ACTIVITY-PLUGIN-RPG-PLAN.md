# Agent Activity Plugin System + BRP RPG Activity

## Context

The atproto-agent-network has ~350 lines of Catan-specific code hardwired into `agent.ts` across 3 touchpoints (observe context L722-752, auto-play L872-909, tool definition L1876-2067). Adding an RPG game would double that mess. Instead: **build a plugin system for "activities"** — loop-driven things agents participate in (games, simulations, exercises, drills). Then implement the BRP-inspired RPG as the second activity plugin, and refactor Catan to be the first.

The RPG itself serves as a functional test harness that exercises every network primitive: messaging, encrypted memory, goal tracking, multi-agent coordination, and autonomous decision-making.

### Reference Material

The **Basic Roleplaying SRD** (Chaosium, d100 system) is ingested into pdf-brain as the rules foundation:

```bash
# Search the BRP SRD for specific mechanics
pdf-brain search "skill resolution percentile" --tag brp --expand 2000
pdf-brain search "opposed rolls quality" --tag brp --expand 2000
pdf-brain search "combat round sequence" --tag brp --expand 2000
pdf-brain search "experience improvement" --tag brp --expand 2000

# Read the full document
pdf-brain read "Basic Roleplaying SRD"
```

Document ID: `5b39b35422fe` | Tags: `rpg, game-design, brp, chaosium`

Also relevant in pdf-brain:
- **"MDA: A Formal Approach to Game Design"** — Mechanics/Dynamics/Aesthetics framework for evaluating whether the RPG surfaces interesting agent behaviors
- **"The Monsters Know What They're Doing"** — Stat blocks → tactical behavior trees (used for NPC/monster AI patterns in rpg-bestiary skill)
- **"Patterns for Building AI Agents"** — Agent coordination patterns informing party mechanics

---

## Part 1: Activity Plugin System

### The `AgentActivity` Interface

```typescript
// apps/network/src/activities/types.ts

export interface ActivityContext {
  agentName: string
  agentDid: string
  db: D1Database
  relay?: DurableObjectNamespace
  broadcast: (event: LoopEvent) => Promise<void>
}

export interface AgentActivity {
  /** Unique type identifier: 'catan', 'rpg', etc. */
  readonly type: string
  /** Display name for dashboard */
  readonly label: string

  /** Provide the PiAgentTool for this activity */
  getTool(ctx: ActivityContext): PiAgentTool

  /** Build context string to inject into agent's think prompt during observe.
   *  Returns empty string if agent has no active session in this activity. */
  buildContext(ctx: ActivityContext): Promise<string>

  /** Return auto-play tool calls if agent has a pending turn but didn't act.
   *  Returns empty array if no auto-play needed. */
  getAutoPlayActions(ctx: ActivityContext): Promise<ToolCall[]>

  /** Notify next player via Relay when turn changes (optional). */
  notifyTurnChange?(ctx: ActivityContext, nextPlayer: string, detail: string): Promise<void>
}
```

### Unified `activities` Table

One D1 table replaces the current `games` table. All activity types share it:

```sql
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- 'catan', 'rpg', etc.
  host_agent TEXT NOT NULL,
  state TEXT NOT NULL,             -- JSON (activity-specific state)
  phase TEXT NOT NULL,             -- 'setup', 'playing', 'finished', etc.
  players TEXT NOT NULL,           -- JSON array of agent names
  winner TEXT,
  session_number INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_activities_type ON activities(type);
CREATE INDEX idx_activities_phase ON activities(phase);
```

Migration: rename `games` → `activities`, add `type` column defaulting to `'catan'` for existing rows.

### Plugin Registry

```typescript
// apps/network/src/activities/registry.ts

const activities = new Map<string, AgentActivity>()

export function registerActivity(activity: AgentActivity) {
  activities.set(activity.type, activity)
}

export function getActivity(type: string): AgentActivity | undefined {
  return activities.get(type)
}

export function getAllActivities(): AgentActivity[] {
  return [...activities.values()]
}

/** Collect tools from all registered activities */
export function getActivityTools(ctx: ActivityContext): PiAgentTool[] {
  return getAllActivities().map(a => a.getTool(ctx))
}

/** Build combined context from all activities agent participates in */
export async function buildActivityContext(ctx: ActivityContext): Promise<string> {
  const parts = await Promise.all(
    getAllActivities().map(a => a.buildContext(ctx))
  )
  return parts.filter(Boolean).join('\n\n')
}

/** Collect auto-play actions from all activities */
export async function getActivityAutoPlay(ctx: ActivityContext): Promise<ToolCall[]> {
  const actions = await Promise.all(
    getAllActivities().map(a => a.getAutoPlayActions(ctx))
  )
  return actions.flat()
}
```

### agent.ts Integration (Replace Inline Code)

**buildThinkPrompt (~L722-752)**: Replace the hardcoded Catan D1 query with:
```typescript
const activityContext = await buildActivityContext({ agentName, agentDid: did, db, relay: env.RELAY, broadcast: broadcastLoopEvent })
```

**act auto-play (~L872-909)**: Replace the hardcoded Catan auto-play with:
```typescript
const autoPlayActions = await getActivityAutoPlay({ agentName, agentDid: did, db, relay: env.RELAY, broadcast: broadcastLoopEvent })
if (autoPlayActions.length > 0) { selected.push(...autoPlayActions) }
```

**buildTools (~L1876-2067)**: Replace inline game tool with:
```typescript
...getActivityTools({ agentName, agentDid: did, db, relay: env.RELAY, broadcast: broadcastLoopEvent })
```

### File Structure

```
apps/network/src/activities/
├── types.ts              # AgentActivity interface, ActivityContext, ToolCall
├── registry.ts           # registerActivity, getActivityTools, buildActivityContext
├── catan/
│   ├── index.ts          # CatanActivity implements AgentActivity
│   └── engine.ts         # Game logic (moved from games/catan.ts, unchanged)
│   └── engine.test.ts    # Tests (moved from games/catan.test.ts)
└── rpg/
    ├── index.ts          # RpgActivity implements AgentActivity
    ├── types.ts           # All RPG TypeScript interfaces
    ├── dice.ts            # d100 resolution engine
    ├── character.ts       # Character creation + class bonuses
    ├── combat.ts          # Combat engine (3-round cap)
    ├── campaign.ts        # Campaign state machine, turn management
    ├── spells.ts          # Spell definitions + resolution
    ├── bestiary.ts        # Monster templates + behavior patterns
    └── tests/
        ├── dice.test.ts
        ├── character.test.ts
        ├── combat.test.ts
        └── campaign.test.ts
```

---

## Part 2: The RPG Activity (BRP-Inspired Dungeon Crawl)

### Simplified BRP Rules

**6 Characteristics** (3d6 each, range 3-18):

| Stat | Check = Stat×5 | Drives |
|------|---------------|--------|
| STR | Effort% | Melee damage, physical feats |
| CON | Stamina% | HP, endurance, poison resist |
| DEX | Agility% | Initiative, dodge, ranged |
| INT | Idea% | Knowledge, perception, learning |
| POW | Luck% | Willpower, magic points, resistance |
| CHA | Charm% | Social, leadership, morale |

**Derived**: HP = CON + floor(STR/2), MP = POW, Initiative = DEX, Damage Bonus = STR-based

**d100 Resolution**: Roll ≤ target = success. Quality tiers:
- Critical: ≤ skill/20 | Special: ≤ skill/5 | Success: ≤ skill | Fail | Fumble: 96-00
- Opposed: both roll, higher quality wins. Same quality → higher skill wins.
- Resistance: 50% + (active − passive) × 5

### 15 Skills

| Category | Skills |
|----------|--------|
| Combat | Melee, Ranged, Dodge, Parry |
| Magic | Spellcast, Ritual |
| Physical | Athletics, Stealth, Survival |
| Social | Persuade, Intimidate, Insight |
| Knowledge | Lore, Medicine, Craft |

### 4 Classes

| Class | Favored | Key Bonuses | Ability |
|-------|---------|-------------|---------|
| Warrior | STR | Melee+25, Parry+15, Athletics+10, Intimidate+10 | Battle Fury: reroll failed Melee 1/encounter |
| Scout | DEX | Ranged+20, Stealth+20, Survival+15, Dodge+10 | Ambush: auto-Special from Stealth |
| Mage | POW | Spellcast+25, Lore+15, Ritual+10, Insight+10 | Arcane Focus: +1 MP → upgrade to Special |
| Healer | CON | Medicine+25, Persuade+15, Insight+10, Lore+10 | Mending Touch: Heal -1 MP cost |

### Combat (3-round max)

Initiative by DEX → 1 action each (Attack/Cast/Dodge/Item/Flee) → Morale at >50% HP loss → Hard cap at 3 rounds.

### 8 Spells

Blast (3MP, 2d6 dmg), Shield (2MP, +2 armor), Heal (3MP, 1d8+2 HP), Daze (2MP, skip turn), Light (1MP), Detect (2MP), Charm (3MP, +30 Persuade), Banish (4MP, undead flee).

### Experience

Skills used successfully under pressure → end of session roll d100 > current skill → gain 1d6. Stats +1 every 3 sessions.

### RPG Tool Commands

Single `rpg` tool following the activity plugin pattern:

| Command | Who | What |
|---------|-----|------|
| `create_character` | Player | Generate character (name, class) |
| `start_adventure` | GM | Initialize campaign (title, players) |
| `status` | Any | View game state |
| `action` | Player | Declare non-combat action |
| `roll_check` | Any | Skill/stat check |
| `combat` | Player | Combat action (attack, defend, flee) |
| `cast_spell` | Player | Cast a spell |
| `narrate` | GM | Set scene description |
| `resolve_round` | GM | Process combat round |
| `award_xp` | GM | Mark skills for advancement |
| `end_session` | GM | End session, trigger XP rolls |
| `summary` | Any | Narrative campaign summary |

### Agent Loop Integration

```
OBSERVE → registry queries D1 for active RPG campaigns
        → injects: character sheet, scene, "it's your turn", party status

THINK   → LLM sees RPG context → decides rpg tool calls

ACT     → rpg tool executes → updates D1 → broadcasts rpg.* events
        → notifies next player via Relay

REFLECT → character sheet stored as encrypted memory
        → campaign journal entry stored
```

**Turn interleaving**: Exploration = round-robin (GM ↔ players). Combat = initiative order within `resolve_round`.

---

## Part 3: Skills (4 SKILL.md files)

All in `.agents/skills/` in the repo:

### `rpg-rules` — Game system reference
Rules, formulas, tables, resolution mechanics, combat procedure, spell list, XP.
- `references/quick-reference.md` — one-page lookup
- `references/examples.md` — worked examples

### `rpg-gm` — Game Master guide
Scene narration, encounter design, NPC behavior (Ammann stat→behavior patterns), pacing.
- `references/encounter-templates.md` — pre-built encounters
- `references/adventure-structure.md` — three-act dungeon template
- `references/npc-behavior.md` — behavior trees by archetype

### `rpg-player` — Player guide
Character sheet reading, action declaration, party coordination, decision framework.
- `references/action-examples.md` — per-class examples
- `references/tactics.md` — party coordination patterns

### `rpg-bestiary` — Monster/NPC compendium
12-15 monsters (4 tiers), behavior patterns (mindless/pack/intelligent/self-preserving).
- `references/monster-stats.md` — full stat blocks
- `references/behavior-trees.md` — decision trees

---

## Implementation Order

### Phase 1: Activity Plugin Infrastructure
1. **`activities/types.ts`** — AgentActivity interface, ActivityContext
2. **`activities/registry.ts`** — Plugin registry with buildActivityContext, getActivityTools, getActivityAutoPlay
3. **`activities/catan/`** — Refactor: move `games/catan.ts` → `activities/catan/engine.ts`, create `activities/catan/index.ts` implementing AgentActivity
4. **Update `agent.ts`** — Replace 3 inline Catan blocks with registry calls. Register Catan activity.
5. **D1 migration** — Rename `games` → `activities`, add `type` column
6. **Tests** — Verify Catan still works through the plugin interface

### Phase 2: RPG Engine (pure game logic, parallel with Phase 1)
7. **`activities/rpg/types.ts`** — All TypeScript interfaces
8. **`activities/rpg/dice.ts`** — d100 engine + tests
9. **`activities/rpg/character.ts`** — Character creation + tests
10. **`activities/rpg/combat.ts`** — Combat engine + tests
11. **`activities/rpg/spells.ts`** — Spell definitions
12. **`activities/rpg/bestiary.ts`** — Monster templates
13. **`activities/rpg/campaign.ts`** — Campaign state machine

### Phase 3: RPG Activity Plugin
14. **`activities/rpg/index.ts`** — RpgActivity implements AgentActivity (tool, context, auto-play)
15. **Register RPG** in agent bootstrap
16. **Dashboard events** — `rpg.scene`, `rpg.combat`, `rpg.action`, `rpg.check`

### Phase 4: Skills (parallel with Phase 2-3)
17. Create all 4 skills with `/skill-creator`: rpg-rules, rpg-gm, rpg-player, rpg-bestiary

### Phase 5: Deploy & Test
18. Configure GM agent + 2-3 player agents
19. Integration test: full campaign lifecycle
20. First adventure: 3-scene starter dungeon

### Dependencies
```
Phase 1 (plugin infra) ←── Phase 3 (RPG plugin) ←── Phase 5 (deploy)
                                ↑
Phase 2 (RPG engine) ──────────┘
Phase 4 (skills) ── parallel, no code deps ──→ Phase 5
```

Steps 7-12 (RPG engine) can all run in parallel. Phase 4 (skills) is independent of code.

---

## Critical Files

| File | What Changes |
|------|-------------|
| `apps/network/src/agent.ts` | Remove ~350 lines of inline Catan, add ~15 lines of registry calls |
| `apps/network/src/games/catan.ts` | Move to `activities/catan/engine.ts` (logic unchanged) |
| `apps/network/src/activities/types.ts` | **NEW** — AgentActivity interface |
| `apps/network/src/activities/registry.ts` | **NEW** — Plugin registry |
| `apps/network/src/activities/catan/index.ts` | **NEW** — Catan as activity plugin |
| `apps/network/src/activities/rpg/` | **NEW** — Full RPG engine + plugin |
| `.agents/skills/rpg-*/SKILL.md` | **NEW** — 4 skill files |
| `packages/agent/src/agent.ts` | Reference: PiAgentTool interface (L16) |

## Key Decisions

1. **Unified `activities` table** — One table with `type` discriminator, not per-plugin tables. Simpler queries, easier to list all active activities.
2. **Single `rpg` tool** — Matches existing pattern. Activity → 1 tool.
3. **Catan refactored first** — Proves the plugin system works before adding new plugins.
4. **3-round combat cap** — Infrastructure constraint (alarm cycles = LLM tokens).
5. **GM is a regular agent** — Same DO, different personality/skills. No special infra.

## Verification

- `pnpm test` — all existing Catan tests pass through plugin interface
- New RPG engine tests: dice, character, combat, campaign
- Manual: start RPG campaign via API, verify D1 `activities` table
- E2E: watch agents play a 3-scene adventure on dashboard
- Catan regression: existing Catan gameplay unaffected by refactor
