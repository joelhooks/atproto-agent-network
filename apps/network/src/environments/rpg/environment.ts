import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../../packages/core/src/identity'

import {
  awardXp,
  type Character,
  type Enemy,
  cloneEnemiesForCombat,
  createCharacter,
  createDice,
  createGame,
  describeRoom,
  explore,
  findIntimidatableEnemies,
  gameCharacterToPersistent,
  generateFantasyName,
  gmInterveneIfStuck,
  isBossEncounterRoom,
  livingParty,
  markCharacterDeath,
  type Skills,
  partyWipe,
  partyAverageLevel,
  persistentToGameCharacter,
  recordNarrativeBeat,
  resolveSkillCheck,
  soloMultiplier,
  type RpgClass,
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
  resolveSpell,
  resolveAbility,
  SPELLS,
  ABILITIES,
} from '../../games/rpg-engine'
import {
  advanceTurn as advanceTurnSystem,
  computeInitiativeOrder as computeInitiativeOrderSystem,
  normalizeTurnState as normalizeTurnStateSystem,
  recomputeTurnOrder as recomputeTurnOrderSystem,
} from './systems/turn-manager'
import {
  addLoggedXp as addLoggedXpSystem,
  addXpEarned as addXpEarnedSystem,
  awardBarrierClearMilestoneXp as awardBarrierClearMilestoneXpSystem,
  awardAdventureCompleteXp as awardAdventureCompleteXpSystem,
  awardKillXp as awardKillXpSystem,
  awardRoomClearXp as awardRoomClearXpSystem,
  calculateEncounterXp as calculateEncounterXpSystem,
} from './systems/xp-system'
import {
  ensureCharacterLootState as ensureCharacterLootStateSystem,
  makeShopHealingPotion as makeShopHealingPotionSystem,
  maybeAwardEnemyDrop as maybeAwardEnemyDropSystem,
  normalizePartyLootState as normalizePartyLootStateSystem,
  resolveTreasureLoot as resolveTreasureLootSystem,
} from './systems/loot-system'
import {
  runEnemyFreeAttackRound as runEnemyFreeAttackRoundSystem,
} from './systems/combat-resolver'
import {
  buyFromHubTownMarket as buyFromHubTownMarketSystem,
  buildHubTownNarration as buildHubTownNarrationSystem,
  countHubTownIdleTurn as countHubTownIdleTurnSystem,
  ensureHubTownState as ensureHubTownStateSystem,
  HUB_TOWN_LOCATIONS as HUB_TOWN_LOCATIONS_SYSTEM,
  HUB_TOWN_LOCATION_LABEL as HUB_TOWN_LOCATION_LABEL_SYSTEM,
  resetHubTownIdle as resetHubTownIdleSystem,
  sellToHubTownMarket as sellToHubTownMarketSystem,
  transitionCampaignCompletionToHubTown as transitionCampaignCompletionToHubTownSystem,
  visitHubTownLocation as visitHubTownLocationSystem,
} from './systems/hub-town'

import type { PersistentCharacter } from '@atproto-agent/core'

import type { AgentEnvironment, EnvironmentContext, ToolCall } from '../types'
import type { PhaseMachine } from '../phase-machine'
import type { CampaignPatch, CreateCampaignOptions } from './interfaces'
import { createRpgSetupPhaseMachine, serializePhaseMachine, deserializePhaseMachine } from '../phase-machine'
import {
  createReactiveGameEventEmitter,
  emitReactiveSignals,
  isReactiveModeEnabled,
  type ReactiveStateSnapshot,
} from './events/game-events'
import {
  buildDefaultStoryArcs,
  buildDefaultWorldState,
  formatFactionStandingLine,
  normalizeCreateCampaignOptions,
  normalizeStoryArcs,
  normalizeWorldState,
  parseCampaignAdventureCount,
  worldStateWithoutMeta,
} from './campaign/normalizers'
import { rowToCampaignState, serializeWorldState, type CampaignRow } from './campaign/serialization'
import {
  buildCampaignDungeonThread,
  resolveStoryArcsForAdventureOutcome,
  type CampaignDungeonObjective,
  applyDispositionForEncounterOutcome,
} from './campaign/campaign-logic'
import { executeCombatCommand } from './commands/combat-commands'
import { executeExplorationCommand } from './commands/exploration-commands'
import { executeHubTownCommand } from './commands/hub-town-commands'
import { executeLifecycleCommand } from './commands/lifecycle-commands'
import { executeSocialCommand } from './commands/social-commands'
import {
  buildContext as buildRpgContext,
  findActiveGameForAgent,
  findActiveGameWhereItsMyTurn,
  summarizeParty,
} from './context-builder'
import { getAutoPlayActions as getRpgAutoPlayActions } from './auto-play'
export {
  applyDispositionForEncounterOutcome,
  buildCampaignDungeonThread,
  resolveStoryArcsForAdventureOutcome,
  type CampaignDungeonObjective,
} from './campaign/campaign-logic'

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

  // ☠️ PERMADEATH: agents whose characters died get their DO deleted.
  // Real stakes — death in the dungeon means death in the cloud.
  if (ctx.onPermadeath && Array.isArray(game.party)) {
    const fallen = game.party.filter((p) => (p?.hp ?? 0) <= 0 && p?.agent)
    for (const dead of fallen) {
      const agentName = (dead.agent ?? '').trim()
      if (!agentName) continue
      // Don't delete the DM (grimlock)
      if (agentName === ctx.agentName) continue
      console.log(JSON.stringify({
        event_type: 'permadeath',
        level: 'warn',
        agent: agentName,
        character: dead.name,
        cause: dead.deathCause ?? 'unknown',
        gameId,
      }))
      try {
        await ctx.onPermadeath(agentName)
      } catch (err) {
        console.log(JSON.stringify({
          event_type: 'permadeath.failed',
          level: 'error',
          agent: agentName,
          error: String(err),
        }))
      }
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
        const gameEventEmitter = createReactiveGameEventEmitter(ctx, game, {
          emitEnvironmentCompleted,
        })

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
          if (socialResult) {
            try { await ctx.broadcast({ event_type: 'env.rpg.setup', gameId, agent: ctx.agentName, command, phase: game.phase, setupPhase: (game as any).setupPhase?.currentStep ?? null }) } catch {}
            return socialResult
          }
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
          try { await ctx.broadcast({ event_type: 'env.rpg.action', gameId, agent: agentName, command, phase: game.phase, mode: game.mode, currentPlayer: game.currentPlayer, roomIndex: game.roomIndex, round: game.round }) } catch {}
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
          try { await ctx.broadcast({ event_type: 'env.rpg.action', gameId, agent: agentName, command, phase: game.phase, mode: game.mode, currentPlayer: game.currentPlayer, roomIndex: game.roomIndex, round: game.round }) } catch {}
          return combatResult
        }

        throw new Error(`Unknown rpg command: ${command}`)
      },
    }
  },

  async buildContext(ctx: EnvironmentContext): Promise<string[]> {
    return buildRpgContext(ctx, { isCharacter, isReactiveModeEnabled })
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
    return getRpgAutoPlayActions(ctx, { isCharacter, isReactiveModeEnabled })
  },
}
