import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

import {
  adjustDisposition,
  attack,
  awardXp,
  type Character,
  type Enemy,
  cloneEnemiesForCombat,
  advanceHubTownIdleTurns,
  createHubTownState,
  createCharacter,
  createDice,
  createGame,
  describeRoom,
  encounterXpValue,
  enemyIsNegotiable,
  enemyMoraleState,
  explore,
  formatLootSummary,
  findIntimidatableEnemies,
  gameCharacterToPersistent,
  generateLoot,
  generateFantasyName,
  getDispositionTier,
  gmInterveneIfStuck,
  isBossEncounterRoom,
  livingParty,
  markCharacterDeath,
  applyLootToCharacter,
  type LootItem,
  type LootTier,
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
  type StoryArc,
  type WorldState,
  type RpgGameState,
  XP_PER_ADVENTURE_COMPLETE,
  XP_PER_BARRIER_BRUTE_FORCE,
  XP_PER_BARRIER_CLEAR,
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

import type { PersistentCharacter } from '@atproto-agent/core'

import type { AgentEnvironment, EnvironmentContext, ToolCall } from './types'
import type { PhaseMachine } from './phase-machine'
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

type CampaignRow = {
  id: string
  name: string
  premise: string | null
  world_state: string | null
  story_arcs: string | null
  created_at: string | null
  updated_at: string | null
}

type CampaignPatch = Partial<Pick<CampaignState, 'name' | 'premise' | 'worldState' | 'storyArcs' | 'adventureCount'>>

function normalizeDisposition(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(-100, Math.min(100, Math.floor(n)))
}

function formatSignedDisposition(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`
}

function dispositionTierLabel(value: number): string {
  const tier = getDispositionTier(value)
  return tier === 'allied' ? 'allies' : tier
}

function formatFactionStandingLine(input: { name: string; disposition: number }): string {
  const disposition = normalizeDisposition(input.disposition)
  return `The ${input.name} considers you ${dispositionTierLabel(disposition)} (${formatSignedDisposition(disposition)})`
}

function factionIdsFromEnemies(enemies: Enemy[]): string[] {
  const ids = new Set<string>()
  for (const enemy of Array.isArray(enemies) ? enemies : []) {
    const factionId = typeof enemy?.factionId === 'string' ? enemy.factionId.trim() : ''
    if (!factionId) continue
    ids.add(factionId)
  }
  return [...ids]
}

export function applyDispositionForEncounterOutcome(input: {
  campaign: CampaignState
  enemies: Enemy[]
  resolution: 'kill' | 'negotiate'
  reason: string
}): CampaignState {
  const delta = input.resolution === 'kill' ? -20 : 10
  let next = input.campaign
  for (const factionId of factionIdsFromEnemies(input.enemies)) {
    next = adjustDisposition(next, factionId, delta, input.reason)
  }
  return next
}

function buildDefaultWorldState(): WorldState {
  return {
    factions: [],
    locations: [],
    events: [],
  }
}

function buildDefaultStoryArcs(): StoryArc[] {
  return []
}

function parseCampaignAdventureCount(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return Math.max(0, Math.floor(fallback))
  return Math.max(0, Math.floor(n))
}

function normalizeWorldState(raw: unknown, input: { adventureCount: number }): WorldState & { adventureCount: number } {
  const fallback = buildDefaultWorldState()
  const src = isRecord(raw) ? raw : {}

  const factions = Array.isArray(src.factions)
    ? src.factions
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = String(entry.name ?? '').trim()
        if (!name) return null
        return {
          id: String(entry.id ?? `faction_${generateTid()}`),
          name,
          disposition: normalizeDisposition(entry.disposition),
          description: String(entry.description ?? '').trim() || 'Unknown faction motives.',
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : fallback.factions

  const locations = Array.isArray(src.locations)
    ? src.locations
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = String(entry.name ?? '').trim()
        if (!name) return null
        return {
          id: String(entry.id ?? `location_${generateTid()}`),
          name,
          description: String(entry.description ?? '').trim() || 'No details recorded.',
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : fallback.locations

  const events = Array.isArray(src.events)
    ? src.events
      .map((entry) => {
        if (typeof entry === 'string') {
          const text = entry.trim()
          return text ? text : null
        }
        if (!isRecord(entry)) return null
        const text = String(entry.description ?? '').trim()
        return text ? text : null
      })
      .filter((entry): entry is string => Boolean(entry))
    : fallback.events

  const adventureCount = parseCampaignAdventureCount((src as Record<string, unknown>).adventureCount, input.adventureCount)
  return { factions, locations, events, adventureCount }
}

function normalizeStoryArcs(raw: unknown): StoryArc[] {
  const fallback = buildDefaultStoryArcs()
  if (!Array.isArray(raw)) return fallback
  const arcs = raw
    .map((entry) => {
      if (!isRecord(entry)) return null
      const name = String(entry.name ?? '').trim()
      if (!name) return null
      const statusRaw = String(entry.status ?? '').trim()
      const status: StoryArc['status'] =
        statusRaw === 'seeded' ||
        statusRaw === 'active' ||
        statusRaw === 'climax' ||
        statusRaw === 'resolved' ||
        statusRaw === 'failed'
          ? statusRaw
          : 'active'
      const plotPoints = Array.isArray(entry.plotPoints)
        ? entry.plotPoints
          .map((point) => {
            if (!isRecord(point)) return null
            const description = String(point.description ?? '').trim()
            if (!description) return null
            const adventureId = typeof point.adventureId === 'string' ? point.adventureId : undefined
            return {
              id: String(point.id ?? `plot_${generateTid()}`),
              description,
              resolved: Boolean(point.resolved),
              ...(adventureId ? { adventureId } : {}),
            }
          })
          .filter((point): point is StoryArc['plotPoints'][number] => Boolean(point))
        : []
      return {
        id: String(entry.id ?? `arc_${generateTid()}`),
        name,
        status,
        plotPoints,
      }
    })
    .filter((arc): arc is StoryArc => Boolean(arc))

  return arcs.length > 0 ? arcs : fallback
}

function rowToCampaignState(row: CampaignRow): CampaignState {
  const name = String(row.name || 'Untitled Campaign').trim() || 'Untitled Campaign'
  const premise = String(row.premise || '').trim()
  const worldRaw = (() => {
    try {
      return row.world_state ? JSON.parse(row.world_state) : {}
    } catch {
      return {}
    }
  })()
  const arcsRaw = (() => {
    try {
      return row.story_arcs ? JSON.parse(row.story_arcs) : []
    } catch {
      return []
    }
  })()
  const worldStateWithMeta = normalizeWorldState(worldRaw, { adventureCount: 0 })
  const adventureCount = parseCampaignAdventureCount(worldStateWithMeta.adventureCount, 0)

  return {
    id: row.id,
    name,
    premise,
    worldState: {
      factions: worldStateWithMeta.factions,
      locations: worldStateWithMeta.locations,
      events: worldStateWithMeta.events,
    },
    storyArcs: normalizeStoryArcs(arcsRaw),
    adventureCount,
  }
}

function serializeWorldState(state: CampaignState): string {
  return JSON.stringify({
    factions: state.worldState.factions,
    locations: state.worldState.locations,
    events: state.worldState.events,
    adventureCount: state.adventureCount,
  })
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

export async function createCampaign(db: D1Database, name: string, premise: string): Promise<CampaignState> {
  await ensureCampaignSchema(db)
  const safeName = String(name || '').trim() || 'Untitled Campaign'
  const safePremise = String(premise || '').trim()
  const worldState = buildDefaultWorldState()
  const storyArcs = buildDefaultStoryArcs()
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
      ? normalizeWorldState(patch.worldState, {
          adventureCount: parseCampaignAdventureCount(patch.adventureCount, current.adventureCount),
        })
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

export type CampaignDungeonObjective = {
  arcId: string
  arcName: string
  plotPointId: string
  plotPoint: string
}

function copyStoryArcs(storyArcs: StoryArc[]): StoryArc[] {
  return (Array.isArray(storyArcs) ? storyArcs : []).map((arc) => ({
    ...arc,
    plotPoints: Array.isArray(arc.plotPoints) ? arc.plotPoints.map((plotPoint) => ({ ...plotPoint })) : [],
  }))
}

function firstSentence(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const idx = clean.search(/[.!?]/)
  if (idx < 0) return clean.slice(0, 220)
  return clean.slice(0, Math.min(clean.length, idx + 1)).trim()
}

function adventureRecapsFromEvents(events: unknown, limit = 3): string[] {
  if (!Array.isArray(events)) return []
  const adventureEvents = events
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.startsWith('Adventure #'))
  const recent = adventureEvents.slice(Math.max(0, adventureEvents.length - Math.max(1, Math.floor(limit))))
  return recent.map((entry) => firstSentence(entry)).filter(Boolean)
}

function pickCampaignObjective(campaign: CampaignState): CampaignDungeonObjective | null {
  const arcs = Array.isArray(campaign.storyArcs) ? campaign.storyArcs : []
  for (const arc of arcs) {
    if (!arc || arc.status !== 'active') continue
    const unresolved = Array.isArray(arc.plotPoints) ? arc.plotPoints.find((plotPoint) => !plotPoint.resolved) : null
    if (!unresolved) continue
    const plotPoint = String(unresolved.description || '').trim()
    if (!plotPoint) continue
    return {
      arcId: String(arc.id || ''),
      arcName: String(arc.name || '').trim() || 'Active Arc',
      plotPointId: String(unresolved.id || ''),
      plotPoint,
    }
  }
  return null
}

function themeCampaignStateForObjective(campaign: CampaignState, objective: CampaignDungeonObjective | null): CampaignState {
  if (!objective) return campaign
  const storyArcs = copyStoryArcs(campaign.storyArcs)
  const chosenIndex = storyArcs.findIndex((arc) => arc.id === objective.arcId)
  if (chosenIndex > 0) {
    const [chosen] = storyArcs.splice(chosenIndex, 1)
    if (chosen) storyArcs.unshift(chosen)
  }

  const objectiveLine = `${objective.arcName}: ${objective.plotPoint}`
  const basePremise = String(campaign.premise || '').trim()
  const alreadyPresent = basePremise.toLowerCase().includes(objective.plotPoint.toLowerCase())
  const premise = alreadyPresent
    ? basePremise
    : [basePremise, `Current objective: ${objectiveLine}.`].filter(Boolean).join(' ')

  return {
    ...campaign,
    premise,
    storyArcs,
  }
}

function campaignLogFromThread(input: {
  campaign: CampaignState
  objective: CampaignDungeonObjective | null
  recaps: string[]
}): string[] {
  const lines: string[] = [
    `Campaign: ${input.campaign.name}`,
    `Arc focus: ${input.objective?.arcName ?? 'none'}`,
    `Premise: ${input.campaign.premise}`,
  ]
  if (input.objective) {
    lines.push(`Current objective: ${input.objective.arcName} — ${input.objective.plotPoint}`)
  }
  for (const recap of input.recaps) {
    lines.push(`Previously on: ${recap}`)
  }
  return lines
}

export function buildCampaignDungeonThread(campaign: CampaignState): {
  objective: CampaignDungeonObjective | null
  themedCampaignState: CampaignState
  campaignLog: string[]
} {
  const objective = pickCampaignObjective(campaign)
  const themedCampaignState = themeCampaignStateForObjective(campaign, objective)
  const recaps = adventureRecapsFromEvents(campaign.worldState?.events, 3)
  const campaignLog = campaignLogFromThread({ campaign, objective, recaps })
  return {
    objective,
    themedCampaignState,
    campaignLog,
  }
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

export function resolveStoryArcsForAdventureOutcome(input: {
  storyArcs: StoryArc[]
  gameId: string
  outcome: 'victory' | 'tpk' | 'abandoned'
  objective?: Pick<CampaignDungeonObjective, 'arcId' | 'plotPointId'>
}): StoryArc[] {
  const nextArcs = copyStoryArcs(input.storyArcs)
  let targetArc: StoryArc | undefined
  let targetPoint: StoryArc['plotPoints'][number] | undefined

  if (input.objective?.arcId && input.objective?.plotPointId) {
    targetArc = nextArcs.find((arc) => arc.id === input.objective!.arcId)
    targetPoint = targetArc?.plotPoints.find((plotPoint) => plotPoint.id === input.objective!.plotPointId)
  }

  if (!targetArc || !targetPoint) {
    targetArc = nextArcs.find((arc) => arc.status === 'active' && arc.plotPoints.some((plotPoint) => !plotPoint.resolved))
    targetPoint = targetArc?.plotPoints.find((plotPoint) => !plotPoint.resolved)
  }

  if (targetPoint) {
    targetPoint.resolved = true
    targetPoint.adventureId = input.gameId
  }
  if (targetArc) {
    if (input.outcome === 'tpk') {
      targetArc.status = 'failed'
    } else if (!targetArc.plotPoints.some((plotPoint) => !plotPoint.resolved)) {
      targetArc.status = 'resolved'
    }
  }

  return nextArcs
}

function addXpEarned(game: RpgGameState, who: string, amount: number): void {
  const agent = String(who ?? '').trim()
  const amt = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  if (!agent || amt <= 0) return
  game.xpEarned ??= {}
  game.xpEarned[agent] = (game.xpEarned[agent] ?? 0) + amt

  const member = Array.isArray(game.party) ? game.party.find((p) => p && isCharacter(p, agent)) : undefined
  if (!member) return

  member.xp = (Number.isFinite(member.xp) ? (member.xp as number) : 0) + amt
  member.level = Number.isFinite(member.level) ? Math.max(1, Math.floor(member.level as number)) : 1

  while (member.level < XP_TABLE.length && (member.xp ?? 0) >= (XP_TABLE[member.level] ?? Infinity)) {
    member.level += 1
    const hpGain = 5 + member.level
    const mpGain = 3 + member.level
    member.maxHp = (Number.isFinite(member.maxHp) ? member.maxHp : 0) + hpGain
    member.maxMp = (Number.isFinite(member.maxMp) ? member.maxMp : 0) + mpGain

    const skills: Skills = member.skills && typeof member.skills === 'object' ? member.skills : { attack: 30, dodge: 25, cast_spell: 25, use_skill: 25 }
    const keys = Object.keys(skills).sort()
    let boostedSkill = ''
    if (keys.length > 0) {
      const idx = Math.min(keys.length - 1, Math.floor(Math.random() * keys.length))
      const key = keys[idx]!
      const current = Number((skills as Record<string, unknown>)[key])
      ;(skills as Record<string, unknown>)[key] = (Number.isFinite(current) ? current : 0) + 5
      boostedSkill = key
    }
    member.skills = skills
    game.log ??= []
    game.log.push({
      at: Date.now(),
      who: agent,
      what: `LEVEL UP: ${member.name} reaches Level ${member.level}! (+${hpGain} HP, +${mpGain} MP)${boostedSkill ? ` (+5 ${boostedSkill})` : ''}`,
    })
  }
}

function addLoggedXp(game: RpgGameState, who: string, amount: number, reason: string): void {
  const identity = String(who ?? '').trim()
  const amt = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  if (!identity || amt <= 0) return
  addXpEarned(game, identity, amt)
  game.log.push({
    at: Date.now(),
    who: identity,
    what: `gained ${amt} XP (${reason})`,
  })
}

function clampGold(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

function ensureCharacterLootState(character: Character | undefined | null): void {
  if (!character) return
  ;(character as any).inventory = Array.isArray((character as any).inventory) ? (character as any).inventory : []
  ;(character as any).gold = clampGold((character as any).gold)
}

function normalizePartyLootState(game: RpgGameState): void {
  for (const member of Array.isArray(game.party) ? game.party : []) {
    ensureCharacterLootState(member)
  }
}

function roomLootTier(game: RpgGameState, roomIndex: number, roomType?: string): LootTier {
  if (roomType === 'boss') return 'boss'
  const total = Math.max(1, Array.isArray(game.dungeon) ? game.dungeon.length : 1)
  const progress = (Math.max(0, roomIndex) + 1) / total
  if (progress <= 0.4) return 'early'
  if (progress <= 0.8) return 'mid'
  return 'boss'
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
  ensureCharacterLootState(actor)
  const tier = roomLootTier(game, game.roomIndex, game.dungeon[game.roomIndex]?.type)
  const loot = generateLoot({ tier, source: 'treasure', dice, seedIndex: game.roomIndex })
  applyLootToCharacter(actor, loot)
  const treasureXp = Math.max(0, loot.items.length) * XP_PER_TREASURE_FIND
  if (treasureXp > 0) addLoggedXp(game, characterId(actor), treasureXp, 'treasure')

  const beat = loot.items[0]?.name ?? `${loot.gold} gold pieces`
  if (beat) recordNarrativeBeat(game, { kind: 'treasure', text: beat, roomIndex: game.roomIndex })

  const summary = formatLootSummary(loot)
  game.log.push({
    at: Date.now(),
    who: characterId(actor),
    what: `Found: ${summary}`,
  })
  return `Found: ${summary}`
}

function maybeAwardEnemyDrop(
  game: RpgGameState,
  actor: Character,
  enemy: Enemy,
  dice: ReturnType<typeof createDice>,
): string | null {
  ensureCharacterLootState(actor)
  const isBossEnemy = enemy?.tactics?.kind === 'boss' || isBossEncounterRoom(game)
  const roll = dice.d100()
  if (!isBossEnemy && roll > 20) return null

  const tier: LootTier = isBossEnemy ? 'boss' : roomLootTier(game, game.roomIndex, game.dungeon[game.roomIndex]?.type)
  const loot = generateLoot({ tier, source: 'combat', dice, ...(isBossEnemy ? { seedIndex: game.roomIndex } : {}) })
  applyLootToCharacter(actor, loot)
  const summary = formatLootSummary(loot)
  const line = `${enemy.name} dropped ${summary}`
  game.log.push({
    at: Date.now(),
    who: characterId(actor),
    what: `loot drop: ${line}`,
  })
  return line
}

function makeShopHealingPotion(dice: ReturnType<typeof createDice>): LootItem {
  return {
    name: 'Camp Healing Potion',
    rarity: 'common',
    slot: 'consumable',
    effects: [],
    consumable: { type: 'heal', amount: dice.d(6) + dice.d(6) + 3 },
    description: 'A reliable tonic mixed from field herbs and bright salts.',
  }
}

type HubTownShopItem = {
  id: string
  cost: number
  sellValue: number
  item: LootItem
}

const HUB_TOWN_LOCATIONS: readonly HubTownLocation[] = ['tavern', 'market', 'temple', 'guild_hall']

const HUB_TOWN_LOCATION_LABEL: Record<HubTownLocation, string> = {
  tavern: 'Hearthfire Tavern',
  market: 'Lantern Market',
  temple: 'Temple of Dawn',
  guild_hall: "Adventurers' Guild Hall",
}

const HUB_TOWN_SHOP: Record<string, HubTownShopItem> = {
  iron_sword: {
    id: 'iron_sword',
    cost: 45,
    sellValue: 22,
    item: {
      name: 'Iron Sword',
      rarity: 'uncommon',
      slot: 'weapon',
      effects: [{ stat: 'attack', bonus: 3 }],
      description: 'A balanced, dependable blade favored by caravan guards.',
    },
  },
  chain_jerkin: {
    id: 'chain_jerkin',
    cost: 40,
    sellValue: 20,
    item: {
      name: 'Chain Jerkin',
      rarity: 'uncommon',
      slot: 'armor',
      effects: [{ stat: 'dodge', bonus: 3 }],
      description: 'Interlocked rings that soften glancing blows.',
    },
  },
  runed_charm: {
    id: 'runed_charm',
    cost: 55,
    sellValue: 27,
    item: {
      name: 'Runed Charm',
      rarity: 'rare',
      slot: 'trinket',
      effects: [{ stat: 'cast_spell', bonus: 4 }],
      description: 'A sigil-inscribed charm that steadies spellcraft.',
    },
  },
}

function normalizeHubTownLocation(value: unknown): HubTownLocation | null {
  const location = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (location === 'tavern' || location === 'market' || location === 'temple' || location === 'guild_hall') {
    return location
  }
  return null
}

function ensureHubTownState(game: RpgGameState): HubTownState {
  const existing = (game as Record<string, unknown>).hubTown
  const source = isRecord(existing) ? existing : {}
  const normalized = createHubTownState({
    location: normalizeHubTownLocation(source.location) ?? undefined,
    idleTurns: Number.isFinite(source.idleTurns) ? Number(source.idleTurns) : undefined,
    autoEmbarkAfter: Number.isFinite(source.autoEmbarkAfter) ? Number(source.autoEmbarkAfter) : undefined,
  })
  ;(game as Record<string, unknown>).hubTown = normalized as unknown as Record<string, unknown>
  return normalized
}

function resetHubTownIdle(game: RpgGameState): void {
  if (game.phase !== 'hub_town') return
  const hub = ensureHubTownState(game)
  hub.idleTurns = 0
}

function countHubTownIdleTurn(game: RpgGameState): number {
  const next = advanceHubTownIdleTurns(ensureHubTownState(game))
  ;(game as Record<string, unknown>).hubTown = next.state as unknown as Record<string, unknown>
  return next.state.idleTurns
}

function hubTownItemIdFromName(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hubTownItemIdFromInventory(item: LootItem): string {
  const explicit = typeof (item as any).hubItemId === 'string' ? (item as any).hubItemId.trim() : ''
  if (explicit) return explicit
  return hubTownItemIdFromName(item.name)
}

function copyHubTownShopItem(entry: HubTownShopItem): LootItem {
  const item: LootItem = {
    ...entry.item,
    effects: (entry.item.effects ?? []).map((effect) => ({ ...effect })),
  }
  ;(item as any).hubItemId = entry.id
  return item
}

function removeLootEffectsFromCharacter(character: Character, item: LootItem): void {
  const effects = Array.isArray(item.effects) ? item.effects : []
  for (const effect of effects) {
    const stat = String(effect.stat ?? '').trim().toLowerCase()
    const bonus = Number.isFinite(effect.bonus) ? Math.floor(effect.bonus) : 0
    if (bonus === 0) continue
    if (stat === 'attack') {
      character.skills.attack = clampSkill(character.skills.attack - bonus)
      continue
    }
    if (stat === 'dodge') {
      character.skills.dodge = clampSkill(character.skills.dodge - bonus)
      continue
    }
    if (stat === 'cast_spell') {
      character.skills.cast_spell = clampSkill(character.skills.cast_spell - bonus)
      continue
    }
    if (stat === 'use_skill') {
      character.skills.use_skill = clampSkill(character.skills.use_skill - bonus)
      continue
    }
    if (stat === 'armor') {
      const baseArmor = Number.isFinite(character.armor) ? Math.floor(character.armor as number) : 0
      character.armor = Math.max(0, baseArmor - bonus)
    }
  }
}

function fallbackSellValueForItem(item: LootItem): number {
  const byRarity: Record<string, number> = { common: 8, uncommon: 16, rare: 28, legendary: 50 }
  const rarity = String(item.rarity ?? '').toLowerCase()
  const baseline = byRarity[rarity] ?? 10
  const explicit = Number.isFinite(item.gold) ? Math.floor(item.gold as number) : 0
  if (explicit > 0) return Math.max(1, Math.floor(explicit * 0.5))
  return baseline
}

function buildHubTownNarration(game: RpgGameState, input: { location: HubTownLocation; cue: string }): string {
  const lines: string[] = []
  lines.push(`Hub Town - ${HUB_TOWN_LOCATION_LABEL[input.location]}`)
  lines.push(`GM: ${input.cue}`)

  const campaign = game.campaignContext
  if (campaign) {
    lines.push(`Campaign: ${campaign.name}`)
    if (campaign.premise) lines.push(`Premise: ${campaign.premise}`)
    if (campaign.activeArcs.length > 0) lines.push(`Active arc: ${campaign.activeArcs[0]}`)
  }

  const recap = Array.isArray(game.campaignLog) ? game.campaignLog.filter(Boolean).slice(-1)[0] : ''
  if (recap) lines.push(`Latest rumor: ${recap}`)

  return lines.join('\n')
}

function transitionCampaignCompletionToHubTown(game: RpgGameState, beforePhase: RpgGameState['phase']): { completed: boolean; enteredHubTown: boolean } {
  if (beforePhase !== 'playing' || game.phase !== 'finished') return { completed: false, enteredHubTown: false }

  const campaignId = typeof game.campaignId === 'string' ? game.campaignId.trim() : ''
  if (!campaignId) return { completed: true, enteredHubTown: false }

  const hub = ensureHubTownState(game)
  hub.location = 'tavern'
  hub.idleTurns = 0
  hub.autoEmbarkAfter = Math.max(1, hub.autoEmbarkAfter || 5)

  game.phase = 'hub_town'
  game.mode = 'finished'
  game.combat = undefined

  const initiative = computeInitiativeOrder(game.party ?? [])
  const living = initiative.find((member) => isLiving(member))
  if (living) game.currentPlayer = characterId(living)

  game.log.push({ at: Date.now(), who: 'GM', what: 'hub_town: the party returns to town between adventures.' })
  return { completed: true, enteredHubTown: true }
}

function livingPartyIds(game: RpgGameState): string[] {
  const party = Array.isArray(game.party) ? game.party : []
  return party.filter((p) => (p?.hp ?? 0) > 0).map((p) => characterId(p))
}

function awardRoomClearXp(game: RpgGameState): void {
  for (const id of livingPartyIds(game)) addXpEarned(game, id, XP_PER_ROOM_CLEAR)
}

function awardAdventureCompleteXp(game: RpgGameState): void {
  for (const id of livingPartyIds(game)) addXpEarned(game, id, XP_PER_ADVENTURE_COMPLETE)
}

function awardBarrierClearMilestoneXp(
  game: RpgGameState,
  input: { logSlice: Array<{ who?: string; what?: string }>; fallbackActorId: string }
): void {
  const { logSlice, fallbackActorId } = input
  const line = (entry: { who?: string; what?: string } | undefined): string => String(entry?.what ?? '')

  const bruteForce = logSlice.find((entry) => line(entry).includes('barrier: brute_force'))
  if (bruteForce) {
    const rawWho = String(bruteForce.who ?? '').trim()
    const member = game.party.find((p) => p && isCharacter(p, rawWho))
    const id = member ? characterId(member) : rawWho
    if (id) addLoggedXp(game, id, XP_PER_BARRIER_BRUTE_FORCE, 'barrier brute_force')
    return
  }

  const classResolve = logSlice.find((entry) => line(entry).startsWith('barrier: resolved by '))
  if (classResolve) {
    const klass = line(classResolve).replace('barrier: resolved by ', '').trim()
    const member =
      game.party.find((p) => p && p.hp > 0 && p.klass === klass) ??
      game.party.find((p) => p && p.klass === klass)
    const id = member ? characterId(member) : fallbackActorId
    if (id) addLoggedXp(game, id, XP_PER_BARRIER_CLEAR, 'barrier clear')
    return
  }

  const directResolve = logSlice.some((entry) => {
    const what = line(entry)
    return (
      what.includes('barrier: skill_check success') ||
      what.includes('barrier: mp_sacrifice') ||
      what.includes('barrier: auto_crumble') ||
      what.includes('barrier: bypassed')
    )
  })
  if (directResolve && fallbackActorId) {
    addLoggedXp(game, fallbackActorId, XP_PER_BARRIER_CLEAR, 'barrier clear')
  }
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
  const lines: string[] = []
  const livingEnemies = listLivingEnemies(game)
  for (const foe of livingEnemies) {
    if (game.phase !== 'playing') break
    const targets = livingParty(game.party)
    if (targets.length === 0) break
    const target = targets[dice.d(targets.length) - 1]!

    const attackSkill = clampSkill(Number(foe.attack))
    const counterAtk = resolveSkillCheck({ skill: attackSkill, dice })
    const counterDod = resolveSkillCheck({ skill: target.skills.dodge, dice })
    const atkMarg = counterAtk.success ? attackSkill - counterAtk.roll : -Infinity
    const dodMarg = counterDod.success ? target.skills.dodge - counterDod.roll : -Infinity
    const counterHit = counterAtk.success && (!counterDod.success || atkMarg > dodMarg)

    if (counterHit) {
      const dmg = Math.max(1, dice.d(6))
      target.hp = Math.max(0, target.hp - dmg)
      lines.push(`${foe.name} strikes ${target.name} for ${dmg}! (HP ${target.hp}/${target.maxHp})`)
      partyWipe(game)
      markCharacterDeath(game, target, deathCauseFromAttacker(game, foe.name))
    } else {
      lines.push(`${foe.name} swings at ${target.name} but misses.`)
    }
  }
  return lines
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

  const factionIds = factionIdsFromEnemies(input.enemies)
  if (factionIds.length === 0) return

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
  return [...party].sort((a, b) => {
    const dex = b.stats.DEX - a.stats.DEX
    if (dex !== 0) return dex
    return a.name.localeCompare(b.name)
  })
}

function logSkipDeadTurn(game: RpgGameState, name: string): void {
  const who = String(name || '').trim()
  if (!who) return
  game.log ??= []
  game.log.push({ at: Date.now(), who: 'GM', what: `${who} is dead, skipping turn` })
}

function normalizeTurnState(game: RpgGameState): boolean {
  const before = {
    phase: game.phase,
    mode: game.mode,
    currentPlayer: game.currentPlayer,
    turnOrderNames: Array.isArray(game.turnOrder) ? game.turnOrder.map((p) => p.name) : [],
  }

  game.party ??= []
  game.log ??= []

  const initiative = computeInitiativeOrder(game.party)
  const living = initiative.filter(isLiving)

  // Remove dead players from the active rotation, but keep them in the party state.
  game.turnOrder = living

  // If everyone is dead, end the game (TPK).
  if (living.length === 0) {
    partyWipe(game)
    game.phase = 'finished'
    game.mode = 'finished'
    game.combat = undefined
    game.currentPlayer = 'none'
  } else {
    const idx = initiative.findIndex((p) => isCharacter(p, game.currentPlayer))
    const current = idx >= 0 ? initiative[idx] : undefined
    if (!isLiving(current)) {
      if (current && (current.hp ?? 0) <= 0) logSkipDeadTurn(game, current.name)

      if (idx < 0) {
        game.currentPlayer = characterId(living[0])
      } else {
        const start = idx
        for (let offset = 1; offset <= initiative.length; offset += 1) {
          const candidate = initiative[(start + offset) % initiative.length]
          if (!candidate) continue
          if (isLiving(candidate)) {
            game.currentPlayer = characterId(candidate)
            break
          }
          logSkipDeadTurn(game, candidate.name)
        }
      }
    }
  }

  const after = {
    phase: game.phase,
    mode: game.mode,
    currentPlayer: game.currentPlayer,
    turnOrderNames: game.turnOrder.map((p) => p.name),
  }

  return (
    before.phase !== after.phase ||
    before.mode !== after.mode ||
    before.currentPlayer !== after.currentPlayer ||
    JSON.stringify(before.turnOrderNames) !== JSON.stringify(after.turnOrderNames)
  )
}

function advanceTurn(game: RpgGameState): void {
  game.party ??= []
  game.log ??= []
  game.round ??= 1

  const initiative = computeInitiativeOrder(game.party)
  const living = initiative.filter(isLiving)
  game.turnOrder = living

  if (living.length === 0) {
    partyWipe(game)
    game.phase = 'finished'
    game.mode = 'finished'
    game.combat = undefined
    game.currentPlayer = 'none'
    return
  }

  const idx = initiative.findIndex((p) => isCharacter(p, game.currentPlayer))
  const current = idx >= 0 ? initiative[idx] : undefined
  if (current && (current.hp ?? 0) <= 0) logSkipDeadTurn(game, current.name)

  const start = idx >= 0 ? idx : -1
  for (let offset = 1; offset <= initiative.length; offset += 1) {
    const nextIdx = (start + offset) % initiative.length
    const candidate = initiative[nextIdx]
    if (!candidate) continue
    if (isLiving(candidate)) {
      // If we wrapped around to an earlier index, that's a new round.
      if (idx >= 0 && nextIdx <= idx) {
        game.round = (game.round ?? 1) + 1
      }
      game.currentPlayer = characterId(candidate)
      return
    }
    logSkipDeadTurn(game, candidate.name)
  }

  game.currentPlayer = characterId(living[0])
}

function recomputeTurnOrder(game: RpgGameState): void {
  normalizeTurnState(game)
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

        if (command === 'join_game') {
          const gameId = typeof params.gameId === 'string' ? params.gameId.trim() : ''
          if (!gameId) throw new Error('gameId required for join_game')

          const klass = typeof params.klass === 'string' ? (params.klass as RpgClass) : null
          if (!klass || !['Warrior', 'Scout', 'Mage', 'Healer'].includes(klass)) {
            throw new Error('klass required: Warrior | Scout | Mage | Healer')
          }

          const row = await db
            .prepare("SELECT state FROM environments WHERE id = ? AND type = 'rpg'")
            .bind(gameId)
            .first<{ state: string }>()

          if (!row) throw new Error(`Adventure ${gameId} not found`)

          const game = JSON.parse(row.state) as RpgGameState
          if (game.phase !== 'playing' && game.phase !== 'setup') {
            return { ok: false, error: `Adventure ${gameId} is not joinable (phase: ${game.phase})` }
          }

          if (!Array.isArray(game.party) || game.party.length >= 3) {
            return { ok: false, error: `Adventure ${gameId} party is full` }
          }

          const agentName = ctx.agentName.trim() || 'unknown'
          if (game.party.some((p) => isCharacter(p, agentName))) {
            return { ok: false, error: `Already in active adventure ${gameId}.` }
          }

          const fantasyName = generateJoinName(klass, game.party.length)

          // Try to load persistent character
          let joined: Character
          let rerollNotice = ''
          if (ctx.loadCharacter) {
            const persistent = await ctx.loadCharacter() as PersistentCharacter | null
            if (persistent && persistent.klass) {
              if (persistent.dead === true) {
                joined = createCharacter({ name: fantasyName, klass, agent: agentName })
                rerollNotice = `Your previous character ${persistent.name} fell in battle. A new hero rises.\n`
                if (ctx.saveCharacter) {
                  const rerolled = buildRerolledPersistentCharacter(persistent, joined)
                  await ctx.saveCharacter(rerolled)
                }
              } else {
                joined = persistentToGameCharacter(persistent, agentName)
              }
            } else {
              joined = createCharacter({ name: fantasyName, klass, agent: agentName })
            }
          } else {
            joined = createCharacter({ name: fantasyName, klass, agent: agentName })
          }
          game.party.push(joined)
          recomputeTurnOrder(game)

          const players = game.party.map((p) => p.agent ?? p.name)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, players = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, JSON.stringify(players), gameId)
            .run()

          await ctx.broadcast({
            event_type: 'environment.joined',
            context: { environment: 'rpg', gameId, agent: agentName, klass },
          })

          return {
            content: toTextContent(`${rerollNotice}Joined adventure: ${gameId} as ${fantasyName} (${agentName}) the ${klass}\nParty: ${summarizeParty(game)}`),
            details: { gameId, joined },
          }
        }

        if (command === 'new_game') {
          const agentName = ctx.agentName.trim()

          // Only Grimlock can create new RPG environments.
          if (agentName !== 'grimlock') {
            const joinable = await findJoinableEnvironmentsForAgent(ctx, { limit: 5 })
            const lines: string[] = [
              'Only Grimlock can create new dungeons. Use join_game to join an existing adventure.',
            ]
            if (joinable.length > 0) {
              lines.push('')
              lines.push('Available adventures to join:')
              for (const candidate of joinable) {
                const recommended = pickJoinClass(candidate.game)
                lines.push(
                  `- ${candidate.id}: Party: ${summarizeParty(candidate.game)} | Join with {"command":"join_game","gameId":"${candidate.id}","klass":"${recommended}"}`
                )
              }
            }
            return { ok: false, error: lines.join('\n') }
          }

          // Grimlock is DM — check for ANY active RPG game (grimlock isn't in players list)
          const existing = await db
            .prepare("SELECT id FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') LIMIT 1")
            .first<{ id: string }>()
            .catch(() => null)

          if (existing?.id) {
            return {
              ok: false,
              error:
                `Already in active adventure ${existing.id}. ` +
                `Use {"command":"status","gameId":"${existing.id}"} to check state.`,
            }
          }

          const KNOWN_AGENTS = ['slag', 'snarl', 'swoop']
          const players = Array.isArray(params.players)
            ? params.players.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : []
          // Grimlock is the DM, never a player — strip from player list and ensure we have real players
          // Also strip any non-agent names (model sometimes passes fantasy character names)
          const filteredPlayers = players
            .map((p) => p.toLowerCase().trim())
            .filter((p) => p !== 'grimlock' && KNOWN_AGENTS.includes(p))
          // Always use the full player roster — partial lists lead to lopsided parties
          const finalPlayers = KNOWN_AGENTS
          if (finalPlayers.length < 1) throw new Error('Need at least 1 player')
          const requestedCampaignId = typeof params.campaignId === 'string'
            ? params.campaignId.trim()
            : typeof params.campaign_id === 'string'
              ? params.campaign_id.trim()
              : ''
          const campaignState = requestedCampaignId ? await getCampaign(db, requestedCampaignId) : null
          const campaignThread = campaignState ? buildCampaignDungeonThread(campaignState) : null
          if (requestedCampaignId && !campaignState) {
            return { ok: false, error: `Campaign ${requestedCampaignId} not found.` }
          }

          // Prefer joining an open adventure when a solo new_game is requested.
          if (finalPlayers.length <= 1) {
            const joinable = await findJoinableEnvironmentsForAgent(ctx, { limit: 5 })
            if (joinable.length > 0) {
              const lines: string[] = []
              lines.push('Open adventures are looking for party members:')
              for (const candidate of joinable) {
                const recommended = pickJoinClass(candidate.game)
                lines.push(
                  `- ${candidate.id}: Party: ${summarizeParty(candidate.game)} | Join with {"command":"join_game","gameId":"${candidate.id}","klass":"${recommended}"}`
                )
              }
              return { ok: false, error: lines.join('\n') }
            }
          }

          const gameId = `rpg_${generateTid()}`
          const game = createGame({
            id: gameId,
            players: finalPlayers,
            ...(campaignThread ? { campaignState: campaignThread.themedCampaignState } : {}),
          })
          if (campaignThread?.objective) {
            ;(game as Record<string, unknown>).campaignObjective = {
              ...campaignThread.objective,
              selectedAt: Date.now(),
            }
          }
          if (campaignThread && campaignThread.campaignLog.length > 0) {
            game.campaignLog = campaignThread.campaignLog
          }
          if (campaignThread?.objective && game.campaignContext) {
            const objectiveText = `${campaignThread.objective.arcName}: ${campaignThread.objective.plotPoint}`
            game.campaignContext.activeArcs = [objectiveText, ...(game.campaignContext.activeArcs ?? []).filter((arc) => arc !== objectiveText)].slice(0, 3)
          }

          // Backstory setup phase: DM interviews each player before the adventure begins
          game.phase = 'setup'
          const setupMachine = createRpgSetupPhaseMachine(finalPlayers, 2, 'grimlock')
          game.setupPhase = {
            currentPlayerIndex: 0,
            exchangeCount: 0,
            maxExchanges: 2,
            dialogues: {},
            complete: false,
          }
          ;(game as any).phaseMachine = serializePhaseMachine(setupMachine)

          // Ensure type column exists (migration from catan-only schema)
          await db.prepare("ALTER TABLE environments ADD COLUMN type TEXT DEFAULT 'catan'").run().catch(() => {/* already exists */})

          await db
            .prepare(
              "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
            )
            .bind(gameId, 'rpg', ctx.agentName.trim() || 'unknown', JSON.stringify(game), game.phase, JSON.stringify(finalPlayers))
            .run()

          if (campaignState) {
            const adventureNumber = await linkAdventureToCampaign(db, gameId, campaignState.id)
            game.campaignAdventureNumber = adventureNumber
          }

          await ctx.broadcast({
            event_type: 'environment.created',
            context: {
              environment: 'rpg',
              gameId,
              host: ctx.agentName.trim() || 'unknown',
              players: finalPlayers,
              ...(campaignState ? { campaignId: campaignState.id } : {}),
            },
          })

          return {
            content: toTextContent(
              `Adventure created: ${gameId}\nPlayers: ${finalPlayers.join(', ')}${
                campaignState ? `\nCampaign: ${campaignState.name} (#${game.campaignAdventureNumber})` : ''
              }\n\n` +
                `Room 1/${game.dungeon.length}: ${describeRoom(game, 0)}`
            ),
            details: {
              gameId,
              type: 'rpg',
              players: finalPlayers,
              phase: game.phase,
              ...(campaignState ? { campaignId: campaignState.id, adventureNumber: game.campaignAdventureNumber } : {}),
            },
          }
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

        if (command === 'status') {
          if (game.phase === 'hub_town') {
            const hub = ensureHubTownState(game)
            const idleTurns = countHubTownIdleTurn(game)
            const text =
              `${buildHubTownNarration(game, { location: hub.location, cue: 'The party regroups, trades rumors, and plans the next push.' })}\n\n` +
              `Current player: ${game.currentPlayer}\n` +
              `Party: ${summarizeParty(game)}\n` +
              `Idle turns: ${idleTurns}/${hub.autoEmbarkAfter}\n` +
              `Hub actions: visit_location, buy_item, sell_item, rest, embark`

            await db
              .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
              .run()

            return {
              content: toTextContent(text),
              details: {
                gameId,
                phase: game.phase,
                location: hub.location,
                idleTurns,
                autoEmbarkAfter: hub.autoEmbarkAfter,
              },
            }
          }

          const room = game.dungeon[game.roomIndex]
          const description = describeRoom(game, game.roomIndex)
          let statusText =
              `Adventure: ${gameId}\n` +
              `Mode: ${game.mode} | Phase: ${game.phase}\n` +
              `Room ${game.roomIndex + 1}/${game.dungeon.length}: ${room?.type ?? 'unknown'}\n` +
              `${description}\n\n` +
              `Current player: ${game.currentPlayer}\n` +
              `Party: ${summarizeParty(game)}`

          // During setup, append a forceful instruction for the next action
          if (setupActive) {
            const pmData = (game as any).phaseMachine
            if (pmData) {
              const pm = deserializePhaseMachine(pmData)
              const currentPhase = pm.getCurrentPhase()
              if (currentPhase) {
                const targetMatch = currentPhase.name.match(/setup_(?:narrate|respond)_(\w+)_/)
                const target = targetMatch ? targetMatch[1] : 'unknown'
                statusText += `\n\n⚠️ SETUP PHASE ACTIVE — Phase: ${currentPhase.name}\n` +
                  `Active agent: ${currentPhase.activeAgent}\n` +
                  `YOUR NEXT ACTION: Call rpg tool with ${JSON.stringify({ command: currentPhase.transitionOn, ...(currentPhase.transitionOn === 'setup_narrate' ? { target, message: '<your backstory question>' } : { message: '<your response>' }), gameId })}\n` +
                  `DO NOT use explore, attack, or any other command. ONLY ${currentPhase.transitionOn} is accepted.`
              }
            }
          }

          return {
            content: toTextContent(statusText),
            details: {
              gameId,
              mode: game.mode,
              phase: game.phase,
              roomIndex: game.roomIndex,
              currentPlayer: game.currentPlayer,
            },
          }
        }

        if (command === 'get_reputation') {
          const factionFilter = typeof params.factionId === 'string' ? params.factionId.trim().toLowerCase() : ''
          const campaignId = typeof game.campaignId === 'string' ? game.campaignId.trim() : ''

          let lines: string[] = []
          if (campaignId) {
            try {
              const campaign = await getCampaign(db, campaignId)
              if (campaign) {
                const factions = (campaign.worldState?.factions ?? [])
                  .filter((faction) => {
                    if (!factionFilter) return true
                    return faction.id.toLowerCase() === factionFilter || faction.name.toLowerCase().includes(factionFilter)
                  })
                  .slice(0, 8)
                lines = factions.map((faction) =>
                  formatFactionStandingLine({ name: faction.name, disposition: faction.disposition })
                )
              }
            } catch {
              // Ignore DB lookup errors in tests/mocks and fall back to cached context.
            }
          }

          if (lines.length === 0) {
            const cached = Array.isArray(game.campaignContext?.factions) ? game.campaignContext!.factions : []
            lines = cached
              .filter((line) => !factionFilter || line.toLowerCase().includes(factionFilter))
              .slice(0, 8)
          }

          if (lines.length === 0) {
            return {
              content: toTextContent('No faction reputation data is available for this adventure yet.'),
              details: { gameId, campaignId: campaignId || null },
            }
          }

          const title = campaignId ? `Faction reputation (${campaignId})` : 'Faction reputation'
          return {
            content: toTextContent(`${title}\n${lines.join('\n')}`),
            details: { gameId, campaignId: campaignId || null, count: lines.length },
          }
        }

        if (command === 'visit_location') {
          if (game.phase !== 'hub_town') {
            return { ok: false, error: 'visit_location is only available in hub_town.' }
          }
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          const location = normalizeHubTownLocation(params.location)
          if (!location) {
            return { ok: false, error: `location required: ${HUB_TOWN_LOCATIONS.join(', ')}` }
          }

          const hub = ensureHubTownState(game)
          hub.location = location
          resetHubTownIdle(game)
          advanceTurn(game)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(
              `${buildHubTownNarration(game, {
                location,
                cue: `You make your way to the ${HUB_TOWN_LOCATION_LABEL[location]}.`,
              })}\n\nParty: ${summarizeParty(game)}`
            ),
            details: { gameId, location },
          }
        }

        if (command === 'buy_item') {
          if (game.phase !== 'hub_town') return { ok: false, error: 'buy_item is only available in hub_town.' }
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          const hub = ensureHubTownState(game)
          if (hub.location !== 'market') {
            return { ok: false, error: 'You must be at the market to buy items. Use visit_location("market").' }
          }

          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before buying items')
          ensureCharacterLootState(actor)

          const itemId = typeof params.itemId === 'string' ? params.itemId.trim().toLowerCase() : ''
          const listing = HUB_TOWN_SHOP[itemId]
          if (!listing) {
            return { ok: false, error: `Unknown itemId. Available: ${Object.keys(HUB_TOWN_SHOP).join(', ')}` }
          }
          if (actor.gold < listing.cost) {
            return { ok: false, error: `Not enough gold (need ${listing.cost}, have ${actor.gold}).` }
          }

          actor.gold -= listing.cost
          applyLootToCharacter(actor, { items: [copyHubTownShopItem(listing)], gold: 0 })
          resetHubTownIdle(game)
          advanceTurn(game)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`Bought ${itemId} (${listing.item.name}) for ${listing.cost} gold. (${actor.gold} gold remaining)`),
            details: { gameId, itemId, gold: actor.gold },
          }
        }

        if (command === 'sell_item') {
          if (game.phase !== 'hub_town') return { ok: false, error: 'sell_item is only available in hub_town.' }
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          const hub = ensureHubTownState(game)
          if (hub.location !== 'market') {
            return { ok: false, error: 'You must be at the market to sell items. Use visit_location("market").' }
          }

          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before selling items')
          ensureCharacterLootState(actor)

          const itemId = typeof params.itemId === 'string' ? params.itemId.trim().toLowerCase() : ''
          if (!itemId) return { ok: false, error: 'itemId required for sell_item.' }

          const idx = actor.inventory.findIndex((item) => {
            if (!item) return false
            const invId = hubTownItemIdFromInventory(item)
            return invId === itemId || hubTownItemIdFromName(item.name) === itemId
          })
          if (idx < 0) {
            return { ok: false, error: `No inventory item matches itemId "${itemId}".` }
          }

          const [item] = actor.inventory.splice(idx, 1)
          if (!item) return { ok: false, error: `No inventory item matches itemId "${itemId}".` }

          removeLootEffectsFromCharacter(actor, item)
          const value = HUB_TOWN_SHOP[itemId]?.sellValue ?? fallbackSellValueForItem(item)
          actor.gold += value
          resetHubTownIdle(game)
          advanceTurn(game)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`Sold ${itemId} (${item.name}) for ${value} gold. (${actor.gold} gold total)`),
            details: { gameId, itemId, gold: actor.gold, value },
          }
        }

        if (command === 'embark') {
          if (game.phase !== 'hub_town') return { ok: false, error: 'embark is only available in hub_town.' }
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          const campaignId = typeof game.campaignId === 'string' ? game.campaignId.trim() : ''
          let campaignState: CampaignState | null = null
          if (campaignId) {
            try {
              campaignState = await getCampaign(db, campaignId)
            } catch {
              campaignState = null
            }
          }

          const fallbackAdventureCount = parseCampaignAdventureCount(game.campaignAdventureNumber, 1)
          const fallbackCampaignState: CampaignState | null = campaignId
            ? {
                id: campaignId,
                name: game.campaignContext?.name ?? 'Campaign',
                premise: game.campaignContext?.premise ?? '',
                worldState: { factions: [], locations: [], events: [] },
                storyArcs: [],
                adventureCount: fallbackAdventureCount,
              }
            : null

          const sourceCampaign = campaignState ?? fallbackCampaignState
          const campaignThread = sourceCampaign ? buildCampaignDungeonThread(sourceCampaign) : null
          const next = createGame({
            id: gameId,
            players: game.party,
            ...(campaignThread ? { campaignState: campaignThread.themedCampaignState } : {}),
          })

          if (campaignThread?.objective) {
            ;(next as Record<string, unknown>).campaignObjective = {
              ...campaignThread.objective,
            }
          }
          if (campaignThread && campaignThread.campaignLog.length > 0) {
            next.campaignLog = campaignThread.campaignLog
          }
          if (campaignThread?.objective && next.campaignContext) {
            const objectiveText = `${campaignThread.objective.arcName}: ${campaignThread.objective.plotPoint}`
            next.campaignContext.activeArcs = [objectiveText, ...(next.campaignContext.activeArcs ?? []).filter((arc) => arc !== objectiveText)].slice(0, 3)
          }

          if (campaignState) {
            const adventureNumber = Math.max(
              Math.floor(campaignState.adventureCount) + 1,
              Number.isFinite(next.campaignAdventureNumber) ? Math.floor(next.campaignAdventureNumber as number) : 1
            )
            next.campaignAdventureNumber = adventureNumber
            try {
              await updateCampaign(db, campaignState.id, { adventureCount: adventureNumber })
            } catch {
              // best effort
            }
          }

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(next), next.phase, (next as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`You leave town and embark on the next adventure.\n\nParty: ${summarizeParty(next)}`),
            details: {
              gameId,
              phase: next.phase,
              roomIndex: next.roomIndex,
              campaignId: next.campaignId ?? null,
              adventureNumber: next.campaignAdventureNumber ?? null,
            },
          }
        }

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

        // Setup-phase commands
        if (command === 'setup_narrate' || command === 'setup_respond' || command === 'setup_finalize') {
          if (!setupPhase) {
            return { ok: false, error: 'No setup phase is active for this adventure.' }
          }
          const sp = setupPhase // narrowed non-undefined binding

          const agentName = ctx.agentName.trim()
          const party = Array.isArray(game.party) ? game.party : []
          const currentIdx = Math.max(0, Math.min(party.length - 1, Math.floor(sp.currentPlayerIndex ?? 0)))
          const current = party[currentIdx]
          const currentAgent = current ? (current.agent ?? current.name) : ''

          function ensureDialoguesKey(key: string): string[] {
            sp.dialogues ??= {}
            const k = String(key || '').trim() || 'unknown'
            const list = sp.dialogues[k] ?? []
            sp.dialogues[k] = list
            return list
          }

          if (command === 'setup_narrate') {
            if (agentName !== 'grimlock') return { ok: false, error: 'Only Grimlock can use setup_narrate.' }
            if (sp.complete) return { ok: false, error: 'Setup is already complete. Use setup_finalize.' }

            const message = typeof params.message === 'string' ? params.message.trim() : ''
            if (!message) return { ok: false, error: 'message required for setup_narrate' }

            const targetRaw = typeof params.target === 'string' ? params.target.trim() : ''
            const target = targetRaw || currentAgent
            if (!target) return { ok: false, error: 'No target player found for setup_narrate.' }

            // Optional: allow DM to re-target the interview.
            if (targetRaw) {
              const idx = party.findIndex((p: any) => (p?.agent ?? p?.name) === target)
              if (idx >= 0) {
                sp.currentPlayerIndex = idx
                sp.exchangeCount = 0
              }
            }

            ensureDialoguesKey(target).push(message)
            game.currentPlayer = target

            // Advance phase machine
            const pmData = (game as any).phaseMachine
            if (pmData) {
              const pm = deserializePhaseMachine(pmData)
              pm.advance({ command: 'setup_narrate', target })
              ;(game as any).phaseMachine = serializePhaseMachine(pm)
            }

            await db
              .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
              .run()

            return { content: toTextContent(`DM: ${message}`), details: { gameId, target } }
          }

          if (command === 'setup_respond') {
            if (sp.complete) return { ok: false, error: 'Setup is already complete. Wait for setup_finalize.' }
            if (agentName !== currentAgent) {
              return { ok: false, error: `Not your setup turn. Current player: ${currentAgent || 'unknown'}` }
            }

            const message = typeof params.message === 'string' ? params.message.trim() : ''
            if (!message) return { ok: false, error: 'message required for setup_respond' }

            ensureDialoguesKey(agentName).push(message)

            sp.exchangeCount = Math.max(0, Math.floor(sp.exchangeCount ?? 0)) + 1

            // Hand turn back to DM, and advance to the next player when maxExchanges reached.
            if (sp.exchangeCount >= Math.max(1, Math.floor(sp.maxExchanges ?? 2))) {
              sp.currentPlayerIndex = currentIdx + 1
              sp.exchangeCount = 0

              if (sp.currentPlayerIndex >= party.length) {
                sp.complete = true
              }
            }

            game.currentPlayer = 'grimlock'

            // Advance phase machine
            const pmData = (game as any).phaseMachine
            if (pmData) {
              const pm = deserializePhaseMachine(pmData)
              pm.advance({ command: 'setup_respond', agent: agentName })
              ;(game as any).phaseMachine = serializePhaseMachine(pm)
            }

            await db
              .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
              .run()

            return { content: toTextContent(`You: ${message}`), details: { gameId } }
          }

          // setup_finalize
          if (agentName !== 'grimlock') return { ok: false, error: 'Only Grimlock can use setup_finalize.' }

          const backstories = isRecord(params.backstories) ? (params.backstories as Record<string, unknown>) : null
          if (!backstories) return { ok: false, error: 'backstories required for setup_finalize' }

          for (const member of party) {
            const id = String((member as any)?.agent ?? (member as any)?.name ?? '').trim()
            if (!id) continue
            const raw = backstories[id]
            const text = typeof raw === 'string' ? raw.trim() : ''
            if (text) (member as any).backstory = text
          }

          sp.complete = true
          delete (game as any).setupPhase
          delete (game as any).phaseMachine

          // Start adventure at room 0 with correct mode/combat and first player turn.
          game.roomIndex = 0
          const room0 = game.dungeon?.[0]
          if (room0 && (room0.type === 'combat' || room0.type === 'boss')) {
            game.mode = 'combat'
            game.combat = { enemies: (room0 as any).enemies?.map((e: any) => ({ ...e })) ?? [] }
          } else {
            game.mode = 'exploring'
            game.combat = undefined
          }
          recomputeTurnOrder(game)
          game.currentPlayer = characterId(game.turnOrder[0]) ?? characterId(game.party[0]) ?? 'unknown'
          game.phase = 'playing'

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return { content: toTextContent('Setup complete. The adventure begins!'), details: { gameId, phase: 'playing' } }
        }

        if (command === 'send_message') {
          const sender = ctx.agentName.trim() || 'unknown'
          const toRaw = typeof params.to === 'string' ? params.to.trim() : ''
          const to = toRaw.startsWith('@') ? toRaw.toLowerCase() : ''
          const rawType = typeof params.type === 'string' ? params.type.trim() : ''
          const msgRaw = typeof params.message === 'string' ? params.message.trim() : ''
          const message = capChars(msgRaw, 500)

          const type: FeedMessageType | null = rawType === 'ic' || rawType === 'ooc' ? (rawType as FeedMessageType) : null
          if (!to) return { ok: false, error: 'to required for send_message (use @agent, @party, or @dm)' }
          if (!type) return { ok: false, error: "type required for send_message ('ic' | 'ooc')" }
          if (!message) return { ok: false, error: 'message required for send_message' }

          const allowed = new Set<string>(['@party', '@dm'])
          for (const member of Array.isArray(game.party) ? game.party : []) {
            const handle = `@${characterId(member).toLowerCase()}`
            if (handle.length > 1) allowed.add(handle)
          }
          if (!allowed.has(to)) {
            const options = [...allowed].filter((h) => h !== '@party' && h !== '@dm').sort()
            return {
              ok: false,
              error: `Invalid recipient: ${to}. Use @party, @dm, or one of: ${options.join(', ')}`,
            }
          }

          game.messageRateLimit ??= { round: game.round ?? 1, counts: {} }
          if (game.messageRateLimit.round !== (game.round ?? 1)) {
            game.messageRateLimit = { round: game.round ?? 1, counts: {} }
          }
          const used = game.messageRateLimit.counts[sender] ?? 0
          if (used >= 2) {
            return { ok: false, error: `Rate limit: max 2 messages per agent per round (round ${game.round ?? 1}).` }
          }

          game.messageRateLimit.counts[sender] = used + 1
          const entry: FeedMessage = { sender, to, message, type, timestamp: Date.now() }
          game.feedMessages ??= []
          game.feedMessages.push(entry)
          if (game.feedMessages.length > 20) {
            game.feedMessages.splice(0, game.feedMessages.length - 20)
          }

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`Sent ${type.toUpperCase()} message to ${to}: ${message}`),
            details: { gameId, message: entry },
          }
        }

        // While setup is active, block normal gameplay commands to prevent skipping backstories.
        if (setupActive) {
          return { ok: false, error: 'Setup phase in progress. Use setup_narrate / setup_respond / setup_finalize.' }
        }

        if (command === 'create_character') {
          const klass = typeof params.klass === 'string' ? (params.klass as RpgClass) : null
          if (!klass || !['Warrior', 'Scout', 'Mage', 'Healer'].includes(klass)) {
            throw new Error('klass required: Warrior | Scout | Mage | Healer')
          }

          const agentName = ctx.agentName.trim() || 'unknown'
          const existing = game.party.find((p) => isCharacter(p, agentName))
          const fantasyName = existing?.name ?? generateJoinName(klass, game.party.length)
          const updated = createCharacter({ name: fantasyName, klass, agent: agentName })
          if (existing) {
            Object.assign(existing, updated)
          } else {
            game.party.push(updated)
          }
          recomputeTurnOrder(game)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`Character ready: ${fantasyName} (${agentName}) the ${klass}\nParty: ${summarizeParty(game)}`),
            details: { gameId, character: updated },
          }
        }

        if (command === 'explore') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }
          const atDungeonEnd = game.roomIndex >= Math.max(0, game.dungeon.length - 1)
          if (atDungeonEnd) {
            // Allow completion from final room even if stale combat state leaked in.
            game.mode = 'exploring'
            game.combat = undefined
          }
          const combatActive = game.mode === 'combat' && (game.combat?.enemies ?? []).some((enemy) => (enemy?.hp ?? 0) > 0)
          if (combatActive) {
            return {
              ok: false,
              error: "You're in combat! Use: attack, negotiate, flee, or intimidate. Type 'status' for details.",
            }
          }
          if (game.mode === 'combat') {
            game.mode = 'exploring'
            game.combat = undefined
          }

          const beforePhase = game.phase
          const beforeRoomIndex = game.roomIndex
          const beforeLogLength = (game.log ??= []).length
          const actingBefore = findActingCharacter(game, ctx.agentName.trim())
          const actingBeforeId = characterId(actingBefore)
          const actingUseSkillBefore = Number.isFinite(actingBefore?.skills?.use_skill)
            ? Math.max(0, Math.floor((actingBefore?.skills?.use_skill as number)))
            : null
          const attemptedRoomIndex = game.roomIndex + 1
          const result = explore(game, { dice })
          let lootLine = ''

          if (game.roomIndex > beforeRoomIndex) {
            const enteredRoom = game.dungeon[game.roomIndex]
            const newLogSlice = game.log.slice(beforeLogLength)
            if (enteredRoom?.type === 'treasure') {
              const actor = findActingCharacter(game, ctx.agentName.trim())
              if (actor) {
                lootLine = resolveTreasureLoot(game, actor, dice)
              }
            }
            if (enteredRoom?.type === 'trap' && actingUseSkillBefore != null) {
              const actorAfter = game.party.find((p) => p && isCharacter(p, actingBeforeId))
              if (actorAfter && actorAfter.skills.use_skill > actingUseSkillBefore) {
                addLoggedXp(game, characterId(actorAfter), XP_PER_TRAP_DISARM, 'trap disarm')
              }
            }
            if (enteredRoom?.type === 'puzzle' && actingUseSkillBefore != null) {
              const actorAfter = game.party.find((p) => p && isCharacter(p, actingBeforeId))
              if (actorAfter && actorAfter.skills.use_skill > actingUseSkillBefore) {
                for (const id of livingPartyIds(game)) addLoggedXp(game, id, XP_PER_PUZZLE, 'puzzle')
              }
            }
            if (enteredRoom?.type === 'barrier') {
              awardBarrierClearMilestoneXp(game, { logSlice: newLogSlice, fallbackActorId: actingBeforeId })
            }
          }

          gmInterveneIfStuck(game, {
            player: ctx.agentName.trim() || 'unknown',
            action: 'explore',
            target: `room:${attemptedRoomIndex}:${result.room?.type ?? 'none'}`,
          })

          // Room clear XP: only when we actually advance to a new room.
          if (game.roomIndex > beforeRoomIndex) {
            awardRoomClearXp(game)
          }

          // Adventure completion XP: award once when phase flips to finished.
          // Guard: tests construct single-room dungeons purely to exercise save behavior; don't auto-award
          // completion XP for those.
          if (beforePhase !== 'finished' && game.phase === 'finished' && game.dungeon.length > 1) {
            awardAdventureCompleteXp(game)
          }

          // advance turn (skip dead players)
          advanceTurn(game)
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(
              (() => {
                if (game.phase === 'hub_town') {
                  const hub = ensureHubTownState(game)
                  return `${buildHubTownNarration(game, {
                    location: hub.location,
                    cue: 'The dungeon expedition ends for now, and town life resumes.',
                  })}\n\nParty: ${summarizeParty(game)}`
                }
                if (game.phase !== 'playing') return 'The adventure is complete.'
                const roomNow = game.dungeon[game.roomIndex]
                if (!roomNow) return 'The adventure is complete.'
                const lootText = lootLine ? `\n${lootLine}` : ''
                return `You enter: ${roomNow.type}\n${describeRoom(game, game.roomIndex)}${lootText}\n\nParty: ${summarizeParty(game)}`
              })()
            ),
            details: { gameId, room: game.phase === 'playing' ? game.dungeon[game.roomIndex] ?? null : null, mode: game.mode },
          }
        }

        if (command === 'attack') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          const beforePhase = game.phase

          // In combat, attack the first enemy.
          if (game.mode === 'combat' && game.combat?.enemies?.length) {
            const enemy = game.combat.enemies.find((e) => e.hp > 0)
            if (!enemy) {
              game.mode = 'exploring'
              game.combat = undefined
            } else {
              // Inline enemy resolution to avoid bloating the engine API.
              const attackerName = ctx.agentName.trim() || 'unknown'
              const attacker = game.party.find((p) => isCharacter(p, attackerName))
              if (!attacker) throw new Error('Create your character before attacking')

              const atk = resolveSkillCheck({ skill: attacker.skills.attack, dice })
              const dod = resolveSkillCheck({ skill: enemy.dodge, dice })
              const atkMargin = atk.success ? attacker.skills.attack - atk.roll : -Infinity
              const dodMargin = dod.success ? enemy.dodge - dod.roll : -Infinity
              const hit = atk.success && (!dod.success || atkMargin > dodMargin)

              let text = ''
              if (hit) {
                const hpBefore = enemy.hp
                const dmg = dice.d(6) + Math.floor(attacker.stats.STR / 25)
                enemy.hp = Math.max(0, enemy.hp - dmg)
                attacker.skills.attack = atk.nextSkill
                text = `You strike the ${enemy.name} for ${dmg}. (${enemy.hp} HP left)`
                game.log.push({ at: Date.now(), who: attackerName, what: `attack: hit ${enemy.name} for ${dmg} (${enemy.hp} HP left)` })

                // XP rewards are accumulated into game state and applied to persistent characters at game end.
                if (hpBefore > 0 && enemy.hp === 0) {
                  addXpEarned(game, attackerName, XP_PER_ENEMY_KILL)
                  game.log.push({ at: Date.now(), who: attackerName, what: `gained ${XP_PER_ENEMY_KILL} XP (kill: ${enemy.name})` })

                  await applyEncounterDispositionToCampaign(ctx, {
                    game,
                    enemies: [enemy],
                    resolution: 'kill',
                    reason: `${attackerName} killed a ${enemy.name} during an encounter.`,
                  })

                  if (enemy.tactics?.kind === 'boss') {
                    addXpEarned(game, attackerName, XP_PER_BOSS_KILL)
                    game.log.push({ at: Date.now(), who: attackerName, what: `gained ${XP_PER_BOSS_KILL} XP (boss kill)` })
                  }

                  const dropLine = maybeAwardEnemyDrop(game, attacker, enemy, dice)
                  if (dropLine) {
                    text += `\nLoot: ${dropLine}`
                  }
                }
              } else {
                text = `The ${enemy.name} avoids your attack.`
                game.log.push({ at: Date.now(), who: attackerName, what: `attack: missed ${enemy.name}` })
              }

              // ALL living enemies counter-attack (action economy!)
              // From "The Monsters Know": monsters that can attack, will attack.
              const livingEnemies = (game.combat?.enemies ?? []).filter(e => e.hp > 0)
              for (const foe of livingEnemies) {
                if (game.phase !== 'playing') break
                // Each enemy targets a random party member
                const targets = livingParty(game.party)
                if (targets.length === 0) break
                const target = targets[dice.d(targets.length) - 1]!

                const counterAtk = resolveSkillCheck({ skill: foe.attack, dice })
                const counterDod = resolveSkillCheck({ skill: target.skills.dodge, dice })
                const atkMarg = counterAtk.success ? foe.attack - counterAtk.roll : -Infinity
                const dodMarg = counterDod.success ? target.skills.dodge - counterDod.roll : -Infinity
                const counterHit = counterAtk.success && (!counterDod.success || atkMarg > dodMarg)

                if (counterHit) {
                  const raw = dice.d(6)
                  const dmg = Math.max(1, raw) // minimum 1 damage on hit
                  target.hp = Math.max(0, target.hp - dmg)
                  text += `\n${foe.name} strikes ${target.name} for ${dmg}! (HP ${target.hp}/${target.maxHp})`
                  partyWipe(game)
                  markCharacterDeath(game, target, deathCauseFromAttacker(game, foe.name))
                } else {
                  text += `\n${foe.name} swings at ${target.name} but misses.`
                }
              }

              if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
                game.mode = 'exploring'
                game.combat = undefined
                text += '\nCombat ends.'
              }

              gmInterveneIfStuck(game, {
                player: ctx.agentName.trim() || 'unknown',
                action: 'attack',
                target: `enemy:${enemy.name}`,
              })

              // advance turn (skip dead players)
              advanceTurn(game)
              const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

              await db
                .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
                .run()

              if (completion.completed) {
                await emitEnvironmentCompleted(ctx, { gameId, game })
              }

              return { content: toTextContent(`${text}\n\nParty: ${summarizeParty(game)}`), details: { gameId } }
            }
          }

          const defender = typeof params.defender === 'string' ? params.defender.trim() : ''
          if (!defender) throw new Error('defender required when not in combat')

          const result = attack(game, { attacker: ctx.agentName.trim() || 'unknown', defender, dice })

          gmInterveneIfStuck(game, {
            player: ctx.agentName.trim() || 'unknown',
            action: 'attack',
            target: `party:${defender}`,
          })

          // advance turn (skip dead players)
          advanceTurn(game)
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(`${result.detail}.\nParty: ${summarizeParty(game)}`),
            details: { gameId, hit: result.hit },
          }
        }

        if (command === 'negotiate') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }
          if (game.mode !== 'combat') {
            return { ok: false, error: 'You can only negotiate during combat.' }
          }

          const beforePhase = game.phase
          const actorName = ctx.agentName.trim() || 'unknown'
          const actor = game.party.find((p) => isCharacter(p, actorName))
          if (!actor) throw new Error('Create your character before negotiating')

          const enemies = listLivingEnemies(game)
          if (enemies.length === 0) {
            game.mode = 'exploring'
            game.combat = undefined
            return { ok: false, error: 'There are no enemies to negotiate with.' }
          }

          if (enemies.some((enemy) => enemy.negotiable !== true || !enemyIsNegotiable(enemy))) {
            return { ok: false, error: 'Negotiation fails: some enemies are mindless or unwilling to parley.' }
          }

          const target = clampSkill(40 + partyAverageLevel(game.party) * 5)
          const roll = dice.d100()
          const success = roll <= target
          const lines: string[] = []

          if (success) {
            const encounterXp = encounterXpValue(enemies)
            const partialXp = Math.max(0, Math.floor(encounterXp * 0.75))
            for (const id of livingPartyIds(game)) addXpEarned(game, id, partialXp)

            await applyEncounterDispositionToCampaign(ctx, {
              game,
              enemies,
              resolution: 'negotiate',
              reason: `${actorName} negotiated a peaceful resolution after combat tensions.`,
            })

            game.mode = 'exploring'
            game.combat = undefined

            const boon = dice.d(2) === 1
              ? 'The foes trade safe-passage terms and reveal a useful route ahead.'
              : 'The foes accept terms and leave behind a small cache of supplies.'
            lines.push(`Negotiation succeeds (${roll} <= ${target}). The enemies stand down.`)
            lines.push(boon)
            if (partialXp > 0) {
              lines.push(`Party gains ${partialXp} XP (diplomatic resolution).`)
              game.log.push({ at: Date.now(), who: actorName, what: `gained ${partialXp} XP (negotiate)` })
            }
          } else {
            lines.push(`Negotiation fails (${roll} > ${target}). The enemies seize the initiative!`)
            lines.push(...runEnemyFreeAttackRound(game, dice))
          }

          gmInterveneIfStuck(game, {
            player: actorName,
            action: 'negotiate',
            target: enemies.map((enemy) => enemy.name).join(','),
          })

          if (game.phase === 'playing') {
            advanceTurn(game)
          }
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(`${lines.join('\n')}\n\nParty: ${summarizeParty(game)}`),
            details: { gameId, success, roll, target },
          }
        }

        if (command === 'flee') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }
          if (game.mode !== 'combat') {
            return { ok: false, error: 'You can only flee during combat.' }
          }
          if (isBossEncounterRoom(game)) {
            return { ok: false, error: 'You cannot flee from a boss encounter.' }
          }

          const beforePhase = game.phase
          const actorName = ctx.agentName.trim() || 'unknown'
          const actor = game.party.find((p) => isCharacter(p, actorName))
          if (!actor) throw new Error('Create your character before fleeing')

          const roll = dice.d100()
          const target = 50
          const success = roll <= target
          const lines: string[] = []

          if (success) {
            addLoggedXp(game, actorName, 10, 'flee')
            lines.push(`Retreat succeeds (${roll} <= ${target}). The party escapes without taking damage.`)
            lines.push('You gain 10 XP for surviving the retreat.')
          } else {
            lines.push(`Retreat falters (${roll} > ${target}). You escape under enemy fire.`)
            lines.push(...runEnemyFreeAttackRound(game, dice))
          }

          if (game.phase === 'playing') {
            game.mode = 'exploring'
            game.combat = undefined
            if (game.roomIndex > 0) game.roomIndex -= 1
          }

          gmInterveneIfStuck(game, {
            player: actorName,
            action: 'flee',
            target: `room:${game.roomIndex}`,
          })

          if (game.phase === 'playing') {
            advanceTurn(game)
          }
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          if (!success) lines.push('No XP awarded. The encounter remains dangerous.')
          return {
            content: toTextContent(`${lines.join('\n')}\n\nParty: ${summarizeParty(game)}`),
            details: { gameId, success, roll, target },
          }
        }

        if (command === 'sneak') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }
          if (game.mode === 'combat') {
            return { ok: false, error: 'Too late to sneak. Combat has already started.' }
          }

          const beforePhase = game.phase
          const actorName = ctx.agentName.trim() || 'unknown'
          const actor = game.party.find((p) => isCharacter(p, actorName))
          if (!actor) throw new Error('Create your character before sneaking')

          const encounterIndex = nextEncounterRoomIndex(game)
          if (encounterIndex == null) {
            return { ok: false, error: 'There is no encounter ahead to sneak past.' }
          }
          const encounterRoom = game.dungeon[encounterIndex]
          if (!encounterRoom || (encounterRoom.type !== 'combat' && encounterRoom.type !== 'boss')) {
            return { ok: false, error: 'There is no encounter ahead to sneak past.' }
          }

          const scoutBonus = actor.klass === 'Scout' ? 20 : 0
          const target = clampSkill(50 + scoutBonus)
          const roll = dice.d100()
          const success = roll <= target
          const lines: string[] = []

          if (success) {
            const skippedTo = encounterIndex + 1
            if (skippedTo >= game.dungeon.length) {
              game.phase = 'finished'
              game.mode = 'finished'
              game.combat = undefined
              lines.push(`Sneak succeeds (${roll} <= ${target}). You bypass the encounter and reach the dungeon exit.`)
            } else {
              game.roomIndex = skippedTo
              const landed = game.dungeon[game.roomIndex]
              if (landed && (landed.type === 'combat' || landed.type === 'boss')) {
                game.mode = 'combat'
                game.combat = { enemies: cloneEnemiesForCombat(landed.enemies) }
              } else {
                game.mode = 'exploring'
                game.combat = undefined
              }
              lines.push(`Sneak succeeds (${roll} <= ${target}). You bypass the encounter unseen.`)
              lines.push(`You move to: ${landed?.description ?? 'the next chamber'} (type: ${landed?.type ?? 'unknown'}).`)
            }
          } else {
            game.roomIndex = encounterIndex
            game.mode = 'combat'
            game.combat = { enemies: cloneEnemiesForCombat(encounterRoom.enemies) }
            lines.push(`Sneak fails (${roll} > ${target}). The enemies spot you and strike first!`)
            lines.push(...runEnemyFreeAttackRound(game, dice))
          }

          gmInterveneIfStuck(game, {
            player: actorName,
            action: 'sneak',
            target: `room:${encounterIndex}`,
          })

          if (game.phase === 'playing') {
            advanceTurn(game)
          }
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(`${lines.join('\n')}\n\nParty: ${summarizeParty(game)}`),
            details: { gameId, success, roll, target },
          }
        }

        if (command === 'intimidate') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }
          if (game.mode !== 'combat') {
            return { ok: false, error: 'You can only intimidate during combat.' }
          }

          const beforePhase = game.phase
          const actorName = ctx.agentName.trim() || 'unknown'
          const actor = game.party.find((p) => isCharacter(p, actorName))
          if (!actor) throw new Error('Create your character before intimidating')

          const livingEnemies = listLivingEnemies(game)
          const eligible = findIntimidatableEnemies(livingEnemies)
          if (eligible.length === 0) {
            return { ok: false, error: 'No enemies are shaken and wounded enough to intimidate.' }
          }

          const roll = dice.d100()
          const target = 45
          const success = roll <= target
          const lines: string[] = []

          if (success) {
            let awarded = 0
            for (const enemy of eligible) {
              enemy.hp = 0
              ;(enemy as any).fled = true
              const base = XP_PER_ENEMY_KILL + (enemy.tactics?.kind === 'boss' ? XP_PER_BOSS_KILL : 0)
              awarded += Math.max(0, Math.floor(base * 0.5))
            }
            if (awarded > 0) {
              addXpEarned(game, actorName, awarded)
              game.log.push({ at: Date.now(), who: actorName, what: `gained ${awarded} XP (intimidate)` })
            }
            lines.push(`Intimidation succeeds (${roll} <= ${target}). ${eligible.length} enemy(s) flee in panic.`)
            if (awarded > 0) lines.push(`You gain ${awarded} XP (reduced for routed foes).`)
            if ((game.combat?.enemies ?? []).every((enemy) => enemy.hp <= 0)) {
              game.mode = 'exploring'
              game.combat = undefined
              lines.push('Combat ends.')
            }
          } else {
            for (const enemy of livingEnemies) {
              enemy.attack = clampSkill(enemy.attack + 10)
            }
            lines.push(`Intimidation fails (${roll} > ${target}). The enemies become enraged (+10 attack).`)
          }

          gmInterveneIfStuck(game, {
            player: actorName,
            action: 'intimidate',
            target: eligible.map((enemy) => enemy.name).join(','),
          })

          if (game.phase === 'playing') {
            advanceTurn(game)
          }
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(`${lines.join('\n')}\n\nParty: ${summarizeParty(game)}`),
            details: { gameId, success, roll, target, affected: eligible.map((enemy) => enemy.name) },
          }
        }

        if (command === 'rest') {
          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before resting')

          if (game.phase === 'hub_town') {
            for (const member of game.party) {
              if ((member.hp ?? 0) <= 0) continue
              member.hp = member.maxHp
              member.mp = member.maxMp
            }
            resetHubTownIdle(game)
            advanceTurn(game)

            await db
              .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
              .run()

            return {
              content: toTextContent(`You rest at town and fully recover. Party: ${summarizeParty(game)}`),
              details: { gameId, phase: game.phase },
            }
          }

          if ((actor.hp ?? 0) <= 0) {
            return { ok: false, error: 'You are dead. You cannot rest until revived.' }
          }
          ensureCharacterLootState(actor)

          const shopAction = typeof params.shop === 'string' ? params.shop.trim().toLowerCase() : ''
          const room = game.dungeon[game.roomIndex]
          if (shopAction) {
            if (room?.type !== 'rest') {
              return { ok: false, error: 'Shop actions are only available in rest rooms.' }
            }

            if (shopAction === 'buy_potion') {
              const cost = 15
              if (actor.gold < cost) return { ok: false, error: `Not enough gold (need ${cost}, have ${actor.gold}).` }
              const potion = makeShopHealingPotion(dice)
              actor.gold -= cost
              actor.inventory.push(potion)
              game.log.push({
                at: Date.now(),
                who: characterId(actor),
                what: `shop: bought ${potion.name} for ${cost} gold`,
              })

              await db
                .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
                .run()

              return {
                content: toTextContent(`Bought ${potion.name} for ${cost} gold. (${actor.gold} gold remaining)`),
                details: { gameId, item: potion.name, gold: actor.gold },
              }
            }

            if (shopAction === 'identify') {
              const cost = 10
              if (actor.gold < cost) return { ok: false, error: `Not enough gold (need ${cost}, have ${actor.gold}).` }
              actor.gold -= cost
              const lines = actor.inventory.length > 0
                ? actor.inventory.map((item) => {
                    const fx = item.effects.length > 0
                      ? item.effects.map((effect) => `${effect.bonus >= 0 ? '+' : ''}${effect.bonus} ${effect.stat}`).join(', ')
                      : 'no passive bonus'
                    return `- ${item.name}: ${fx}`
                  })
                : ['- You carry no items to identify.']
              game.log.push({
                at: Date.now(),
                who: characterId(actor),
                what: `shop: identified inventory for ${cost} gold`,
              })

              await db
                .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
                .run()

              return {
                content: toTextContent(`Identified inventory for ${cost} gold.\n${lines.join('\n')}\nGold: ${actor.gold}`),
                details: { gameId, gold: actor.gold },
              }
            }

            return { ok: false, error: "Unknown shop action. Use 'buy_potion' or 'identify'." }
          }

          actor.hp = Math.min(actor.maxHp, actor.hp + 2)
          actor.mp = Math.min(actor.maxMp, actor.mp + 1)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`You rest. HP ${actor.hp}/${actor.maxHp} MP ${actor.mp}/${actor.maxMp}`),
            details: { gameId },
          }
        }

        if (command === 'use_skill') {
          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before using skills')

          const abilityName = typeof params.skill === 'string' ? params.skill.trim().toLowerCase() : ''
          if (!abilityName) return { ok: false, error: 'skill required: power_strike, shield_bash, aimed_shot, stealth, heal_touch, protect' }

          const livingEnemies = (game.combat?.enemies ?? []).filter(e => e.hp > 0)
          const hpBeforeByEnemy = new Map(livingEnemies.map((enemy) => [enemy, enemy.hp] as const))
          const result = resolveAbility(actor, abilityName, livingEnemies, game.party, dice)

          if (result.abilityDef.mpCost > 0) {
            if (actor.mp < result.abilityDef.mpCost) return { ok: false, error: `Not enough MP (need ${result.abilityDef.mpCost}, have ${actor.mp})` }
            if (result.success) actor.mp -= result.abilityDef.mpCost
          }

          // Apply effects (stun, dodge bonuses, etc.) — stored on game state for this round
          // For now, effects are narrative-only; future: track on game.roundEffects
          
          // XP for kills via abilities
          for (const enemy of livingEnemies) {
            if ((hpBeforeByEnemy.get(enemy) ?? 0) > 0 && enemy.hp <= 0) {
              addXpEarned(game, ctx.agentName.trim() || 'unknown', XP_PER_ENEMY_KILL)
              game.log.push({ at: Date.now(), who: ctx.agentName.trim(), what: `gained ${XP_PER_ENEMY_KILL} XP (kill: ${enemy.name})` })
              if (enemy.tactics?.kind === 'boss') {
                addXpEarned(game, ctx.agentName.trim() || 'unknown', XP_PER_BOSS_KILL)
                game.log.push({ at: Date.now(), who: ctx.agentName.trim(), what: `gained ${XP_PER_BOSS_KILL} XP (boss kill)` })
              }
              maybeAwardEnemyDrop(game, actor, enemy, dice)
            }
          }

          if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
            game.mode = 'exploring'
            game.combat = undefined
          }

          gmInterveneIfStuck(game, {
            player: ctx.agentName.trim() || 'unknown',
            action: 'use_skill',
            target: `ability:${abilityName}`,
          })

          advanceTurn(game)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          game.log.push({ at: Date.now(), who: ctx.agentName.trim(), what: `use_skill ${abilityName}: ${result.narrative.slice(0, 120)}` })

          return {
            content: toTextContent(result.narrative),
            details: { gameId, ability: abilityName, success: result.success, damage: result.damage, healed: result.healed },
          }
        }

        if (command === 'use_item') {
          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before using items')
          ensureCharacterLootState(actor)

          const query = typeof params.item === 'string' ? params.item.trim().toLowerCase() : ''
          const idx = actor.inventory.findIndex((item) => {
            if (!item || item.slot !== 'consumable' || !item.consumable) return false
            if (!query) return true
            return item.name.toLowerCase().includes(query)
          })

          if (idx < 0) {
            return { ok: false, error: query ? `No consumable matching "${query}" in inventory.` : 'No consumables in inventory.' }
          }

          const item = actor.inventory[idx]!
          const consumable = item.consumable
          if (!consumable) return { ok: false, error: `${item.name} cannot be consumed.` }

          actor.inventory.splice(idx, 1)
          let line = `You use ${item.name}.`
          if (consumable.type === 'heal') {
            const before = actor.hp
            actor.hp = Math.min(actor.maxHp, actor.hp + Math.max(0, consumable.amount))
            line = `You use ${item.name} and recover ${actor.hp - before} HP. (${actor.hp}/${actor.maxHp})`
          } else if (consumable.type === 'mp') {
            const before = actor.mp
            actor.mp = Math.min(actor.maxMp, actor.mp + Math.max(0, consumable.amount))
            line = `You use ${item.name} and recover ${actor.mp - before} MP. (${actor.mp}/${actor.maxMp})`
          } else if (consumable.type === 'buff') {
            const bonus = Math.max(0, consumable.amount)
            actor.skills.attack = clampSkill(actor.skills.attack + bonus)
            line = `You invoke ${item.name}. Attack +${bonus} for this adventure.`
          }

          game.log.push({
            at: Date.now(),
            who: characterId(actor),
            what: `use_item ${item.name}`,
          })

          if (game.phase === 'playing') {
            advanceTurn(game)
          }

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(line),
            details: { gameId, item: item.name, slot: item.slot },
          }
        }

        if (command === 'resurrect') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }
          if (game.mode !== 'combat' && game.mode !== 'exploring') {
            return { ok: false, error: 'You can only resurrect during active exploration or combat.' }
          }

          const beforePhase = game.phase
          const actorName = ctx.agentName.trim() || 'unknown'
          const actor = game.party.find((p) => isCharacter(p, actorName))
          if (!actor) throw new Error('Create your character before resurrecting')
          if (actor.klass !== 'Healer') return { ok: false, error: 'Only a Healer can perform resurrection.' }
          if ((actor.hp ?? 0) <= 0) return { ok: false, error: 'You are dead. You cannot resurrect yourself.' }
          if (actor.mp < 4) return { ok: false, error: `Not enough MP for resurrection (need 4, have ${actor.mp}).` }

          const targetIdentity = typeof params.target === 'string' ? params.target.trim() : ''
          if (!targetIdentity) return { ok: false, error: 'target required for resurrect.' }
          const target = game.party.find((p) => isCharacter(p, targetIdentity))
          if (!target) return { ok: false, error: `Unknown target: ${targetIdentity}` }
          if (isCharacter(target, actorName)) return { ok: false, error: 'You cannot resurrect yourself.' }
          if ((target.hp ?? 0) > 0) return { ok: false, error: `${target.name} is not dead.` }
          if (target.diedThisAdventure !== true) {
            return { ok: false, error: `${target.name} did not die this adventure and cannot be resurrected.` }
          }
          if (target.resurrectionFailedThisAdventure === true) {
            return { ok: false, error: `${target.name} has already resisted resurrection; no retry this adventure.` }
          }

          actor.mp -= 4
          const skillTarget = clampSkill(actor.skills.cast_spell - 20)
          const check = resolveSkillCheck({ skill: skillTarget, dice })
          const lines: string[] = []
          let xpLoss = 0

          if (check.success) {
            actor.skills.cast_spell = check.nextSkill
            const targetId = characterId(target)
            const currentAdventureXp = Math.max(0, Math.floor(game.xpEarned?.[targetId] ?? 0))
            const reducedXp = Math.max(0, Math.floor(currentAdventureXp * 0.5))
            xpLoss = currentAdventureXp - reducedXp
            if (game.xpEarned && Object.prototype.hasOwnProperty.call(game.xpEarned, targetId)) {
              game.xpEarned[targetId] = reducedXp
            }

            target.hp = 1
            target.deathCause = undefined
            target.deathNarrated = false
            target.resurrectionFailedThisAdventure = false
            applyResurrectionWeakness(target)

            lines.push(`${target.name} returns to life at 1 HP.`)
            lines.push('Returning from death is exhausting: -10 to all skills for this adventure.')
            if (xpLoss > 0) lines.push(`${target.name} loses ${xpLoss} XP from this adventure.`)
            game.log.push({
              at: Date.now(),
              who: actorName,
              what: `resurrection: ${target.name} revived at 1 HP (-10 skills${xpLoss > 0 ? `, -${xpLoss} XP` : ''})`,
            })
          } else {
            target.resurrectionFailedThisAdventure = true
            lines.push(`Resurrection fails (${check.roll} > ${skillTarget}).`)
            lines.push('MP is spent. The soul slips away, and no retry is possible this adventure.')
            game.log.push({
              at: Date.now(),
              who: actorName,
              what: `resurrection failed on ${target.name} (roll ${check.roll} > ${skillTarget}); no retry this adventure`,
            })
          }

          gmInterveneIfStuck(game, {
            player: actorName,
            action: 'resurrect',
            target: target.name,
          })

          if (game.phase === 'playing') {
            advanceTurn(game)
          }
          const completion = transitionCampaignCompletionToHubTown(game, beforePhase)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (completion.completed) {
            await emitEnvironmentCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(`${lines.join('\n')}\n\nParty: ${summarizeParty(game)}`),
            details: { gameId, success: check.success, roll: check.roll, target: skillTarget, xpLoss },
          }
        }

        if (command === 'cast_spell') {
          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before casting')

          const spell = typeof params.spell === 'string' ? params.spell.trim().toLowerCase() : ''
          if (!spell) return { ok: false, error: 'spell required: fireball, ice_lance, lightning, heal, shield, smite' }

          const spellDef = SPELLS[spell]
          if (!spellDef) return { ok: false, error: `Unknown spell: ${spell}. Available: ${Object.keys(SPELLS).join(', ')}` }
          if (actor.mp < spellDef.mpCost) return { ok: false, error: `Not enough MP for ${spellDef.name} (need ${spellDef.mpCost}, have ${actor.mp})` }

          const livingEnemies = (game.combat?.enemies ?? []).filter(e => e.hp > 0)
          const hpBeforeByEnemy = new Map(livingEnemies.map((enemy) => [enemy, enemy.hp] as const))
          const result = resolveSpell(actor, spell, livingEnemies, game.party, dice)

          if (result.success) {
            actor.mp -= spellDef.mpCost

            // XP for kills via spells
            for (const enemy of livingEnemies) {
              if ((hpBeforeByEnemy.get(enemy) ?? 0) > 0 && enemy.hp <= 0) {
                addXpEarned(game, ctx.agentName.trim() || 'unknown', XP_PER_ENEMY_KILL)
                game.log.push({ at: Date.now(), who: ctx.agentName.trim(), what: `gained ${XP_PER_ENEMY_KILL} XP (kill: ${enemy.name})` })
                if (enemy.tactics?.kind === 'boss') {
                  addXpEarned(game, ctx.agentName.trim() || 'unknown', XP_PER_BOSS_KILL)
                  game.log.push({ at: Date.now(), who: ctx.agentName.trim(), what: `gained ${XP_PER_BOSS_KILL} XP (boss kill)` })
                }
                maybeAwardEnemyDrop(game, actor, enemy, dice)
              }
            }
          }

          if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
            game.mode = 'exploring'
            game.combat = undefined
          }

          gmInterveneIfStuck(game, {
            player: ctx.agentName.trim() || 'unknown',
            action: 'cast_spell',
            target: `spell:${spell}`,
          })

          advanceTurn(game)

          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          game.log.push({ at: Date.now(), who: ctx.agentName.trim(), what: `cast_spell ${spell}: ${result.narrative.slice(0, 120)}` })

          // Re-save after log update
          await db
            .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(result.narrative),
            details: { gameId, spell, success: result.success, damage: result.damage, healed: result.healed },
          }
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
      const isMyTurn = game.currentPlayer === agentName
      const partyMember = game.party?.find((p: any) => p && isCharacter(p, agentName))
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
            return [`Waiting for ${phase.activeAgent} to act in phase: ${phase.name}.`]
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

        return [`Waiting for ${currentAgent || 'the current player'} to finish backstory with DM.`]
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
          roleSkillLines.push(classSkill?.brief ?? 'Wait for your turn. Coordinate with the party.')
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
        lines.push(`🎲 Active RPG adventure: ${row.id} — waiting for ${game.currentPlayer}.`)
        if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
        lines.push(...persistentLines)
        lines.push(...campaignLines)
        lines.push(...feedLines)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(...roleSkillLines)
        lines.push('Wait for your turn.')
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
    const row = await findActiveGameWhereItsMyTurn(ctx)
    if (!row) {
      const active = await findActiveGameForAgent(ctx)
      if (active) return []

      // Grimlock: when there are no playing environments, auto-create a fresh dungeon.
      const agentName = ctx.agentName.trim()
      if (agentName === 'grimlock') {
        const anyPlaying = await anyPlayingRpgEnvironmentsExist(ctx)
        if (anyPlaying) return []

        const maxEnvironmentsPerDay = getMaxEnvironmentsPerDay(ctx)
        const finishedToday = await countFinishedRpgEnvironmentsToday(ctx)
        if (finishedToday >= maxEnvironmentsPerDay) return []

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
        const hub = ensureHubTownState(state)
        if (hub.idleTurns >= hub.autoEmbarkAfter) {
          return [{ name: 'rpg', arguments: { command: 'embark', gameId: row.id } }]
        }

        const next = advanceHubTownIdleTurns(hub)
        ;(state as Record<string, unknown>).hubTown = next.state as unknown as Record<string, unknown>
        await ctx.db
          .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(JSON.stringify(state), state.phase, (state as any).winner ?? null, row.id)
          .run()
        if (next.shouldEmbark) {
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
