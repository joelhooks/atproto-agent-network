---
status: "proposed"
date: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Clawd (architecture review)"
informed: "All agents working in the RPG codebase"
---

# Refactor RPG monolith into interface-driven modules with reactive event architecture

## Context and Problem Statement

The RPG environment is implemented as a single 4207-line file (`apps/network/src/environments/rpg.ts`) containing 7 distinct domain concerns: campaign persistence, campaign logic, game mechanics, hub town system, command handling (~1800-line switch), context building, and auto-play logic. How should we decompose this monolith into testable, extensible modules while preserving all 412 existing tests and 112 passing Ralph stories, and preparing for reactive DO-to-DO wake signals?

### Trigger

- Adding new commands requires modifying the giant switch statement, risking regressions in unrelated commands
- Every command duplicates the "load game → mutate → save" pattern (~25 duplicate SQL calls)
- `buildContext()` knows about every game phase, class skill, persistent character, and campaign — impossible to test in isolation
- The polling-based agent loop wastes resources; we need DO-to-DO wake signals for reactive play
- Joel wants interface-first design (contracts before implementations), not just file splitting

### Constraints

- **Cloudflare Durable Objects runtime**: single-threaded, one alarm at a time per DO
- **CF Workers D1** for persistence — all SQL must go through D1 bindings
- **112 Ralph stories** all passing — must not break them
- **412 tests** in the test suite — all must continue passing throughout migration
- **Live system**: RPG is actively running with agents (slag, snarl, swoop)
- **`rpg-engine.ts` (2925 lines)** has pure functions with no I/O — leave it untouched

## Decision Drivers

* Testability — each module must be independently testable with in-memory implementations
* Zero-regression migration — every phase must leave all tests passing
* Interface-first — contracts defined before implementations, enabling parallel work
* Reactive readiness — module boundaries must support event-driven wake signals
* Incremental delivery — each phase is independently deployable

## Considered Options

* **Option A: Interface-driven modular extraction** — Define contracts in `interfaces.ts`, extract repositories/systems/commands behind those contracts, wire up thin orchestrator
* **Option B: File splitting by concern** — Move code blocks into separate files preserving current coupling, fix later
* **Option C: Full rewrite** — Start fresh with new architecture, port tests

## Decision Outcome

Chosen option: **"Interface-driven modular extraction"**, because it enables parallel extraction of independent modules, provides in-memory test implementations from day one, and creates the extension points (especially `GameEventEmitter`) needed for reactive architecture — all without requiring a risky big-bang rewrite.

### Consequences

* Good, because each command becomes independently testable without D1
* Good, because the `GameEventEmitter` interface is the natural extension point for DO-to-DO wake signals
* Good, because the command registry pattern means new commands don't touch existing code
* Good, because in-memory repository implementations enable fast unit tests
* Bad, because the migration involves 7 phases of careful extraction — this is weeks of work
* Bad, because the orchestrator save-after-command pattern changes the current save semantics (commands currently save inline)
* Neutral, because `rpg-engine.ts` stays untouched — it's already well-abstracted

### Follow-up Tasks

* After Phase 6: Implement reactive DO-to-DO wake signals using the `GameEventEmitter` interface
* After Phase 6: Add `ExplorationMode` (freeform, no turn gating) vs `CombatMode` (initiative turns)
* Ongoing: Add `ADR-0002` references in code comments at key implementation points

## Implementation Plan

### Interfaces (`apps/network/src/environments/rpg/interfaces.ts`)

All modules code against these contracts. Full definitions:

```typescript
// --- Storage Layer ---
export interface GameStateRepository {
  findActiveForAgent(agentName: string): Promise<GameStateRow | null>
  findWhereItsMyTurn(agentName: string): Promise<GameStateRow | null>
  findJoinable(exclude: string, limit?: number): Promise<GameStateRow[]>
  load(gameId: string): Promise<RpgGameState>
  save(gameId: string, game: RpgGameState): Promise<void>
  create(gameId: string, game: RpgGameState, meta: GameCreateMeta): Promise<void>
  anyActiveExist(): Promise<boolean>
  countFinishedToday(): Promise<number>
}

export interface CampaignRepository {
  get(id: string): Promise<CampaignState | null>
  create(name: string, premise: string, options?: CreateCampaignOptions): Promise<CampaignState>
  update(id: string, patch: CampaignPatch): Promise<void>
  linkAdventure(envId: string, campaignId: string): Promise<number>
  findLatest(): Promise<{ id: string } | null>
}

export interface CharacterRepository {
  load(): Promise<PersistentCharacter | null>
  save(character: PersistentCharacter): Promise<void>
}

// --- Command Pattern ---
export interface CommandHandler {
  readonly name: string
  readonly validPhases: GamePhase[]
  readonly requiresTurn: boolean
  execute(input: CommandInput): Promise<CommandResult>
}

export interface CommandInput {
  game: RpgGameState
  gameId: string
  params: Record<string, unknown>
  agentName: string
  dice: Dice
  repos: {
    game: GameStateRepository
    campaign: CampaignRepository
    character: CharacterRepository
  }
  broadcast: (event: Record<string, unknown>) => Promise<void>
}

export interface CommandResult {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
  saved?: boolean
}

// --- Game Systems ---
export interface TurnManager {
  advance(game: RpgGameState): void
  normalize(game: RpgGameState): boolean
  computeInitiative(party: Character[]): Character[]
}

export interface CombatResolver {
  resolveAttack(attacker: Character, target: Enemy, dice: Dice): AttackResult
  resolveEnemyRound(game: RpgGameState, dice: Dice): string[]
  resolveFlee(game: RpgGameState, actor: Character, dice: Dice): FleeResult
  resolveNegotiate(game: RpgGameState, actor: Character, dice: Dice): NegotiateResult
}

export interface LootSystem {
  resolveTreasure(game: RpgGameState, actor: Character, dice: Dice): string
  maybeAwardDrop(game: RpgGameState, actor: Character, enemy: Enemy, dice: Dice): string | null
}

export interface XpSystem {
  awardKill(game: RpgGameState, who: string, enemy: Enemy): void
  awardRoomClear(game: RpgGameState): void
  addLogged(game: RpgGameState, who: string, amount: number, reason: string): void
}

// --- Context & Events ---
export interface ContextBuilder {
  build(ctx: EnvironmentContext, game: RpgGameState, gameId: string): Promise<string[]>
}

export interface AutoPlayStrategy {
  getActions(ctx: EnvironmentContext): Promise<ToolCall[]>
}

export interface GameEventEmitter {
  onEnvironmentCompleted(ctx: EnvironmentContext, gameId: string, game: RpgGameState): Promise<void>
  onTurnAdvanced(gameId: string, nextPlayer: string): Promise<void>
  onCombatStarted(gameId: string): Promise<void>
  onPhaseChanged(gameId: string, from: GamePhase, to: GamePhase): Promise<void>
}
```

### Directory Structure

```
apps/network/src/environments/rpg/
├── index.ts                    # Re-exports rpgEnvironment
├── interfaces.ts               # All contracts
├── environment.ts              # Thin AgentEnvironment orchestrator (~200 lines)
├── commands/
│   ├── index.ts                # CommandRegistry
│   ├── attack.ts, explore.ts, flee.ts, ... (one per command)
│   └── hub-town/
│       ├── visit-location.ts, buy-item.ts, sell-item.ts, embark.ts
├── repositories/
│   ├── game-state.d1.ts        # D1 GameStateRepository
│   ├── campaign.d1.ts          # D1 CampaignRepository
│   ├── character.do-storage.ts # DO CharacterRepository
│   └── __tests__/              # In-memory implementations
├── systems/
│   ├── turn-manager.ts, combat-resolver.ts, loot-system.ts, xp-system.ts, hub-town.ts
├── context/
│   ├── context-builder.ts, auto-play.ts
├── events/
│   ├── game-events.ts          # GameEventEmitter impl
│   └── reactive.ts             # Future: DO-to-DO wake signals
├── campaign/
│   ├── campaign-logic.ts, normalizers.ts, serialization.ts
└── __tests__/
```

### Migration Phases

**Phase 1: Extract Interfaces + Repositories** (LOW RISK)
- Create `rpg/interfaces.ts` with all contracts
- Create `rpg/repositories/game-state.d1.ts` — extract ~30 raw SQL calls into repository methods
- Create `rpg/repositories/campaign.d1.ts` — extract campaign CRUD
- Create in-memory test implementations
- Affected: `apps/network/src/environments/rpg.ts` → new `rpg/` directory

**Phase 2: Extract Game Systems** (LOW RISK)
- `rpg/systems/turn-manager.ts` — `advanceTurn`, `normalizeTurnState`, `computeInitiativeOrder`
- `rpg/systems/xp-system.ts` — all XP functions
- `rpg/systems/loot-system.ts` — `resolveTreasureLoot`, `maybeAwardEnemyDrop`
- `rpg/systems/combat-resolver.ts` — `runEnemyFreeAttackRound`, attack resolution
- `rpg/systems/hub-town.ts` — hub town state management
- Pure functions with no I/O — straightforward extraction

**Phase 3: Extract Campaign Logic** (LOW RISK)
- `rpg/campaign/normalizers.ts` — all `normalize*` functions (~200 lines)
- `rpg/campaign/campaign-logic.ts` — objective picking, arc resolution, disposition
- `rpg/campaign/serialization.ts` — `serializeWorldState`, `rowToCampaignState`

**Phase 4: Extract Commands** (MEDIUM RISK)
- Convert each command from the switch statement to a `CommandHandler` implementation
- Order: simple → hub town → setup → combat → game lifecycle
- Key design: commands mutate state, orchestrator saves (eliminates 25 duplicate SQL calls)

**Phase 5: Extract Context & AutoPlay** (LOW-MEDIUM RISK)
- `rpg/context/context-builder.ts` — 350-line `buildContext()`
- `rpg/context/auto-play.ts` — 250-line `getAutoPlayActions()`

**Phase 6: Wire Up Orchestrator + Events** (LOW RISK)
- `rpg/environment.ts` — thin orchestrator with command registry dispatch
- `rpg/events/game-events.ts` — extract event emission
- Delete original `rpg.ts`, update all imports

**Phase 7: Reactive Architecture** (LOW RISK — additive)
- Implement DO-to-DO wake signals via `GameEventEmitter`
- Add `ExplorationMode` (freeform) vs `CombatMode` (initiative turns)
- Feature-flagged rollout

* **Patterns to follow**: Repository pattern (interfaces + D1 impl + in-memory test impl), Command pattern (`CommandHandler` interface), existing `PhaseMachine` abstraction
* **Patterns to avoid**: Raw `ctx.db.prepare()` calls outside repositories, commands saving their own state, circular dependencies between modules
* **Configuration**: No env vars or feature flags needed until Phase 7 (reactive mode flag)
* **Dependencies**: No new packages — this is pure restructuring of existing code

### Verification

- [ ] All 412 existing tests pass after each phase
- [ ] All 112 Ralph stories continue passing after each phase
- [ ] No raw `ctx.db.prepare()` calls remain in command handlers after Phase 4
- [ ] `rpg.ts` is deleted after Phase 6 — no monolith remains
- [ ] Each `CommandHandler` has at least one unit test using in-memory repositories
- [ ] No circular dependencies in the module graph (verify with `madge` or import analysis)
- [ ] `GameEventEmitter` interface exists and is wired up by Phase 6
- [ ] `rpg-engine.ts` is unchanged (zero diff)
- [ ] Live agents (slag, snarl, swoop) continue playing through deployment of each phase

## Pros and Cons of the Options

### Option A: Interface-driven modular extraction (chosen)

* Good, because interfaces enable in-memory test implementations from day one
* Good, because command registry enables adding commands without touching existing code
* Good, because `GameEventEmitter` is the natural reactive extension point
* Good, because each phase is independently deployable and verifiable
* Bad, because 7 phases of work — high total effort
* Bad, because orchestrator-saves-after-command changes current save semantics

### Option B: File splitting by concern

* Good, because simpler — just move code blocks to new files
* Good, because faster initial delivery
* Bad, because preserves all existing coupling (raw SQL in commands, duplicated save patterns)
* Bad, because doesn't create testable boundaries — still needs D1 for tests
* Bad, because no extension points for reactive architecture

### Option C: Full rewrite

* Good, because cleanest architecture from scratch
* Bad, because extremely high risk with live system and 412 tests
* Bad, because weeks of zero-value work before first deployable result
* Bad, because likely to introduce subtle behavior differences

## More Information

- Architecture review: `memory/2025-02-13-rpg-architecture-review.md` (in clawd workspace)
- Key coupling points to break are documented in the architecture review (7 specific couplings with fixes)
- The dependency graph rule: arrows point DOWN — `environment → commands → systems/repos → rpg-engine`
- Revisit this decision if: Cloudflare introduces multi-alarm support for DOs (would change reactive architecture approach), or if the command count exceeds ~40 (may need command categories/namespaces)
