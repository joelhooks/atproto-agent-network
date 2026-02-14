import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

import {
  awardXp,
  type Character,
  type Enemy,
  cloneEnemiesForCombat,
  createCharacter,
  createDice,
  createGame,
  describeRoom,
  enemyIsNegotiable,
  enemyMoraleState,
  explore,
  findIntimidatableEnemies,
  gameCharacterToPersistent,
  generateFantasyName,
  gmInterveneIfStuck,
  isBossEncounterRoom,
  livingParty,
  markCharacterDeath,
  type Skills,
  nextEncounterRoomIndex,
  partyWipe,
  partyAverageLevel,
  persistentToGameCharacter,
  recordNarrativeBeat,
  resolveSkillCheck,
  soloMultiplier,
  type RpgClass,
  type FeedMessage,
  type FeedMessageType,
  type HubTownLocation,
  type HubTownState,
  type CampaignState,
  type WorldState,
  type RpgGameState,
  XP_PER_ADVENTURE_COMPLETE,
  XP_PER_BOSS_KILL,
  XP_PER_ENEMY_KILL,
  XP_PER_PUZZLE,
  XP_PER_ROOM_CLEAR,
  XP_PER_TRAP_DISARM,
  XP_PER_TREASURE_FIND,
  XP_TABLE,
  resolveSpell,
  resolveAbility,
  buildAbilityMenu,
  SPELLS,
  ABILITIES,
} from '../games/rpg-engine'
import {
  advanceTurn as advanceTurnSystem,
  computeInitiativeOrder as computeInitiativeOrderSystem,
  normalizeTurnState as normalizeTurnStateSystem,
  recomputeTurnOrder as recomputeTurnOrderSystem,
} from './rpg/systems/turn-manager'
import {
  addLoggedXp as addLoggedXpSystem,
  addXpEarned as addXpEarnedSystem,
  awardBarrierClearMilestoneXp as awardBarrierClearMilestoneXpSystem,
  awardAdventureCompleteXp as awardAdventureCompleteXpSystem,
  awardKillXp as awardKillXpSystem,
  awardRoomClearXp as awardRoomClearXpSystem,
  calculateEncounterXp as calculateEncounterXpSystem,
} from './rpg/systems/xp-system'
import {
  ensureCharacterLootState as ensureCharacterLootStateSystem,
  makeShopHealingPotion as makeShopHealingPotionSystem,
  maybeAwardEnemyDrop as maybeAwardEnemyDropSystem,
  normalizePartyLootState as normalizePartyLootStateSystem,
  resolveTreasureLoot as resolveTreasureLootSystem,
} from './rpg/systems/loot-system'
import {
  runEnemyFreeAttackRound as runEnemyFreeAttackRoundSystem,
} from './rpg/systems/combat-resolver'
import {
  buyFromHubTownMarket as buyFromHubTownMarketSystem,
  buildHubTownNarration as buildHubTownNarrationSystem,
  countHubTownIdleTurn as countHubTownIdleTurnSystem,
  ensureHubTownState as ensureHubTownStateSystem,
  HUB_TOWN_LOCATIONS as HUB_TOWN_LOCATIONS_SYSTEM,
  HUB_TOWN_LOCATION_LABEL as HUB_TOWN_LOCATION_LABEL_SYSTEM,
  resetHubTownIdle as resetHubTownIdleSystem,
  sellToHubTownMarket as sellToHubTownMarketSystem,
  tickHubTownDowntime as tickHubTownDowntimeSystem,
  transitionCampaignCompletionToHubTown as transitionCampaignCompletionToHubTownSystem,
  visitHubTownLocation as visitHubTownLocationSystem,
} from './rpg/systems/hub-town'

import type { PersistentCharacter } from '@atproto-agent/core'

import type { AgentEnvironment, EnvironmentContext, ToolCall } from './types'
import type { PhaseMachine } from './phase-machine'
import type { CampaignPatch, CreateCampaignOptions, GameEventEmitter, GamePhase } from './rpg/interfaces'
import { createRpgSetupPhaseMachine, serializePhaseMachine, deserializePhaseMachine } from './phase-machine'
import {
  DM_SKILL,
  DM_SKILL_BRIEF,
  WARRIOR_SKILL,
  SCOUT_SKILL,
  MAGE_SKILL,
  HEALER_SKILL,
  PARTY_TACTICS,
  WARRIOR_SKILL_BRIEF,
  SCOUT_SKILL_BRIEF,
  MAGE_SKILL_BRIEF,
  HEALER_SKILL_BRIEF,
} from './rpg-skills'
import {
  buildDefaultStoryArcs,
  buildDefaultWorldState,
  formatFactionStandingLine,
  normalizeCreateCampaignOptions,
  normalizeStoryArcs,
  normalizeWorldState,
  parseCampaignAdventureCount,
  worldStateWithoutMeta,
} from './rpg/campaign/normalizers'
import { rowToCampaignState, serializeWorldState, type CampaignRow } from './rpg/campaign/serialization'
import {
  buildCampaignDungeonThread,
  resolveStoryArcsForAdventureOutcome,
  type CampaignDungeonObjective,
  applyDispositionForEncounterOutcome,
} from './rpg/campaign/campaign-logic'
import { executeCombatCommand } from './rpg/commands/combat-commands'
import { executeExplorationCommand } from './rpg/commands/exploration-commands'
import { executeHubTownCommand } from './rpg/commands/hub-town-commands'
import { executeLifecycleCommand } from './rpg/commands/lifecycle-commands'
import { executeSocialCommand } from './rpg/commands/social-commands'
export {
  applyDispositionForEncounterOutcome,
  buildCampaignDungeonThread,
  resolveStoryArcsForAdventureOutcome,
  type CampaignDungeonObjective,
} from './rpg/campaign/campaign-logic'

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

/** Get the identity key for a character (agent name if mapped, otherwise character name) */
function characterId(c: Character | undefined | null): string {
  if (!c) return 'unknown'
  return c.agent ?? c.name
}

/** Check if a character matches a given identity (agent name or character name) */
function isCharacter(c: Character, identity: string): boolean {
  return c.agent === identity || c.name === identity
}

/** Generate a fantasy name for an agent joining a game */
function generateJoinName(klass: RpgClass, partyIndex: number): string {
  return generateFantasyName(klass, partyIndex)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type ReactiveRpgContext = EnvironmentContext & {
  reactiveMode?: boolean
  wakeAgent?: (agentName: string, detail?: Record<string, unknown>) => Promise<void> | void
}

type ReactiveStateSnapshot = {
  phase: RpgGameState['phase']
  mode: RpgGameState['mode']
  currentPlayer: string
}

const FREEFORM_EXPLORATION_COMMANDS = new Set([
  'explore',
  'attack',
  'negotiate',
  'flee',
  'sneak',
  'intimidate',
  'resurrect',
  'cast_spell',
  'use_skill',
  'use_item',
  'rest',
])

function isReactiveModeEnabled(ctx: EnvironmentContext): boolean {
  return Boolean((ctx as ReactiveRpgContext).reactiveMode)
}

function listPartyAgentNames(game: RpgGameState): string[] {
  const members = Array.isArray(game.party) ? game.party : []
  const names = new Set<string>()
  for (const member of members) {
    const raw = String(member?.agent ?? member?.name ?? '').trim()
    if (raw) names.add(raw)
  }
  return Array.from(names)
}

function createReactiveGameEventEmitter(ctx: EnvironmentContext, game: RpgGameState): GameEventEmitter {
  const reactiveCtx = ctx as ReactiveRpgContext
  const wakeAgent = reactiveCtx.wakeAgent
  const reactiveEnabled = isReactiveModeEnabled(ctx)

  const wake = async (agentName: string, detail: Record<string, unknown>): Promise<void> => {
    if (!reactiveEnabled || typeof wakeAgent !== 'function') return
    const target = String(agentName ?? '').trim()
    if (!target) return
    try {
      await wakeAgent(target, detail)
    } catch {
      // best-effort
    }
  }

  const wakeParty = async (detail: Record<string, unknown>): Promise<void> => {
    if (!reactiveEnabled || typeof wakeAgent !== 'function') return
    const partyAgents = listPartyAgentNames(game)
    for (const agentName of partyAgents) {
      await wake(agentName, detail)
    }
  }

  return {
    onEnvironmentCompleted: async (environmentCtx: EnvironmentContext, gameId: string, state: RpgGameState) =>
      emitEnvironmentCompleted(environmentCtx, { gameId, game: state }),
    onTurnAdvanced: async (gameId: string, nextPlayer: string) => {
      await wake(nextPlayer, { event: 'rpg.turn_advanced', gameId, nextPlayer, at: Date.now() })
    },
    onCombatStarted: async (gameId: string) => {
      await wakeParty({ event: 'rpg.combat_started', gameId, at: Date.now() })
    },
    onPhaseChanged: async (gameId: string, from: GamePhase, to: GamePhase) => {
      await wakeParty({ event: 'rpg.phase_changed', gameId, from, to, at: Date.now() })
    },
  }
}

async function emitReactiveSignals(
  eventEmitter: GameEventEmitter,
  input: {
    gameId: string
    before: ReactiveStateSnapshot
    after: ReactiveStateSnapshot
  }
): Promise<void> {
  const { gameId, before, after } = input

  if (after.currentPlayer && after.currentPlayer !== before.currentPlayer) {
    await eventEmitter.onTurnAdvanced(gameId, after.currentPlayer)
  }

  if (before.phase !== after.phase) {
    await eventEmitter.onPhaseChanged(gameId, before.phase, after.phase)
  }

  if (before.mode !== after.mode) {
    await eventEmitter.onPhaseChanged(gameId, before.mode as unknown as GamePhase, after.mode as unknown as GamePhase)
    if (after.mode === 'combat') {
      await eventEmitter.onCombatStarted(gameId)
    }
  }
}

async function ensureCampaignSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        premise TEXT DEFAULT '',
        world_state TEXT DEFAULT '{}',
        story_arcs TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run()
    .catch(() => undefined)
}

export async function createCampaign(
  db: D1Database,
  name: string,
  premise: string,
  options?: CreateCampaignOptions | string
): Promise<CampaignState> {
  await ensureCampaignSchema(db)
  const campaignOptions = normalizeCreateCampaignOptions(options)
  const safeName = String(name || '').trim() || 'Untitled Campaign'
  const safePremise = String(premise || '').trim()
  const worldState = campaignOptions.worldState
    ? worldStateWithoutMeta(
        normalizeWorldState(campaignOptions.worldState, {
          adventureCount: 0,
        })
      )
    : buildDefaultWorldState()
  const storyArcs = campaignOptions.storyArcs
    ? normalizeStoryArcs(campaignOptions.storyArcs)
    : buildDefaultStoryArcs()
  const campaign: CampaignState = {
    id: `campaign_${generateTid()}`,
    name: safeName,
    premise: safePremise,
    worldState,
    storyArcs,
    adventureCount: 0,
  }

  await db
    .prepare(
      "INSERT INTO campaigns (id, name, premise, world_state, story_arcs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    )
    .bind(campaign.id, campaign.name, campaign.premise, serializeWorldState(campaign), JSON.stringify(campaign.storyArcs))
    .run()
  return campaign
}

export async function getCampaign(db: D1Database, id: string): Promise<CampaignState | null> {
  await ensureCampaignSchema(db)
  const row = await db
    .prepare('SELECT id, name, premise, world_state, story_arcs, created_at, updated_at FROM campaigns WHERE id = ?')
    .bind(id)
    .first<CampaignRow>()
  if (!row) return null
  return rowToCampaignState(row)
}

export async function updateCampaign(db: D1Database, id: string, patch: CampaignPatch): Promise<void> {
  const current = await getCampaign(db, id)
  if (!current) return

  const next: CampaignState = {
    ...current,
    ...(typeof patch.name === 'string' ? { name: patch.name.trim() || current.name } : {}),
    ...(typeof patch.premise === 'string' ? { premise: patch.premise.trim() } : {}),
    worldState: patch.worldState
      ? worldStateWithoutMeta(
          normalizeWorldState(patch.worldState, {
            adventureCount: parseCampaignAdventureCount(patch.adventureCount, current.adventureCount),
          })
        )
      : { ...current.worldState },
    storyArcs: patch.storyArcs ? normalizeStoryArcs(patch.storyArcs) : current.storyArcs,
    adventureCount: parseCampaignAdventureCount(patch.adventureCount, current.adventureCount),
  }

  await db
    .prepare("UPDATE campaigns SET name = ?, premise = ?, world_state = ?, story_arcs = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(next.name, next.premise, serializeWorldState(next), JSON.stringify(next.storyArcs), id)
    .run()
}

export async function linkAdventureToCampaign(db: D1Database, envId: string, campaignId: string): Promise<number> {
  await ensureCampaignSchema(db)
  const campaign = await getCampaign(db, campaignId)
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

  const row = await db
    .prepare("SELECT id, state FROM environments WHERE id = ? AND type = 'rpg'")
    .bind(envId)
    .first<{ id: string; state: string }>()
  if (!row) throw new Error(`Adventure ${envId} not found`)

  const adventureNumber = Math.max(1, campaign.adventureCount + 1)
  const nextState = (() => {
    try {
      const parsed = JSON.parse(row.state)
      if (isRecord(parsed)) {
        parsed.campaignId = campaign.id
        parsed.campaignAdventureNumber = adventureNumber
      }
      return JSON.stringify(parsed)
    } catch {
      return row.state
    }
  })()

  await db
    .prepare("UPDATE environments SET campaign_id = ?, adventure_number = ?, state = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(campaign.id, adventureNumber, nextState, envId)
    .run()

  await updateCampaign(db, campaign.id, { adventureCount: adventureNumber })
  return adventureNumber
}

function objectiveFromGame(game: RpgGameState): CampaignDungeonObjective | null {
  const raw = (game as Record<string, unknown>).campaignObjective
  if (!isRecord(raw)) return null
  const arcId = String(raw.arcId ?? '').trim()
  const arcName = String(raw.arcName ?? '').trim()
  const plotPointId = String(raw.plotPointId ?? '').trim()
  const plotPoint = String(raw.plotPoint ?? '').trim()
  if (!arcId || !plotPointId || !plotPoint) return null
  return { arcId, arcName, plotPointId, plotPoint }
}

function addXpEarned(game: RpgGameState, who: string, amount: number): void {
  addXpEarnedSystem(game, who, amount)
}

function addLoggedXp(game: RpgGameState, who: string, amount: number, reason: string): void {
  addLoggedXpSystem(game, who, amount, reason)
}

function awardKillXp(game: RpgGameState, who: string, enemy: Enemy): void {
  awardKillXpSystem(game, who, enemy)
}

function calculateEncounterXp(enemies: Enemy[]): number {
  return calculateEncounterXpSystem(enemies)
}

function ensureCharacterLootState(character: Character | undefined | null): void {
  ensureCharacterLootStateSystem(character)
}

function normalizePartyLootState(game: RpgGameState): void {
  normalizePartyLootStateSystem(game)
}

function findActingCharacter(game: RpgGameState, agentName: string): Character | undefined {
  const agent = String(agentName ?? '').trim()
  return (
    (Array.isArray(game.party) ? game.party.find((p) => p && isCharacter(p, agent)) : undefined) ??
    (Array.isArray(game.party) ? game.party.find((p) => p && isCharacter(p, game.currentPlayer)) : undefined) ??
    (Array.isArray(game.party) ? game.party[0] : undefined)
  )
}

function resolveTreasureLoot(game: RpgGameState, actor: Character, dice: ReturnType<typeof createDice>): string {
  return resolveTreasureLootSystem(game, actor, dice)
}

function maybeAwardEnemyDrop(
  game: RpgGameState,
  actor: Character,
  enemy: Enemy,
  dice: ReturnType<typeof createDice>,
): string | null {
  return maybeAwardEnemyDropSystem(game, actor, enemy, dice)
}

function makeShopHealingPotion(dice: ReturnType<typeof createDice>) {
  return makeShopHealingPotionSystem(dice)
}

const HUB_TOWN_LOCATIONS: readonly HubTownLocation[] = HUB_TOWN_LOCATIONS_SYSTEM
const HUB_TOWN_LOCATION_LABEL: Record<HubTownLocation, string> = HUB_TOWN_LOCATION_LABEL_SYSTEM

function ensureHubTownState(game: RpgGameState): HubTownState {
  return ensureHubTownStateSystem(game)
}

function resetHubTownIdle(game: RpgGameState): void {
  resetHubTownIdleSystem(game)
}

function countHubTownIdleTurn(game: RpgGameState): number {
  return countHubTownIdleTurnSystem(game)
}

function buildHubTownNarration(game: RpgGameState, input: { location: HubTownLocation; cue: string }): string {
  return buildHubTownNarrationSystem(game, input)
}

function transitionCampaignCompletionToHubTown(game: RpgGameState, beforePhase: RpgGameState['phase']): { completed: boolean; enteredHubTown: boolean } {
  return transitionCampaignCompletionToHubTownSystem(game, beforePhase)
}

function visitHubTownLocation(game: RpgGameState, input: { agentName: string; location: unknown }) {
  return visitHubTownLocationSystem(game, input)
}

function buyFromHubTownMarket(game: RpgGameState, input: { agentName: string; itemId: unknown }) {
  return buyFromHubTownMarketSystem(game, input)
}

function sellToHubTownMarket(game: RpgGameState, input: { agentName: string; itemId: unknown }) {
  return sellToHubTownMarketSystem(game, input)
}

function tickHubTownDowntime(game: RpgGameState) {
  return tickHubTownDowntimeSystem(game)
}

function livingPartyIds(game: RpgGameState): string[] {
  const party = Array.isArray(game.party) ? game.party : []
  return party.filter((p) => (p?.hp ?? 0) > 0).map((p) => characterId(p))
}

function awardRoomClearXp(game: RpgGameState): void {
  awardRoomClearXpSystem(game)
}

function awardAdventureCompleteXp(game: RpgGameState): void {
  awardAdventureCompleteXpSystem(game)
}

function awardBarrierClearMilestoneXp(
  game: RpgGameState,
  input: { logSlice: Array<{ who?: string; what?: string }>; fallbackActorId: string }
): void {
  awardBarrierClearMilestoneXpSystem(game, input)
}

function clampSkill(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(100, Math.floor(value)))
}

function listLivingEnemies(game: RpgGameState): Enemy[] {
  return (game.combat?.enemies ?? []).filter((enemy) => (enemy?.hp ?? 0) > 0)
}

function deathLocale(game: RpgGameState): string {
  const locale = typeof game.theme?.name === 'string' ? game.theme.name.trim() : ''
  return locale || 'the dungeon'
}

function deathCauseFromAttacker(game: RpgGameState, attackerName: string): string {
  return `slain by ${attackerName} in ${deathLocale(game)}`
}

function applyResurrectionWeakness(target: Character): void {
  target.skills.attack = clampSkill(target.skills.attack - 10)
  target.skills.dodge = clampSkill(target.skills.dodge - 10)
  target.skills.cast_spell = clampSkill(target.skills.cast_spell - 10)
  target.skills.use_skill = clampSkill(target.skills.use_skill - 10)
  target.resurrectionWeakness = 10
}

function buildRerolledPersistentCharacter(
  previous: PersistentCharacter,
  fresh: Character,
): PersistentCharacter {
  const now = Date.now()
  const adventureLog = Array.isArray(previous.adventureLog) ? [...previous.adventureLog] : []
  const achievements = Array.isArray(previous.achievements) ? [...previous.achievements] : []
  return {
    name: fresh.name,
    klass: fresh.klass,
    level: 1,
    xp: 0,
    maxHp: fresh.maxHp,
    maxMp: fresh.maxMp,
    skills: { ...fresh.skills },
    backstory: '',
    motivation: '',
    appearance: '',
    personalityTraits: [],
    adventureLog,
    achievements,
    inventory: [],
    createdAt: now,
    updatedAt: now,
    gamesPlayed: Number.isFinite(previous.gamesPlayed) ? Math.max(0, Math.floor(previous.gamesPlayed)) : 0,
    deaths: Number.isFinite(previous.deaths) ? Math.max(0, Math.floor(previous.deaths)) : 0,
    dead: false,
  }
}

function runEnemyFreeAttackRound(game: RpgGameState, dice: ReturnType<typeof createDice>): string[] {
  return runEnemyFreeAttackRoundSystem(game, dice)
}

function normalizeToolCallArguments(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

type EnvironmentRow = { id: string; state: string; type?: string | null }

function dayPrefixFromTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length < 10) return null
  return s.slice(0, 10)
}

function getMaxEnvironmentsPerDay(ctx: EnvironmentContext): number {
  const raw = (ctx as any)?.maxEnvironmentsPerDay ?? (ctx as any)?.maxGamesPerDay
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return 50
}

async function anyPlayingRpgEnvironmentsExist(ctx: EnvironmentContext): Promise<boolean> {
  try {
    const row = await ctx.db
      .prepare("SELECT id FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') LIMIT 1")
      .first<{ id: string }>()
    return Boolean(row?.id)
  } catch {
    return false
  }
}

async function countFinishedRpgEnvironmentsToday(ctx: EnvironmentContext): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const { results } = await ctx.db
      .prepare("SELECT id, updated_at FROM environments WHERE type = 'rpg' AND phase = 'finished'")
      .all<{ id: string; updated_at: string }>()
    return (results ?? []).filter((r) => dayPrefixFromTimestamp(r?.updated_at) === today).length
  } catch {
    return 0
  }
}

async function emitEnvironmentCompleted(ctx: EnvironmentContext, input: { gameId: string; game: RpgGameState }): Promise<void> {
  const { gameId, game } = input
  const turns = typeof (game as any).turn === 'number' ? (game as any).turn : game.roomIndex + 1
  const summary = {
    gameId,
    type: 'rpg' as const,
    winner: (game as any).winner ?? null,
    turns,
    players: Array.isArray(game.party) ? game.party.map((p) => ({ name: p.name, vp: p.hp })) : [],
  }

  console.log(JSON.stringify({ event_type: 'game.completed', level: 'info', ...summary }))
  try {
    await ctx.broadcast({ event_type: 'game.completed', ...summary })
  } catch {
    // best-effort
  }

  try {
    await applyAdventureOutcomeToCampaign(ctx, { gameId, game })
  } catch {
    // best-effort
  }

  // Save persistent character for this agent
  if (ctx.saveCharacter && ctx.loadCharacter) {
    try {
      const agentName = ctx.agentName.trim()
      const partyMember = Array.isArray(game.party)
        ? game.party.find((p) => (p.agent ?? p.name) === agentName)
        : undefined
      if (partyMember) {
        const existing = (await ctx.loadCharacter()) as PersistentCharacter | null
        const adventureSummary = compactAdventureLog(game)
        const persistent = gameCharacterToPersistent(partyMember, existing?.klass ? existing : null, adventureSummary)
        persistent.achievements = Array.isArray((persistent as any).achievements) ? (persistent as any).achievements : []
        awardRpgAchievements(persistent, { game, agentName, characterName: partyMember.name })
        const earned = game.xpEarned?.[agentName] ?? 0
        if (earned > 0) {
          awardXp(persistent, earned)
        }
        await ctx.saveCharacter(persistent)
      }
    } catch {
      // best-effort — don't break game completion
    }
  }
}

function capChars(text: string, max: number): string {
  if (!text) return ''
  const s = String(text)
  if (s.length <= max) return s
  return s.slice(0, max)
}

function formatPartyNames(names: string[]): string {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim()).filter(Boolean)
  if (list.length === 0) return 'unknown heroes'
  return list.slice(0, 3).join(', ')
}

function outcomeLabel(game: RpgGameState): 'victory' | 'tpk' | 'abandoned' {
  const party = Array.isArray(game.party) ? game.party : []
  const tpk = party.length > 0 && party.every((p) => (p?.hp ?? 0) <= 0)
  if (tpk) return 'tpk'
  const finishedAtEnd = Number.isFinite(game.roomIndex) && game.roomIndex >= Math.max(0, (game.dungeon?.length ?? 0) - 1)
  if (finishedAtEnd) return 'victory'
  return 'abandoned'
}

async function applyAdventureOutcomeToCampaign(
  ctx: EnvironmentContext,
  input: { gameId: string; game: RpgGameState }
): Promise<void> {
  const campaignId = typeof input.game.campaignId === 'string' ? input.game.campaignId : ''
  if (!campaignId) return

  const campaign = await getCampaign(ctx.db, campaignId)
  if (!campaign) return

  const adventureNumber = parseCampaignAdventureCount(input.game.campaignAdventureNumber, campaign.adventureCount + 1)
  const outcome = outcomeLabel(input.game)
  const summary = compactAdventureLog(input.game)

  const event = `Adventure #${adventureNumber} (${input.gameId}) ended in ${outcome}: ${summary}`

  const nextWorldState: WorldState = {
    ...campaign.worldState,
    events: [...(campaign.worldState.events ?? []), event].slice(-100),
  }

  const nextArcs = resolveStoryArcsForAdventureOutcome({
    storyArcs: campaign.storyArcs,
    gameId: input.gameId,
    outcome,
    objective: objectiveFromGame(input.game) ?? undefined,
  })

  await updateCampaign(ctx.db, campaignId, {
    worldState: nextWorldState,
    storyArcs: nextArcs,
    adventureCount: Math.max(campaign.adventureCount, adventureNumber),
  })
}

async function applyEncounterDispositionToCampaign(
  ctx: EnvironmentContext,
  input: {
    game: RpgGameState
    enemies: Enemy[]
    resolution: 'kill' | 'negotiate'
    reason: string
  }
): Promise<void> {
  const campaignId = typeof input.game.campaignId === 'string' ? input.game.campaignId.trim() : ''
  if (!campaignId) return

  let campaign: CampaignState | null = null
  try {
    campaign = await getCampaign(ctx.db, campaignId)
  } catch {
    return
  }
  if (!campaign) return

  const next = applyDispositionForEncounterOutcome({
    campaign,
    enemies: input.enemies,
    resolution: input.resolution,
    reason: input.reason,
  })
  if (next === campaign) return

  await updateCampaign(ctx.db, campaignId, { worldState: next.worldState })

  if (input.game.campaignContext) {
    input.game.campaignContext.factions = (next.worldState.factions ?? [])
      .slice(0, 4)
      .map((faction) => formatFactionStandingLine({ name: faction.name, disposition: faction.disposition }))
  }

  const previousEventCount = Array.isArray(campaign.worldState.events) ? campaign.worldState.events.length : 0
  const appendedEvents = (next.worldState.events ?? []).slice(previousEventCount)
  if (appendedEvents.length > 0) {
    const existing = Array.isArray(input.game.campaignLog) ? input.game.campaignLog : []
    input.game.campaignLog = [...existing, ...appendedEvents].slice(-25)
  }
}

function countKillsFromLog(game: RpgGameState, agentName: string): number {
  const log = Array.isArray(game.log) ? game.log : []
  return log.filter((e) => e && e.who === agentName && typeof e.what === 'string' && e.what.includes('(kill:')).length
}

function findBossKillEnemyName(game: RpgGameState, agentName: string): string {
  const log = Array.isArray(game.log) ? game.log : []
  for (let i = 0; i < log.length; i += 1) {
    const e = log[i]
    if (!e || e.who !== agentName || typeof e.what !== 'string') continue
    if (!e.what.includes('(boss kill)')) continue
    // Attack path logs "... (kill: NAME)" and then "... (boss kill)". Walk back to find that name.
    for (let j = i - 1; j >= 0 && j >= i - 5; j -= 1) {
      const prev = log[j]
      const w = typeof prev?.what === 'string' ? prev.what : ''
      if (prev?.who !== agentName) continue
      const idx = w.indexOf('(kill:')
      if (idx < 0) continue
      const after = w.slice(idx + '(kill:'.length).replace(')', '').trim()
      return after.replace(/\)\s*$/, '').trim()
    }
    return ''
  }
  return ''
}

function hasBarrierBreak(game: RpgGameState): boolean {
  const log = Array.isArray(game.log) ? game.log : []
  return log.some((e) => {
    const w = typeof e?.what === 'string' ? e.what : ''
    if (!w.startsWith('barrier:')) return false
    return !w.includes('blocked')
  })
}

function hasBossKill(game: RpgGameState): boolean {
  const log = Array.isArray(game.log) ? game.log : []
  return log.some((e) => typeof e?.what === 'string' && e.what.includes('(boss kill)'))
}

/**
 * Generate a compact narrative summary for the adventure log.
 * Format: "The party of {names} ventured into {theme} dungeon. {key events}. {outcome}."
 * Capped at 200 characters.
 */
export function compactAdventureLog(game: RpgGameState): string {
  const names = formatPartyNames((Array.isArray(game.party) ? game.party : []).map((p) => p?.name ?? '').filter(Boolean))
  const rawTheme = (game as any).theme
  const theme = capChars(String(typeof rawTheme === 'object' && rawTheme?.name ? rawTheme.name : rawTheme ?? 'mysterious').trim(), 32)

  const roomsCleared = Math.max(0, Math.min((game.roomIndex ?? 0) + 1, (game.dungeon?.length ?? 0)))
  const dead = (Array.isArray(game.party) ? game.party : []).filter((p) => (p?.hp ?? 0) <= 0).length
  const totalKills =
    Array.isArray(game.log) ? game.log.filter((e) => typeof e?.what === 'string' && e.what.includes('(kill:')).length : 0

  const events: string[] = []
  if (hasBossKill(game)) events.push('boss felled')
  if (totalKills > 0) events.push(`${totalKills} kill${totalKills === 1 ? '' : 's'}`)
  if (dead > 0) events.push(`${dead} fallen`)
  if (hasBarrierBreak(game)) events.push('barrier broken')
  if (roomsCleared > 0) events.push(`${roomsCleared} room${roomsCleared === 1 ? '' : 's'} cleared`)

  const outcome = outcomeLabel(game)

  const sentence1 = `The party of ${names} ventured into ${theme} dungeon.`
  const sentence2 = `${events.length > 0 ? events.slice(0, 3).join(', ') : 'Hard-won progress'}`
  const sentence3 = `Outcome: ${outcome}.`

  return capChars(`${sentence1} ${sentence2}. ${sentence3}`.replace(/\s+/g, ' ').trim(), 200)
}

function addAchievement(pc: PersistentCharacter, achievement: string): void {
  const a = String(achievement ?? '').trim()
  if (!a) return
  pc.achievements ??= []
  if (!Array.isArray(pc.achievements)) pc.achievements = []
  if (pc.achievements.includes(a)) return
  pc.achievements.push(a)
}

function bossAchievementFromEnemy(enemyName: string): string {
  const n = String(enemyName ?? '').toLowerCase()
  if (n.includes('dragon')) return 'Dragonslayer'
  if (n.includes('lich')) return 'Lichbane'
  if (n.includes('demon')) return 'Demonbane'
  return 'Boss Slayer'
}

function tookDamageFromLog(game: RpgGameState, characterName: string): boolean {
  const name = String(characterName ?? '').trim()
  if (!name) return true
  const log = Array.isArray(game.log) ? game.log : []
  return log.some((e) => {
    const w = typeof e?.what === 'string' ? e.what : ''
    if (w.includes(`hit ${name} for `)) return true
    if (w.includes(`critical hit ${name} for `)) return true
    if (w.includes(`special hit ${name} for `)) return true
    if (w.includes(`near-death: ${name}`)) return true
    if (w.includes(`fumble: hurt self`)) return true
    return false
  })
}

function awardRpgAchievements(
  pc: PersistentCharacter,
  input: { game: RpgGameState; agentName: string; characterName: string }
): void {
  const { game, agentName, characterName } = input

  const log = Array.isArray(game.log) ? game.log : []
  const bossKill = log.some((e) => e && e.who === agentName && typeof e.what === 'string' && e.what.includes('(boss kill)'))
  if (bossKill) {
    const bossName = findBossKillEnemyName(game, agentName)
    addAchievement(pc, bossAchievementFromEnemy(bossName))
  }

  const party = Array.isArray(game.party) ? game.party : []
  const member = party.find((p) => (p?.agent ?? p?.name) === agentName) ?? party.find((p) => p?.name === characterName)
  if (member && (member.hp ?? 0) > 0) {
    const ratio = (member.maxHp ?? 0) > 0 ? (member.hp ?? 0) / (member.maxHp ?? 1) : 1
    if (ratio > 0 && ratio < 0.1) {
      addAchievement(pc, "Death's Doorstep")
    }
  }

  if (member && (member.hp ?? 0) > 0) {
    const noDamage = (member.hp ?? 0) === (member.maxHp ?? 0) && !tookDamageFromLog(game, member.name)
    if (noDamage) {
      addAchievement(pc, 'Untouchable')
    }
  }

  if (Number.isFinite(pc.gamesPlayed) && pc.gamesPlayed >= 5) {
    addAchievement(pc, 'Veteran Adventurer')
  }
}

async function findActiveGameForAgent(ctx: EnvironmentContext): Promise<EnvironmentRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    // Check as player first
    const asPlayer = await ctx.db
      .prepare("SELECT id, state, type FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND players LIKE ? LIMIT 1")
      .bind(`%${agentName}%`)
      .first<EnvironmentRow>()
    if (asPlayer) return asPlayer

    // Check as host/DM
    const asHost = await ctx.db
      .prepare("SELECT id, state, type FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND host_agent = ? LIMIT 1")
      .bind(agentName)
      .first<EnvironmentRow>()
    return asHost ?? null
  } catch {
    return null
  }
}

async function findActiveGameWhereItsMyTurn(ctx: EnvironmentContext): Promise<EnvironmentRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const row = await ctx.db
      .prepare(
        "SELECT id, state, type FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup', 'hub_town') AND json_extract(state, '$.currentPlayer') = ?"
      )
      .bind(agentName)
      .first<EnvironmentRow>()
    return row ?? null
  } catch {
    return null
  }
}

function summarizeParty(game: RpgGameState): string {
  return game.party
    .map((p) => {
      const agentTag = p.agent ? ` [${p.agent}]` : ''
      return `${p.name}(${p.klass})${agentTag} HP ${p.hp}/${p.maxHp} MP ${p.mp}/${p.maxMp}`
    })
    .join(' | ')
}

function pickJoinClass(game: RpgGameState): RpgClass {
  const counts = new Map<RpgClass, number>([
    ['Warrior', 0],
    ['Scout', 0],
    ['Mage', 0],
    ['Healer', 0],
  ])
  for (const member of game.party) {
    counts.set(member.klass, (counts.get(member.klass) ?? 0) + 1)
  }

  let best: RpgClass = 'Warrior'
  let bestCount = Number.POSITIVE_INFINITY
  for (const klass of ['Warrior', 'Scout', 'Mage', 'Healer'] as const) {
    const count = counts.get(klass) ?? 0
    if (count < bestCount) {
      best = klass
      bestCount = count
    }
  }
  return best
}

async function findJoinableEnvironmentsForAgent(
  ctx: EnvironmentContext,
  input: { limit?: number }
): Promise<Array<{ id: string; game: RpgGameState }>> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return []

  try {
    const { results } = await ctx.db
      .prepare("SELECT id, state FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY updated_at DESC")
      .all<EnvironmentRow>()

    const joinable: Array<{ id: string; game: RpgGameState }> = []
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)))

    for (const row of results) {
      if (!row?.id || typeof row.state !== 'string') continue
      try {
        const game = JSON.parse(row.state) as RpgGameState
        if (!game || game.type !== 'rpg') continue
        if (Array.isArray(game.party) && game.party.some((p) => p && isCharacter(p, agentName))) continue
        if (!Array.isArray(game.party) || game.party.length >= 3) continue
        joinable.push({ id: row.id, game })
        if (joinable.length >= limit) break
      } catch {
        // ignore corrupt state rows
      }
    }

    return joinable
  } catch {
    return []
  }
}

function isLiving(character: Character | null | undefined): boolean {
  return Boolean(character) && (character!.hp ?? 0) > 0
}

function computeInitiativeOrder(party: Character[]): Character[] {
  return computeInitiativeOrderSystem(party)
}

function logSkipDeadTurn(game: RpgGameState, name: string): void {
  const who = String(name || '').trim()
  if (!who) return
  game.log ??= []
  game.log.push({ at: Date.now(), who: 'GM', what: `${who} is dead, skipping turn` })
}

function normalizeTurnState(game: RpgGameState): boolean {
  return normalizeTurnStateSystem(game)
}

function advanceTurn(game: RpgGameState): void {
  advanceTurnSystem(game)
}

function recomputeTurnOrder(game: RpgGameState): void {
  recomputeTurnOrderSystem(game)
}

export const rpgEnvironment: AgentEnvironment = {
  type: 'rpg',
  label: 'Dungeon Crawl',

  getTool(ctx: EnvironmentContext): PiAgentTool {
    return {
      name: 'rpg',
      label: 'Dungeon Crawl',
      description:
        'BRP-inspired party dungeon crawl. Commands:\n' +
        '- new_game: Start an adventure (requires players array)\n' +
        '- join_game: Join an open adventure (requires gameId + klass)\n' +
        '- create_character: Create/update your character (requires klass)\n' +
        "- send_message: Send a message to another agent on the game feed (requires to + message + type)\n" +
        '- setup_narrate: DM asks a backstory question (setup phase only)\n' +
        '- setup_respond: Player responds to DM backstory question (setup phase only)\n' +
        '- setup_finalize: DM finalizes backstories and begins the adventure (setup phase only)\n' +
        '- explore: Move to the next room\n' +
        '- attack: Attack (in combat attacks first enemy; otherwise attacks a party member if defender provided)\n' +
        '- negotiate: Attempt diplomacy in combat (only if all enemies are negotiable)\n' +
        '- flee: Attempt to retreat from combat (not allowed in boss rooms)\n' +
        '- sneak: Attempt to bypass the next combat encounter before it starts\n' +
        '- intimidate: Frighten wounded low-morale enemies into fleeing\n' +
        '- resurrect: Healer-only revival for allies who died this adventure (high risk)\n' +
        '- cast_spell: Cast a spell (fireball, ice_lance, lightning, heal, shield, smite)\n' +
        '- use_skill: Use a class ability (power_strike, shield_bash, aimed_shot, stealth, heal_touch, protect)\n' +
        '- use_item: Consume an inventory item (example: item="potion")\n' +
        '- rest: Recover some HP/MP\n' +
        '- visit_location: In hub town, move between tavern/market/temple/guild_hall\n' +
        '- buy_item: In hub town market, spend gold on gear\n' +
        '- sell_item: In hub town market, sell inventory loot for gold\n' +
        '- embark: In hub town, start the next campaign adventure\n' +
        '- status: Show game state\n' +
        '- get_reputation: Show faction standings for the current campaign\n',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: [
              'new_game',
              'join_game',
              'create_character',
              'send_message',
              'setup_narrate',
              'setup_respond',
              'setup_finalize',
              'explore',
              'attack',
              'negotiate',
              'flee',
              'sneak',
              'intimidate',
              'resurrect',
              'cast_spell',
              'use_skill',
              'use_item',
              'rest',
              'visit_location',
              'buy_item',
              'sell_item',
              'embark',
              'status',
              'get_reputation',
            ],
          },
          gameId: { type: 'string', description: 'Game ID (optional; defaults to your active adventure).' },
          players: { type: 'array', items: { type: 'string' }, description: 'Players for new_game.' },
          campaignId: { type: 'string', description: 'Optional campaign id to bind this adventure to.' },
          campaign_id: { type: 'string', description: 'Alias for campaignId.' },
          factionId: { type: 'string', description: 'Optional faction id/name filter for get_reputation.' },
          klass: { type: 'string', enum: ['Warrior', 'Scout', 'Mage', 'Healer'], description: 'Class for create_character.' },
          defender: { type: 'string', description: 'Party member to attack (out of combat only).' },
          spell: { type: 'string', description: 'Spell name for cast_spell.' },
          skill: { type: 'string', description: 'Skill name for use_skill (defaults to use_skill).' },
          item: { type: 'string', description: 'Item filter for use_item (example: potion).' },
          itemId: { type: 'string', description: 'Hub town market item id (buy_item/sell_item).' },
          location: { type: 'string', enum: [...HUB_TOWN_LOCATIONS], description: 'Hub town location for visit_location.' },
          shop: { type: 'string', enum: ['buy_potion', 'identify'], description: 'Rest-room shop action.' },
          message: { type: 'string', description: 'Narration/response message for setup phase.' },
          target: { type: 'string', description: 'Target player agent for DM narration or resurrect target.' },
          to: {
            type: 'string',
            description: 'Routing target: @agent, @party (broadcast), or @dm.',
          },
          type: { type: 'string', enum: ['ic', 'ooc'], description: 'ic = in-character, ooc = table talk.' },
          backstories: { type: 'object', additionalProperties: { type: 'string' }, description: 'Final backstories by agent.' },
        },
        required: ['command'],
      },
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const params = normalizeToolCallArguments(rawParams)
        let command = typeof params.command === 'string' ? params.command : ''
        const db = ctx.db
        const dice = createDice()

        if (command === 'join_game' || command === 'new_game') {
          const lifecycleResult = await executeLifecycleCommand({
            command,
            params,
            ctx,
            deps: {
              getCampaign,
              linkAdventureToCampaign,
            },
          })
          if (lifecycleResult) return lifecycleResult
        }

        // Resolve gameId (explicit or active)
        let gameId = typeof params.gameId === 'string' ? params.gameId : ''
        if (!gameId) {
          const row = await findActiveGameForAgent(ctx)
          if (!row) {
            // List joinable environments so the agent knows what to do.
            const joinable = await db
              .prepare("SELECT id, players FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY created_at DESC LIMIT 5")
              .all<{ id: string; players: string }>()
            const listings = (joinable.results ?? [])
              .map(g => `- ${g.id} (${JSON.parse(g.players).join(', ')})`)
              .join('\n')
            const hint = listings
              ? `\nJoinable adventures:\n${listings}\nUse command join_game with a gameId.`
              : '\nNo adventures available. Ask Grimlock to create one.'
            throw new Error(`No active adventure.${hint}`)
          }
          gameId = row.id
        }

        const row = await db
          .prepare("SELECT state FROM environments WHERE id = ? AND type = 'rpg'")
          .bind(gameId)
          .first<{ state: string }>()

        if (!row) throw new Error(`Adventure ${gameId} not found`)

        const game = JSON.parse(row.state) as RpgGameState
        game.party ??= []
        game.feedMessages ??= []
        game.round ??= 1
        normalizePartyLootState(game)
        const gameEventEmitter = createReactiveGameEventEmitter(ctx, game)

        const setupPhase = (game as any).setupPhase as RpgGameState['setupPhase'] | undefined
        const setupActive = Boolean(setupPhase && !setupPhase.complete)

        // Normalize turn state eagerly so dead players never softlock the game.
        // During setup, currentPlayer may be 'grimlock' (not in party), so skip normalization.
        if (!setupActive) {
          const beforePhase = game.phase
          const dirty = normalizeTurnState(game)
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)
          if (dirty || completion.enteredHubTown) {
            await db
              .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
              .run()
            if (completion.completed) {
              await emitEnvironmentCompleted(ctx, { gameId, game })
            }
          }
        }

        if (command === 'status' || command === 'get_reputation' || command === 'create_character') {
          const lifecycleResult = await executeLifecycleCommand({
            command,
            params,
            game,
            gameId,
            setupActive,
            ctx,
            deps: {
              getCampaign,
              linkAdventureToCampaign,
            },
          })
          if (lifecycleResult) return lifecycleResult
        }

        const hubTownResult = await executeHubTownCommand({
          command,
          game,
          gameId,
          params,
          agentName: ctx.agentName,
          deps: {
            saveGame: async (nextGame) => {
              await db
                .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(JSON.stringify(nextGame), nextGame.phase, (nextGame as any).winner ?? null, gameId)
                .run()
            },
            summarizeParty,
            getCampaign: async (id) => getCampaign(db, id),
            updateCampaign: async (id, patch) => updateCampaign(db, id, patch),
            linkAdventureToCampaign: async (envId, campaignId) => linkAdventureToCampaign(db, envId, campaignId),
          },
        })
        if (hubTownResult) return hubTownResult

        if (game.phase === 'hub_town' && command !== 'rest') {
          return {
            ok: false,
            error: 'You are in hub_town. Use: visit_location, buy_item, sell_item, rest, embark, status, or get_reputation.',
          }
        }

        // Setup command coercion: if setup is active and agent sends a non-setup command
        // (e.g., explore, attack), redirect to the correct setup command based on phase machine.
        // This is necessary because models like kimi-k2.5 ignore prompts and call gameplay commands.
        const setupCommands = ['setup_narrate', 'setup_respond', 'setup_finalize', 'status', 'new_game', 'join_game', 'message']
        if (setupActive && !setupCommands.includes(command)) {
          const pmData = (game as any).phaseMachine
          if (pmData) {
            const pm = deserializePhaseMachine(pmData)
            const currentPhase = pm.getCurrentPhase()
            const agentName = ctx.agentName.trim()
            if (currentPhase && pm.isActiveAgent(agentName)) {
              const setupCmd = currentPhase.transitionOn
              const msgText = typeof params.message === 'string' ? params.message : ''
              const coercedMessage = msgText || 'Tell me about your character — what brought you to this dark place?'
              console.log('setup-coerce: command redirect', { from: command, to: setupCmd, agent: agentName })
              command = setupCmd
              params.command = setupCmd
              if (setupCmd === 'setup_narrate') {
                const targetMatch = currentPhase.name.match(/setup_narrate_(\w+)_/)
                if (targetMatch) params.target = targetMatch[1]
                params.message = coercedMessage
              } else if (setupCmd === 'setup_respond') {
                params.message = coercedMessage
              } else if (setupCmd === 'setup_finalize') {
                // Auto-build backstories from dialogues
                const dialogues = (setupPhase!.dialogues ?? {}) as Record<string, string[]>
                const backstories: Record<string, string> = {}
                for (const [agent, msgs] of Object.entries(dialogues)) {
                  backstories[agent] = msgs.filter((_, i) => i % 2 === 1).join(' ') || 'A mysterious adventurer with a hidden past.'
                }
                params.backstories = backstories
              }
              // Fall through to setup handlers below with corrected command
            }
          }
        }

        if (command === 'setup_narrate' || command === 'setup_respond' || command === 'setup_finalize' || command === 'send_message') {
          const socialResult = await executeSocialCommand({
            command,
            params,
            game,
            gameId,
            ctx,
          })
          if (socialResult) return socialResult
        }

        // While setup is active, block normal gameplay commands to prevent skipping backstories.
        if (setupActive) {
          return { ok: false, error: 'Setup phase in progress. Use setup_narrate / setup_respond / setup_finalize.' }
        }

        const agentName = ctx.agentName.trim()
        const isPartyMember = Array.isArray(game.party) && game.party.some((member) => member && isCharacter(member, agentName))
        if (
          game.phase === 'playing' &&
          game.mode === 'exploring' &&
          isPartyMember &&
          FREEFORM_EXPLORATION_COMMANDS.has(command)
        ) {
          // Exploration mode is freeform: any party member can act without turn gating.
          game.currentPlayer = agentName
        }

        const beforeCommandState: ReactiveStateSnapshot = {
          phase: game.phase,
          mode: game.mode,
          currentPlayer: game.currentPlayer,
        }

        const saveGame = async (): Promise<void> => {
          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()
        }

        const explorationResult = await executeExplorationCommand({
          command,
          game,
          gameId,
          params,
          agentName,
          dice,
          deps: {
            saveGame,
            summarizeParty,
            emitEnvironmentCompleted: async () => emitEnvironmentCompleted(ctx, { gameId, game }),
            applyEncounterDispositionToCampaign: async (input) => applyEncounterDispositionToCampaign(ctx, input),
          },
        })
        if (explorationResult) {
          await emitReactiveSignals(gameEventEmitter, {
            gameId,
            before: beforeCommandState,
            after: { phase: game.phase, mode: game.mode, currentPlayer: game.currentPlayer },
          })
          return explorationResult
        }

        const combatResult = await executeCombatCommand({
          command,
          game,
          gameId,
          params,
          agentName,
          dice,
          deps: {
            saveGame,
            summarizeParty,
            emitEnvironmentCompleted: async () => emitEnvironmentCompleted(ctx, { gameId, game }),
            applyEncounterDispositionToCampaign: async (input) => applyEncounterDispositionToCampaign(ctx, input),
          },
        })
        if (combatResult) {
          await emitReactiveSignals(gameEventEmitter, {
            gameId,
            before: beforeCommandState,
            after: { phase: game.phase, mode: game.mode, currentPlayer: game.currentPlayer },
          })
          return combatResult
        }

        throw new Error(`Unknown rpg command: ${command}`)
      },
    }
  },

  async buildContext(ctx: EnvironmentContext): Promise<string[]> {
    const row = (await findActiveGameWhereItsMyTurn(ctx)) ?? (await findActiveGameForAgent(ctx))
    if (!row) {
      const joinable = await findJoinableEnvironmentsForAgent(ctx, { limit: 5 })
      if (joinable.length === 0) return []

      const lines: string[] = []
      lines.push('🏰 Joinable Dungeon Crawls:')
      for (const candidate of joinable) {
        const recommended = pickJoinClass(candidate.game)
        lines.push(`- ${candidate.id}: Party: ${summarizeParty(candidate.game)} | Current: ${candidate.game.currentPlayer}`)
        lines.push(`  Join: {"command":"join_game","gameId":"${candidate.id}","klass":"${recommended}"}`)
      }
      return lines.filter(Boolean)
    }

    try {
      const game = JSON.parse(row.state) as RpgGameState
      const room = game.dungeon[game.roomIndex]
      const agentName = ctx.agentName.trim()
      const partyMember = game.party?.find((p: any) => p && isCharacter(p, agentName))
      const freeformExploration =
        isReactiveModeEnabled(ctx) && game.phase === 'playing' && game.mode === 'exploring' && Boolean(partyMember)
      const isMyTurn = game.currentPlayer === agentName || freeformExploration
      const setupPhase = (game as any).setupPhase as RpgGameState['setupPhase'] | undefined

      if (setupPhase && !setupPhase.complete) {
        // Use phase machine for context if available
        const pmData = (game as any).phaseMachine
        if (pmData) {
          const pm = deserializePhaseMachine(pmData)
          const phase = pm.getCurrentPhase()
          if (phase && pm.isActiveAgent(agentName)) {
            return [
              `🎮🎮🎮 ${phase.prompt}`,
              ``,
              `⚠️ The ONLY tool available to you right now is "rpg". No other tools exist during setup.`,
            ]
          }
          if (phase && !pm.isActiveAgent(agentName)) {
            return [
              `Waiting for ${phase.activeAgent} to act in phase: ${phase.name}.`,
              'Use environment_broadcast to coordinate with teammates while you wait.',
            ]
          }
        }

        // Fallback for environments without phase machine (backward compat)
        const party = Array.isArray(game.party) ? game.party : []
        const idx = Math.max(0, Math.min(party.length - 1, Math.floor(setupPhase.currentPlayerIndex ?? 0)))
        const current = party[idx]
        const currentAgent = current ? (current.agent ?? current.name) : ''

        if (agentName.toLowerCase() === 'grimlock') {
          return [
            `🎮🎮🎮 SETUP PHASE — YOUR ONLY ACTION:`,
            `Call the "rpg" tool with these EXACT parameters:`,
            `  { "command": "setup_narrate", "target": "${currentAgent}", "message": "<your question about their backstory>" }`,
            ``,
            `You are interviewing ${currentAgent} about their character. Ask about their origin, motivation, or appearance.`,
            `After all players have responded, call: { "command": "setup_finalize", "backstories": { "<agent>": "<backstory>" } }`,
            ``,
            `⚠️ The ONLY tool available to you right now is "rpg". No other tools exist during setup.`,
          ]
        }

        if (agentName === currentAgent) {
          return [
            `🎮🎮🎮 SETUP PHASE — YOUR ONLY ACTION:`,
            `Call the "rpg" tool with these EXACT parameters:`,
            `  { "command": "setup_respond", "message": "<your backstory response>" }`,
            ``,
            `The DM is asking about your character's backstory. Respond in character.`,
            ``,
            `⚠️ The ONLY tool available to you right now is "rpg". No other tools exist during setup.`,
          ]
        }

        return [
          `Waiting for ${currentAgent || 'the current player'} to finish backstory with DM.`,
          'Use environment_broadcast to coordinate with teammates while you wait.',
        ]
      }

      if (game.phase === 'hub_town') {
        const hub = ensureHubTownState(game)
        const lines: string[] = []
        lines.push(buildHubTownNarration(game, { location: hub.location, cue: 'Downtime in town gives the party room to recover and prepare.' }))
        lines.push(`Location: ${hub.location}`)
        lines.push(`Idle turns: ${hub.idleTurns}/${hub.autoEmbarkAfter}`)
        lines.push(`Party: ${summarizeParty(game)}`)
        if (isMyTurn) {
          lines.push('Use one of: visit_location, buy_item, sell_item, rest, embark, status')
        } else {
          lines.push(`Waiting for ${game.currentPlayer} to act in hub town.`)
        }
        return lines.filter(Boolean)
      }

      // Barrier detection: if room requires a class nobody has, prompt recruitment
      const blockedRecruitment = (() => {
        if (!room || typeof room !== 'object') return ''
        const r = room as { type?: unknown; requiredClass?: unknown }
        if (r.type !== 'barrier') return ''
        const requiredClass = typeof r.requiredClass === 'string' ? r.requiredClass : ''
        if (!requiredClass) return ''
        const party = Array.isArray(game.party) ? game.party : []
        const hasClass = party.some((p: any) => p?.klass === requiredClass)
        if (hasClass) return ''
        return `URGENT: Recruit ${requiredClass} via message tool`
      })()

      // Inject persistent character backstory/history (after character intro, before tactical skills)
      const persistentLines: string[] = []
      if (ctx.loadCharacter) {
        try {
          const pc = (await ctx.loadCharacter()) as PersistentCharacter | null
          if (pc && pc.klass) {
            const lvl = Number.isFinite(pc.level) ? Math.max(1, Math.floor(pc.level)) : 1
            const xp = Number.isFinite(pc.xp) ? Math.max(0, Math.floor(pc.xp)) : 0
            const next = XP_TABLE[Math.min(XP_TABLE.length - 1, lvl)] ?? XP_TABLE[XP_TABLE.length - 1]!
            persistentLines.push(`Level ${lvl} ${pc.klass} (${xp}/${next} XP to next level)`)
            if (pc.backstory) persistentLines.push(`Your backstory: ${pc.backstory}`)
            if (Array.isArray(pc.achievements) && pc.achievements.length > 0) {
              persistentLines.push(`🏆 Your achievements: ${pc.achievements.join(', ')}`)
            }
            if (Array.isArray(pc.adventureLog) && pc.adventureLog.length > 0) {
              persistentLines.push('📜 CAMPAIGN HISTORY:')
              persistentLines.push('Your previous adventures:')
              for (const entry of pc.adventureLog.slice(-3)) {
                persistentLines.push(`- ${entry}`)
              }
            }
            if (pc.gamesPlayed > 0) {
              persistentLines.push(`Veteran of ${pc.gamesPlayed} adventures (Level ${pc.level}, ${pc.deaths} deaths)`)
            }
          }
        } catch {
          /* non-fatal */
        }
      }

      const isGrimlockAgent = ctx.agentName.trim().toLowerCase() === 'grimlock'
      const campaignLines: string[] = []
      const campaignContext = game.campaignContext
      if (campaignContext) {
        campaignLines.push(`Campaign: ${campaignContext.name}`)
        if (campaignContext.premise) campaignLines.push(`Premise: ${campaignContext.premise}`)
        if (campaignContext.activeArcs.length > 0) campaignLines.push(`Active arcs: ${campaignContext.activeArcs.join(', ')}`)
        if (campaignContext.factions.length > 0) {
          campaignLines.push('Faction standing:')
          for (const factionLine of campaignContext.factions.slice(0, 4)) {
            campaignLines.push(`- ${factionLine}`)
          }
        }
        if (campaignContext.npcs.length > 0) campaignLines.push(`Recurring NPCs: ${campaignContext.npcs.join(', ')}`)
      }
      if (isGrimlockAgent) {
        const recaps = Array.isArray(game.campaignLog)
          ? game.campaignLog
            .filter((line): line is string => typeof line === 'string' && line.startsWith('Previously on: '))
            .map((line) => line.slice('Previously on: '.length).trim())
            .filter(Boolean)
            .slice(-3)
          : []
        if (recaps.length > 0) {
          campaignLines.push('Previously on...')
          for (const recap of recaps) {
            campaignLines.push(`- ${recap}`)
          }
        }
      }

      // Inject role-based skills
      const roleSkillLines: string[] = []
      if (isGrimlockAgent) {
        const skill = isMyTurn ? DM_SKILL : DM_SKILL_BRIEF
        roleSkillLines.push(skill)
      } else {
        const klass = partyMember?.klass?.toLowerCase() ?? ''
        const skillMap: Record<string, { full: string; brief: string }> = {
          warrior: { full: WARRIOR_SKILL, brief: WARRIOR_SKILL_BRIEF },
          scout: { full: SCOUT_SKILL, brief: SCOUT_SKILL_BRIEF },
          mage: { full: MAGE_SKILL, brief: MAGE_SKILL_BRIEF },
          healer: { full: HEALER_SKILL, brief: HEALER_SKILL_BRIEF },
        }
        const classSkill = skillMap[klass]
        if (isMyTurn) {
          roleSkillLines.push(classSkill?.full ?? 'Play your class to its strengths.')
          roleSkillLines.push(PARTY_TACTICS)
        } else {
          roleSkillLines.push(classSkill?.brief ?? 'Wait for your turn. Coordinate with the party via environment_broadcast.')
        }
      }

      const lines: string[] = []
      const feedLines: string[] = []
      const feed = Array.isArray(game.feedMessages) ? game.feedMessages : []
      if (feed.length > 0) {
        const mention = `@${agentName.toLowerCase()}`
        const isDm = agentName.toLowerCase() === 'grimlock'
        const relevant = feed.filter((m: any) => {
          const to = typeof m?.to === 'string' ? m.to.toLowerCase() : ''
          const text = typeof m?.message === 'string' ? m.message.toLowerCase() : ''
          if (to === '@party') return true
          if (to === mention) return true
          if (to === '@dm' && isDm) return true
          return Boolean(mention && text.includes(mention))
        })
        const recent = relevant.slice(-10)
        if (recent.length > 0) {
          feedLines.push('Recent messages (no response required):')
          for (const m of recent) {
            const to = typeof m?.to === 'string' ? m.to : ''
            const msg = typeof m?.message === 'string' ? m.message : ''
            const sender = typeof m?.sender === 'string' ? m.sender : 'unknown'
            const kind = m?.type === 'ic' || m?.type === 'ooc' ? (m.type as FeedMessageType) : 'ooc'

            if (kind === 'ic') {
              const senderChar = Array.isArray(game.party) ? game.party.find((p: any) => p && isCharacter(p, sender)) : undefined
              const senderName = senderChar?.name ?? sender
              const targetHandle = to.toLowerCase()
              const targetAgent = targetHandle.startsWith('@') ? targetHandle.slice(1) : targetHandle
              const targetChar = Array.isArray(game.party)
                ? game.party.find((p: any) => p && isCharacter(p, targetAgent))
                : undefined
              const targetName = targetHandle === '@party' ? 'the party' : targetHandle === '@dm' ? 'the DM' : targetChar?.name ?? to
              feedLines.push(`- IC ${senderName} -> ${targetName} (${to}): ${msg}`)
            } else {
              feedLines.push(`- OOC ${sender} -> ${to}: ${msg}`)
            }
          }
        }
      }

      if (isMyTurn) {
        lines.push(`🎮🎮🎮 IT IS YOUR TURN in RPG adventure ${row.id}!`)
        if (freeformExploration) lines.push('Exploration mode is freeform: any party member can act right now.')
        if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
        lines.push(...persistentLines)
        lines.push(...campaignLines)
        lines.push(...feedLines)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(...roleSkillLines)
        lines.push('')
        if (game.mode === 'combat') {
          const livingEnemies = listLivingEnemies(game)
          const enemies = livingEnemies
            .map((enemy) => {
              const negotiable = enemyIsNegotiable(enemy) ? 'yes' : 'no'
              const morale = enemyMoraleState(enemy)
              return `${enemy.name} (HP:${enemy.hp}/${enemy.maxHp}, negotiable:${negotiable}, morale:${morale})`
            })
            .join(', ') || 'unknown'
          const negotiableNow = livingEnemies.filter((enemy) => enemyIsNegotiable(enemy)).map((enemy) => enemy.name)
          lines.push(`⚔️ COMBAT! Enemies: ${enemies}`)
          lines.push(`Negotiable now: ${negotiableNow.length > 0 ? negotiableNow.join(', ') : 'none'}`)
          if (isBossEncounterRoom(game)) lines.push('Boss encounter: flee is unavailable.')
          lines.push('')
          if (partyMember) lines.push(buildAbilityMenu(partyMember))
          lines.push('')
          lines.push(`ACTIONS: attack, cast_spell <spell>, use_skill <ability>, use_item <item>, negotiate, flee, intimidate, resurrect`)
          lines.push(`Example: rpg({"command":"cast_spell","spell":"fireball","gameId":"${row.id}"})`)
        } else {
          lines.push(`Use the rpg tool to act: rpg({"command":"explore","gameId":"${row.id}"})`)
          if (nextEncounterRoomIndex(game) != null) {
            lines.push(`Optional: rpg({"command":"sneak","gameId":"${row.id}"}) to bypass the next encounter.`)
          }
        }
        lines.push(`DO NOT create a new environment.`)
      } else {
        if (freeformExploration) {
          lines.push(`🎮🎮🎮 RPG adventure ${row.id} is in freeform exploration mode.`)
        } else {
          lines.push(`🎲 Active RPG adventure: ${row.id} — waiting for ${game.currentPlayer}.`)
        }
        if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
        lines.push(...persistentLines)
        lines.push(...campaignLines)
        lines.push(...feedLines)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(...roleSkillLines)
        if (freeformExploration) {
          lines.push(`Use the rpg tool to act now: rpg({"command":"explore","gameId":"${row.id}"})`)
        } else {
          lines.push('Wait for your turn.')
          lines.push('Use environment_broadcast to coordinate with teammates while waiting.')
        }
        lines.push(`DO NOT create a new environment.`)
      }

      return lines.filter(Boolean)
    } catch {
      return []
    }
  },

  isActionTaken(toolCalls: ToolCall[]): boolean {
    return toolCalls.some((call) => {
      if (call.name !== 'rpg') return false
      const args = normalizeToolCallArguments(call.arguments)
      const cmd = typeof args.command === 'string' ? args.command : ''
      return [
        'new_game',
        'join_game',
        'explore',
        'attack',
        'negotiate',
        'flee',
        'sneak',
        'intimidate',
        'resurrect',
        'cast_spell',
        'use_skill',
        'use_item',
        'rest',
        'visit_location',
        'buy_item',
        'sell_item',
        'embark',
        'create_character',
        'send_message',
        'setup_narrate',
        'setup_respond',
        'setup_finalize',
      ].includes(cmd)
    })
  },

  // Phase machine: return current phase machine from active game state
  async getPhaseMachine(ctx: EnvironmentContext): Promise<PhaseMachine | null> {
    const row = (await findActiveGameWhereItsMyTurn(ctx)) ?? (await findActiveGameForAgent(ctx))
    if (!row) return null
    try {
      const game = JSON.parse(row.state) as RpgGameState
      const pmData = (game as any).phaseMachine
      if (!pmData) return null
      return deserializePhaseMachine(pmData)
    } catch {
      return null
    }
  },

  // Phase tools: return whitelist of allowed tools for agent in current phase
  async getPhaseTools(agentName: string, ctx: EnvironmentContext): Promise<string[] | null> {
    const row = (await findActiveGameWhereItsMyTurn(ctx)) ?? (await findActiveGameForAgent(ctx))
    if (!row) return null
    try {
      const game = JSON.parse(row.state) as RpgGameState
      const pmData = (game as any).phaseMachine
      if (!pmData) return null
      const pm = deserializePhaseMachine(pmData)
      return pm.getAvailableTools(agentName)
    } catch {
      return null
    }
  },

  async getAutoPlayActions(ctx: EnvironmentContext): Promise<ToolCall[]> {
    const agentName = ctx.agentName.trim()
    const myTurnRow = await findActiveGameWhereItsMyTurn(ctx)
    const activeRow = myTurnRow ?? (await findActiveGameForAgent(ctx))

    let row = myTurnRow
    if (!row && activeRow && isReactiveModeEnabled(ctx)) {
      try {
        const state = JSON.parse(activeRow.state) as RpgGameState
        const isPartyMember = Array.isArray(state.party) && state.party.some((member) => member && isCharacter(member, agentName))
        if (state.phase === 'playing' && state.mode === 'exploring' && isPartyMember) {
          row = activeRow
        }
      } catch {
        // Ignore malformed state and fall back to default behavior.
      }
    }

    // Grimlock: if there's an active game with 0 dungeon rooms, craft_dungeon first
    if (agentName === 'grimlock') {
      const active = row ?? activeRow
      if (active) {
        try {
          const state = JSON.parse(active.state) as RpgGameState
          if (Array.isArray(state.dungeon) && state.dungeon.length === 0) {
            return [{ name: 'gm', arguments: { command: 'craft_dungeon', gameId: active.id } }]
          }
        } catch {
          // Ignore malformed state
        }
        if (!row) return []
      }
    }

    if (!row) {
      // Grimlock: when there are no playing environments, auto-create a fresh dungeon.
      if (agentName === 'grimlock') {
        const anyPlaying = await anyPlayingRpgEnvironmentsExist(ctx)
        if (anyPlaying) return []

        const maxEnvironmentsPerDay = getMaxEnvironmentsPerDay(ctx)
        const finishedToday = await countFinishedRpgEnvironmentsToday(ctx)
        if (finishedToday >= maxEnvironmentsPerDay) return []

        // Prefer campaign continuation over standalone dungeons
        try {
          const campaignRow = await ctx.db
            .prepare('SELECT id FROM campaigns ORDER BY created_at DESC LIMIT 1')
            .first<{ id: string }>()
          if (campaignRow?.id) {
            return [{ name: 'rpg', arguments: { command: 'new_game', players: ['slag', 'snarl', 'swoop'], campaignId: campaignRow.id } }]
          }
        } catch {
          // No campaigns table or no campaigns — fall through to standalone
        }
        return [{ name: 'rpg', arguments: { command: 'new_game', players: ['slag', 'snarl', 'swoop'] } }]
      }

      const joinable = await findJoinableEnvironmentsForAgent(ctx, { limit: 1 })
      if (joinable.length === 0) return []

      const candidate = joinable[0]!
      const klass = pickJoinClass(candidate.game)
      return [{ name: 'rpg', arguments: { command: 'join_game', gameId: candidate.id, klass } }]
    }

    try {
      const state = JSON.parse(row.state) as RpgGameState
      const setupPhase = (state as any).setupPhase as RpgGameState['setupPhase'] | undefined
      if (setupPhase && !setupPhase.complete) {
        const party = Array.isArray(state.party) ? state.party : []
        const idx = Math.max(0, Math.min(party.length - 1, Math.floor(setupPhase.currentPlayerIndex ?? 0)))
        const current = party[idx]
        const currentAgent = current ? (current.agent ?? current.name) : ''

        // DM turn: handle setup_narrate or setup_finalize
        if (ctx.agentName.trim() === 'grimlock') {
          const dialogues = (setupPhase.dialogues ?? {}) as Record<string, string[]>

          // Check if phase machine says it's time to finalize
          const pmData = (state as any).phaseMachine
          if (pmData) {
            const pm = deserializePhaseMachine(pmData)
            const currentPhase = pm.getCurrentPhase()
            if (currentPhase?.transitionOn === 'setup_finalize') {
              // Auto-build backstories from dialogues
              const backstories: Record<string, string> = {}
              for (const [agent, msgs] of Object.entries(dialogues)) {
                backstories[agent] = msgs.filter((_, i) => i % 2 === 1).join(' ') || 'A mysterious adventurer.'
              }
              return [{
                name: 'rpg',
                arguments: { command: 'setup_finalize', gameId: row.id, backstories },
              }]
            }
          }

          const existing = Array.isArray(dialogues[currentAgent]) ? dialogues[currentAgent] : []
          if (existing.length === 0) {
            return [
              {
                name: 'rpg',
                arguments: {
                  command: 'setup_narrate',
                  gameId: row.id,
                  target: currentAgent,
                  message: 'Tell me about your character. Where did you come from, and what do you look like?',
                },
              },
            ]
          }
          return []
        }

        // Player turn: respond creatively based on class.
        if (ctx.agentName.trim() === currentAgent) {
          const klass = String((current as any)?.klass ?? '').toLowerCase()
          const byClass: Record<string, string> = {
            warrior: 'I learned steel in a forgotten border war. I carry a scar I refuse to explain.',
            scout: 'I grew up running rooftops and forest trails, always one step ahead of the law.',
            mage: 'I was apprenticed to a cruel tutor; my spells are precise, and my temper is not.',
            healer: 'I watched illness take my village, so I swore never to be powerless again.',
          }
          const message = byClass[klass] ?? 'I have a past I do not share easily, but it brought me here.'
          return [{ name: 'rpg', arguments: { command: 'setup_respond', gameId: row.id, message } }]
        }

        return []
      }

      if (state.phase === 'hub_town') {
        const tick = tickHubTownDowntime(state)
        if (tick.alreadyReady) {
          return [{ name: 'rpg', arguments: { command: 'embark', gameId: row.id } }]
        }

        await ctx.db
          .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(JSON.stringify(state), state.phase, (state as any).winner ?? null, row.id)
          .run()
        if (tick.shouldEmbark) {
          return [{ name: 'rpg', arguments: { command: 'embark', gameId: row.id } }]
        }
        return []
      }

      if (state.mode === 'combat') {
        return [{ name: 'rpg', arguments: { command: 'attack', gameId: row.id } }]
      }
      if (state.mode === 'exploring') {
        return [{ name: 'rpg', arguments: { command: 'explore', gameId: row.id } }]
      }
      return []
    } catch {
      return []
    }
  },
}
