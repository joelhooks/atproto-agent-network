import type { PiAgentTool } from '@atproto-agent/agent'

import { createCampaign, getCampaign, updateCampaign } from '../environments/rpg'
import {
  craftDungeonFromLibrary,
  recordNarrativeBeat,
  type CampaignState,
  type DifficultyTier,
  type Enemy,
  type Faction,
  type RpgClass,
  type RpgGameState,
  type Room,
  type StoryArc,
} from '../games/rpg-engine'
import type { EnvironmentContext } from '../environments/types'

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function parseWebhook(input: string): { url: string; headers: Record<string, string> } {
  const parsed = new URL(input)
  const token = parsed.searchParams.get('token')
  if (token) parsed.searchParams.delete('token')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return { url: parsed.toString(), headers }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

function isGrimlock(name: string): boolean {
  return name.trim().toLowerCase() === 'grimlock'
}

type GameRow = { id: string; state: string; type?: string | null; phase?: string | null; players?: string | null }

async function consultLibrary(ctx: EnvironmentContext, query: string): Promise<string> {
  if (!ctx.webhookUrl) throw new Error('Grimlock webhookUrl is not configured')

  const { url, headers } = parseWebhook(ctx.webhookUrl)
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'consult_library', query, limit: 3, expand: 2000 }),
  })

  let resultText = ''
  const contentType = response.headers.get('Content-Type') ?? ''
  if (contentType.includes('application/json')) {
    const json = (await response.json()) as unknown
    if (isRecord(json) && typeof json.text === 'string') resultText = json.text
    else if (isRecord(json) && typeof json.result === 'string') resultText = json.result
    else resultText = JSON.stringify(json)
  } else {
    resultText = await response.text()
  }

  resultText = String(resultText ?? '').trim()
  if (!response.ok) {
    throw new Error(`consult_library webhook error (${response.status}): ${resultText || 'unknown error'}`)
  }

  return resultText
}

function cacheLibraryResult(game: RpgGameState, query: string, resultText: string): void {
  game.libraryContext ??= {}
  game.libraryContext[query] = resultText
  // Keep the cache bounded so D1 state doesn't bloat.
  const keys = Object.keys(game.libraryContext)
  if (keys.length > 25) {
    for (const k of keys.slice(0, keys.length - 25)) delete game.libraryContext[k]
  }
}

async function loadRpgGame(ctx: EnvironmentContext, gameId: string): Promise<RpgGameState> {
  const row = await ctx.db
    .prepare("SELECT id, state, type, phase FROM environments WHERE id = ? AND type = 'rpg'")
    .bind(gameId)
    .first<GameRow>()
  if (!row?.state) throw new Error(`Game not found: ${gameId}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(row.state)
  } catch {
    throw new Error(`Corrupt game state JSON: ${gameId}`)
  }
  const game = parsed as RpgGameState
  if (!game || game.type !== 'rpg') throw new Error(`Not an RPG game: ${gameId}`)
  return game
}

async function findActiveGameForGrimlock(ctx: EnvironmentContext): Promise<string | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null
  const row = await ctx.db
    .prepare("SELECT id FROM environments WHERE type = 'rpg' AND phase IN ('playing', 'setup') AND players LIKE ? ORDER BY updated_at DESC LIMIT 1")
    .bind(`%${agentName}%`)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function persistRpgGame(ctx: EnvironmentContext, game: RpgGameState): Promise<void> {
  await ctx.db
    .prepare("UPDATE environments SET state = ?, phase = ?, updated_at = datetime('now') WHERE id = ? AND type = 'rpg'")
    .bind(JSON.stringify(game), game.phase, game.id)
    .run()
}

function clampText(value: unknown, max = 800): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function clampInt(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(range.min, Math.min(range.max, Math.floor(n)))
}

function ensureRoomMeta(room: Room): Room & { hazards?: string[]; gmEvents?: Array<{ at: number; kind: string; text: string }> } {
  return room as any
}

function adjustEnemyStats(enemies: Enemy[], input: { hpDelta: number; attackDelta: number; dodgeDelta: number; dexDelta: number }): void {
  for (const enemy of enemies) {
    enemy.hp = Math.max(0, enemy.hp + input.hpDelta)
    enemy.attack = Math.max(0, enemy.attack + input.attackDelta)
    enemy.dodge = Math.max(0, enemy.dodge + input.dodgeDelta)
    enemy.DEX = Math.max(0, enemy.DEX + input.dexDelta)
  }
}

function summarizeParty(game: RpgGameState): string {
  const party = Array.isArray(game.party) ? game.party : []
  const deaths = party.filter((p) => (p?.hp ?? 0) <= 0).map((p) => p.name)

  const nearDeaths = new Set<string>()
  const loot = new Set<string>()
  for (const entry of Array.isArray(game.log) ? game.log : []) {
    const what = typeof entry?.what === 'string' ? entry.what : ''
    if (what.startsWith('near-death:')) {
      const name = what.slice('near-death:'.length).trim()
      if (name) nearDeaths.add(name)
    }
    if (what.startsWith('treasure: found')) {
      const item = what.slice('treasure: found'.length).trim()
      if (item) loot.add(item)
    }
  }

  const status = party
    .map((p) => `${p.name}(${p.klass}) HP ${p.hp}/${p.maxHp} MP ${p.mp}/${p.maxMp}`)
    .join(' | ')

  const roomsCleared = Math.max(0, Math.floor(game.roomIndex))
  const totalRooms = Array.isArray(game.dungeon) ? game.dungeon.length : 0

  return (
    `Party: ${status || '(empty)'}\n` +
    `Rooms cleared: ${roomsCleared}/${Math.max(0, totalRooms - 1)} (index ${game.roomIndex})\n` +
    `Deaths: ${deaths.length}${deaths.length ? ` (${deaths.join(', ')})` : ''}\n` +
    `Near-deaths: ${nearDeaths.size}${nearDeaths.size ? ` (${Array.from(nearDeaths).join(', ')})` : ''}\n` +
    `Loot: ${loot.size ? Array.from(loot).join(', ') : '(none)'}`
  )
}

function uniquePartyClasses(party: RpgGameState['party']): RpgClass[] {
  const out = new Set<RpgClass>()
  for (const member of Array.isArray(party) ? party : []) {
    const klass = (member as any)?.klass
    if (klass === 'Warrior' || klass === 'Scout' || klass === 'Mage' || klass === 'Healer') out.add(klass)
  }
  return Array.from(out)
}

function rewriteDungeonThemePrefix(dungeon: Room[], fromTheme: string, toTheme: string): void {
  if (!fromTheme || !toTheme || fromTheme === toTheme) return
  const fromPrefix = `${fromTheme}:`
  const toPrefix = `${toTheme}:`
  for (const room of dungeon) {
    const desc = String((room as any)?.description ?? '')
    if (!desc) continue
    if (desc.startsWith(fromPrefix)) (room as any).description = `${toPrefix}${desc.slice(fromPrefix.length)}`
    else if (!desc.startsWith(toPrefix)) (room as any).description = `${toPrefix} ${desc}`
  }
}

type CampaignPlanNpc = {
  name: string
  role: string
  description: string
}

type CampaignPlanFaction = {
  name: string
  description: string
  disposition: number
  keyNpc: CampaignPlanNpc
}

type CampaignPlanVillain = {
  name: string
  description: string
  objective: string
  lieutenants: CampaignPlanNpc[]
}

type CampaignPlanHubTownLocation = {
  name: string
  description: string
  shopkeeper?: string
  questGiver?: string
}

type CampaignPlanStoryArc = {
  name: string
  status: 'seeded' | 'active' | 'climax'
  plotPoints: string[]
}

type CampaignPlan = {
  campaignName: string
  premise: string
  factions: CampaignPlanFaction[]
  centralVillain: CampaignPlanVillain
  alliedNpcs: CampaignPlanNpc[]
  hubTown: {
    name: string
    description: string
    locations: CampaignPlanHubTownLocation[]
  }
  storyArcs: CampaignPlanStoryArc[]
  regionalMap: Array<{ name: string; description: string }>
}

const PLAN_CAMPAIGN_MODEL = '@cf/meta/llama-3.1-8b-instruct'
const ADVANCE_CAMPAIGN_MODEL = PLAN_CAMPAIGN_MODEL
const CRAFT_DUNGEON_MODEL = PLAN_CAMPAIGN_MODEL

function slugify(value: string): string {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'unknown'
}

function normalizeDisposition(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(-100, Math.min(100, Math.floor(n)))
}

function normalizeCampaignNpc(raw: unknown, fallbackRole = 'Contact'): CampaignPlanNpc | null {
  if (!isRecord(raw)) return null
  const name = clampText(raw.name, 80)
  if (!name) return null
  const role = clampText(raw.role, 60) || fallbackRole
  const description = clampText(raw.description, 300) || 'No details recorded.'
  return { name, role, description }
}

function normalizeCampaignFaction(raw: unknown): CampaignPlanFaction | null {
  if (!isRecord(raw)) return null
  const name = clampText(raw.name, 80)
  if (!name) return null
  const description = clampText(raw.description, 320) || 'No details recorded.'
  const disposition = normalizeDisposition(raw.disposition)
  const keyNpc = normalizeCampaignNpc(raw.keyNpc, 'Faction Contact') ?? {
    name: `${name} Envoy`,
    role: 'Faction Contact',
    description: 'Primary liaison for this faction.',
  }
  return { name, description, disposition, keyNpc }
}

function normalizeCampaignVillain(raw: unknown): CampaignPlanVillain {
  const src = isRecord(raw) ? raw : {}
  const name = clampText(src.name, 80) || 'The Ash Regent'
  const description = clampText(src.description, 320) || 'A calculating tyrant consolidating power across the frontier.'
  const objective = clampText(src.objective, 320) || 'Seize control of the region by force and oathbreaking.'
  const lieutenants = Array.isArray(src.lieutenants)
    ? src.lieutenants
      .map((entry) => normalizeCampaignNpc(entry, 'Lieutenant'))
      .filter((entry): entry is CampaignPlanNpc => Boolean(entry))
      .slice(0, 4)
    : []
  return {
    name,
    description,
    objective,
    lieutenants: lieutenants.length > 0
      ? lieutenants
      : [{ name: 'Captain of Blades', role: 'Lieutenant', description: 'Leads the villain’s strike forces.' }],
  }
}

function normalizeHubTownLocation(raw: unknown): CampaignPlanHubTownLocation | null {
  if (!isRecord(raw)) return null
  const name = clampText(raw.name, 80)
  if (!name) return null
  const description = clampText(raw.description, 300) || 'No details recorded.'
  const shopkeeper = clampText(raw.shopkeeper, 80)
  const questGiver = clampText(raw.questGiver, 80)
  return {
    name,
    description,
    ...(shopkeeper ? { shopkeeper } : {}),
    ...(questGiver ? { questGiver } : {}),
  }
}

function normalizeStoryArc(raw: unknown): CampaignPlanStoryArc | null {
  if (!isRecord(raw)) return null
  const name = clampText(raw.name, 120)
  if (!name) return null
  const statusRaw = clampText(raw.status, 20).toLowerCase()
  const status: CampaignPlanStoryArc['status'] =
    statusRaw === 'active' || statusRaw === 'climax' ? statusRaw : 'seeded'
  const plotPoints = Array.isArray(raw.plotPoints)
    ? raw.plotPoints
      .map((entry) => (typeof entry === 'string' ? clampText(entry, 220) : isRecord(entry) ? clampText(entry.description, 220) : ''))
      .filter(Boolean)
      .slice(0, 6)
    : []
  return { name, status, plotPoints: plotPoints.length > 0 ? plotPoints : ['Advance this arc with a decisive mission.'] }
}

function parseJsonObjectText(text: string): unknown {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  const codeFence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = codeFence ? codeFence[1]!.trim() : trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function extractAiResponseText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!isRecord(result)) return ''
  if (typeof result.response === 'string') return result.response
  if (typeof result.result === 'string') return result.result
  if (typeof result.text === 'string') return result.text
  if (isRecord(result.result) && typeof result.result.response === 'string') return result.result.response
  if (Array.isArray(result.data) && typeof result.data[0] === 'string') return result.data[0]
  return JSON.stringify(result)
}

function describePartyForCampaign(game: RpgGameState, partyHint: string): string {
  if (partyHint) return partyHint
  const party = Array.isArray(game.party) ? game.party : []
  return party
    .map((member) => {
      const level = Number.isFinite(member.level) ? Math.max(1, Math.floor(member.level as number)) : 1
      const backstory = clampText(member.backstory, 220)
      return `${member.name} (${member.klass}, level ${level})${backstory ? ` — ${backstory}` : ''}`
    })
    .join('\n')
}

function describePartyForDungeon(game: RpgGameState, partyHint: string): string {
  if (partyHint) return partyHint
  const party = Array.isArray(game.party) ? game.party : []
  return party
    .map((member) => {
      const level = Number.isFinite(member.level) ? Math.max(1, Math.floor(member.level as number)) : 1
      const backstory = clampText(member.backstory, 220)
      return (
        `${member.name} (${member.klass}, level ${level}) ` +
        `HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp} ` +
        `STR ${member.stats.STR} DEX ${member.stats.DEX} INT ${member.stats.INT} WIS ${member.stats.WIS}` +
        `${backstory ? ` — ${backstory}` : ''}`
      )
    })
    .join('\n')
}

function describeCampaignForDungeon(game: RpgGameState): string {
  const context = game.campaignContext
  const lines: string[] = []
  if (context) {
    lines.push(`Campaign: ${context.name} (${context.id})`)
    lines.push(`Premise: ${context.premise}`)
    if (Array.isArray(context.activeArcs) && context.activeArcs.length > 0) lines.push(`Active arcs: ${context.activeArcs.join(', ')}`)
    if (Array.isArray(context.factions) && context.factions.length > 0) lines.push(`Factions: ${context.factions.join(', ')}`)
    if (Array.isArray(context.npcs) && context.npcs.length > 0) lines.push(`NPCs: ${context.npcs.join(', ')}`)
  }
  const recentLog = Array.isArray(game.campaignLog) ? game.campaignLog.slice(-8) : []
  if (recentLog.length > 0) {
    lines.push('Recent campaign events:')
    for (const event of recentLog) lines.push(`- ${clampText(event, 320)}`)
  }
  return lines.join('\n')
}

function normalizeDifficultyTier(value: unknown): DifficultyTier | undefined {
  const tier = clampText(value, 20).toLowerCase()
  if (tier === 'easy' || tier === 'medium' || tier === 'hard' || tier === 'deadly' || tier === 'boss') return tier
  return undefined
}

function normalizeAiEnemy(raw: unknown, index: number): Enemy | null {
  if (!isRecord(raw)) return null
  const name = clampText(raw.name, 80) || `Enemy ${index + 1}`
  const hp = clampInt(raw.hp, 14, { min: 1, max: 999 })
  const DEX = clampInt((raw as Record<string, unknown>).DEX ?? raw.dex, 45, { min: 1, max: 99 })
  const attack = clampInt(raw.attack, 30, { min: 1, max: 99 })
  const dodge = clampInt(raw.dodge, 20, { min: 0, max: 99 })
  return { name, hp, DEX, attack, dodge }
}

function withThemePrefix(themeName: string, description: string): string {
  const theme = String(themeName || '').trim()
  const desc = String(description || '').trim()
  if (!theme) return desc
  if (!desc) return theme
  if (desc.startsWith(`${theme}:`)) return desc
  if (desc.startsWith(`${theme} -`)) return desc
  return `${theme}: ${desc}`
}

function normalizeAiRoom(raw: unknown, input: { partyClasses: RpgClass[]; themeName: string }): Room | null {
  if (!isRecord(raw)) return null
  const type = clampText(raw.type, 20).toLowerCase()
  const description = withThemePrefix(input.themeName, clampText(raw.description, 420))
  if (!description || !type) return null
  const difficultyTier = normalizeDifficultyTier(raw.difficultyTier)
  const extraMeta = difficultyTier ? ({ difficultyTier } as const) : {}

  if (type === 'combat' || type === 'boss') {
    const enemies = Array.isArray(raw.enemies)
      ? raw.enemies
        .map((enemy, enemyIndex) => normalizeAiEnemy(enemy, enemyIndex))
        .filter((enemy): enemy is Enemy => Boolean(enemy))
        .slice(0, type === 'boss' ? 3 : 4)
      : []
    if (enemies.length === 0) return null
    return { type, description, enemies, ...extraMeta }
  }

  if (type === 'barrier') {
    const requiredClassRaw = clampText(raw.requiredClass, 20)
    const requiredClass: RpgClass =
      requiredClassRaw === 'Warrior' ||
      requiredClassRaw === 'Scout' ||
      requiredClassRaw === 'Mage' ||
      requiredClassRaw === 'Healer'
        ? requiredClassRaw
        : input.partyClasses[0] ?? 'Warrior'
    return { type: 'barrier', description, requiredClass, ...extraMeta }
  }

  if (type === 'trap' || type === 'treasure' || type === 'rest' || type === 'puzzle') {
    return { type, description, ...extraMeta }
  }

  return null
}

function buildCraftDungeonPrompt(input: {
  partySnapshot: string
  campaignSnapshot: string
  themeName: string
  libraryFindings: Array<{ query: string; result: string }>
}): string {
  const inspiration = input.libraryFindings
    .map((entry, idx) => `[${idx + 1}] ${entry.query}\n${entry.result.slice(0, 2000)}`)
    .join('\n\n')

  return (
    'Design a tabletop RPG dungeon in strict JSON.\n\n' +
    `Dungeon theme: ${input.themeName}\n\n` +
    'Party composition:\n' +
    `${input.partySnapshot || '(unknown party)'}\n\n` +
    'Active campaign context:\n' +
    `${input.campaignSnapshot || '(no active campaign context)'}\n\n` +
    'Inspiration from pdf-brain:\n' +
    `${inspiration || '(none)'}\n\n` +
    'Return ONLY JSON with this shape:\n' +
    '{\n' +
    '  "themeName": string,\n' +
    '  "difficultyCurve": ["easy|medium|hard|deadly|boss"],\n' +
    '  "rooms": [\n' +
    '    {\n' +
    '      "type": "combat|trap|treasure|rest|puzzle|boss|barrier",\n' +
    '      "description": string,\n' +
    '      "difficultyTier": "easy|medium|hard|deadly|boss",\n' +
    '      "enemies": [{ "name": string, "hp": number, "DEX": number, "attack": number, "dodge": number }],\n' +
    '      "requiredClass": "Warrior|Scout|Mage|Healer"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Requirements:\n' +
    '- Create 10 to 12 rooms total.\n' +
    '- Use varied room types (at least 4 different types across the dungeon).\n' +
    '- Include at least 2 combat rooms and exactly 1 boss room near the end.\n' +
    '- Include at least 1 barrier room with requiredClass.\n' +
    '- Difficulty curve should escalate from easy/medium to hard/deadly and end with boss.\n' +
    '- Every room description should be tactical and vivid for live play.\n'
  )
}

function defaultDifficultyTierForRoom(room: Room, index: number, total: number): DifficultyTier {
  const explicit = normalizeDifficultyTier((room as Record<string, unknown>).difficultyTier)
  if (explicit) return explicit
  if (room.type === 'boss') return 'boss'
  if (index >= Math.max(0, total - 2)) return 'deadly'
  if (index >= Math.max(0, total - 5)) return 'hard'
  if (index >= Math.max(0, total - 8)) return 'medium'
  return 'easy'
}

function normalizeCraftDungeonResult(
  raw: unknown,
  input: { partyClasses: RpgClass[]; themeName: string }
): { rooms: Room[]; difficultyCurve: DifficultyTier[]; themeName?: string } | null {
  const src = isRecord(raw) ? raw : {}
  const roomList = Array.isArray(src.rooms) ? src.rooms : Array.isArray(raw) ? raw : []
  const rooms = roomList
    .map((entry) => normalizeAiRoom(entry, input))
    .filter((entry): entry is Room => Boolean(entry))

  if (rooms.length < 10 || rooms.length > 12) return null
  const roomTypes = new Set(rooms.map((room) => room.type))
  if (roomTypes.size < 4) return null
  if (rooms.filter((room) => room.type === 'combat').length < 2) return null
  if (rooms.filter((room) => room.type === 'boss').length !== 1) return null
  if (rooms.filter((room) => room.type === 'barrier').length < 1) return null

  const requestedCurve = Array.isArray(src.difficultyCurve)
    ? src.difficultyCurve.map((tier) => normalizeDifficultyTier(tier)).filter((tier): tier is DifficultyTier => Boolean(tier))
    : []
  const difficultyCurve = requestedCurve.length === rooms.length
    ? requestedCurve
    : rooms.map((room, index) => defaultDifficultyTierForRoom(room, index, rooms.length))

  const themeName = clampText(src.themeName, 80) || clampText(src.theme, 80)
  return {
    rooms,
    difficultyCurve,
    ...(themeName ? { themeName } : {}),
  }
}

function buildPlanCampaignPrompt(input: {
  partySnapshot: string
  libraryFindings: Array<{ query: string; result: string }>
}): string {
  const inspiration = input.libraryFindings
    .map((entry, idx) => `[${idx + 1}] ${entry.query}\n${entry.result.slice(0, 2000)}`)
    .join('\n\n')

  return (
    'Design a tabletop RPG campaign in strict JSON. Use the party details and inspiration notes.\n\n' +
    'Party composition:\n' +
    `${input.partySnapshot || '(unknown party)'}\n\n` +
    'Inspiration (from pdf-brain):\n' +
    `${inspiration || '(none)'}\n\n` +
    'Return ONLY JSON with this shape:\n' +
    '{\n' +
    '  "campaignName": string,\n' +
    '  "premise": string,\n' +
    '  "factions": [\n' +
    '    { "name": string, "description": string, "disposition": number, "keyNpc": { "name": string, "role": string, "description": string } }\n' +
    '  ],\n' +
    '  "centralVillain": {\n' +
    '    "name": string,\n' +
    '    "description": string,\n' +
    '    "objective": string,\n' +
    '    "lieutenants": [{ "name": string, "role": string, "description": string }]\n' +
    '  },\n' +
    '  "alliedNpcs": [{ "name": string, "role": string, "description": string }],\n' +
    '  "hubTown": {\n' +
    '    "name": string,\n' +
    '    "description": string,\n' +
    '    "locations": [{ "name": string, "description": string, "shopkeeper": string, "questGiver": string }]\n' +
    '  },\n' +
    '  "storyArcs": [{ "name": string, "status": "seeded|active|climax", "plotPoints": [string] }],\n' +
    '  "regionalMap": [{ "name": string, "description": string }]\n' +
    '}\n\n' +
    'Constraints:\n' +
    '- 3 to 5 factions\n' +
    '- 2 to 3 alliedNpcs\n' +
    '- 3 to 4 storyArcs\n' +
    '- hubTown should have 3 to 5 locations\n' +
    '- regionalMap should have at least 4 named locations\n'
  )
}

function normalizeCampaignPlan(raw: unknown): CampaignPlan {
  const src = isRecord(raw) ? raw : {}
  const campaignName = clampText(src.campaignName, 120) || 'Untitled Campaign'
  const premise = clampText(src.premise, 500) || 'A fragile peace collapses and rival powers race to seize control.'

  const factions = Array.isArray(src.factions)
    ? src.factions
      .map((entry) => normalizeCampaignFaction(entry))
      .filter((entry): entry is CampaignPlanFaction => Boolean(entry))
      .slice(0, 5)
    : []
  const finalFactions = factions.slice(0, 5)

  const alliedNpcs = Array.isArray(src.alliedNpcs)
    ? src.alliedNpcs
      .map((entry) => normalizeCampaignNpc(entry, 'Ally'))
      .filter((entry): entry is CampaignPlanNpc => Boolean(entry))
      .slice(0, 3)
    : []
  const finalAllies = alliedNpcs.length > 0
    ? alliedNpcs
    : [
        { name: 'Quartermaster Lysa', role: 'Ally', description: 'Keeps the party supplied and informed.' },
        { name: 'Brother Ansel', role: 'Ally', description: 'Provides healing and old lore.' },
      ]

  const villain = normalizeCampaignVillain(src.centralVillain)

  const hubTownSource = isRecord(src.hubTown) ? src.hubTown : {}
  const hubTownLocations = Array.isArray(hubTownSource.locations)
    ? hubTownSource.locations
      .map((entry) => normalizeHubTownLocation(entry))
      .filter((entry): entry is CampaignPlanHubTownLocation => Boolean(entry))
      .slice(0, 5)
    : []
  const hubTown = {
    name: clampText(hubTownSource.name, 120) || 'Waystone',
    description: clampText(hubTownSource.description, 320) || 'A frontier settlement where alliances are forged under pressure.',
    locations: hubTownLocations.length > 0
      ? hubTownLocations
      : [
          {
            name: 'The Lantern Inn',
            description: 'A crowded inn where local rumors change nightly.',
            shopkeeper: 'Nia Torch',
            questGiver: 'Warden Hal',
          },
          {
            name: 'Guild Hall',
            description: 'Mercenary contracts and patron disputes are handled here.',
            shopkeeper: 'Master Varr',
            questGiver: 'Scribe Etta',
          },
          {
            name: 'Shrine of Dawn',
            description: 'Pilgrims seek blessings before dangerous expeditions.',
            shopkeeper: 'Sister Rowan',
            questGiver: 'Brother Ansel',
          },
        ],
  }

  const arcs = Array.isArray(src.storyArcs)
    ? src.storyArcs
      .map((entry) => normalizeStoryArc(entry))
      .filter((entry): entry is CampaignPlanStoryArc => Boolean(entry))
      .slice(0, 4)
    : []
  const storyArcs = arcs.length > 0
    ? arcs
    : [
        { name: 'Border Fires', status: 'active' as const, plotPoints: ['Secure the border keeps before the enemy siege line closes.'] },
        { name: 'Whispers in Court', status: 'seeded' as const, plotPoints: ['Expose the traitor passing military plans to the enemy.'] },
        { name: 'Relic Race', status: 'seeded' as const, plotPoints: ['Recover the relic key before the villain’s cult does.'] },
      ]

  const map = Array.isArray(src.regionalMap)
    ? src.regionalMap
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = clampText(entry.name, 100)
        if (!name) return null
        const description = clampText(entry.description, 260) || 'No details recorded.'
        return { name, description }
      })
      .filter((entry): entry is { name: string; description: string } => Boolean(entry))
      .slice(0, 8)
    : []
  const regionalMap = map.length > 0
    ? map
    : [
        { name: hubTown.name, description: hubTown.description },
        { name: 'Old Fortress', description: 'A crumbling bastion that controls a major road.' },
        { name: 'Blackwater Marsh', description: 'Treacherous wetlands hiding smuggler routes.' },
        { name: 'Sunken Archive', description: 'Flooded ruins holding forbidden records.' },
      ]

  const boundedFactions =
    finalFactions.length >= 3
      ? finalFactions
      : [
          ...finalFactions,
          {
            name: 'Free Banner Company',
            description: 'Mercenaries who fight for coin and grudges.',
            disposition: -5,
            keyNpc: { name: 'Captain Rook', role: 'Commander', description: 'A veteran with shifting loyalties.' },
          },
          {
            name: 'Dawn Wardens',
            description: 'Watchers sworn to protect frontier roads and villages.',
            disposition: 15,
            keyNpc: { name: 'Marshal Elia', role: 'Warden', description: 'Disciplined protector of common folk.' },
          },
          {
            name: 'Silent Ledger',
            description: 'Financiers and spies moving information for profit.',
            disposition: -20,
            keyNpc: { name: 'Ledger-Keeper Voss', role: 'Broker', description: 'Tracks debts, favors, and secrets.' },
          },
        ].slice(0, 3)

  return {
    campaignName,
    premise,
    factions: boundedFactions.slice(0, 5),
    centralVillain: villain,
    alliedNpcs: finalAllies.slice(0, 3),
    hubTown: {
      name: hubTown.name,
      description: hubTown.description,
      locations: hubTown.locations.slice(0, 5),
    },
    storyArcs: storyArcs.slice(0, 4),
    regionalMap: regionalMap.slice(0, 8),
  }
}

function campaignPlanToCreateOptions(plan: CampaignPlan): {
  worldState: {
    factions: Array<{ id: string; name: string; description: string; disposition: number; keyNpc: CampaignPlanNpc }>
    locations: Array<{ id: string; name: string; description: string }>
    events: string[]
    alliedNpcs: CampaignPlanNpc[]
    centralVillain: CampaignPlanVillain
    hubTown: CampaignPlan['hubTown']
    regionalMap: CampaignPlan['regionalMap']
  }
  storyArcs: Array<{ id: string; name: string; status: 'seeded' | 'active' | 'climax'; plotPoints: Array<{ id: string; description: string; resolved: boolean }> }>
} {
  const worldState = {
    factions: plan.factions.map((faction) => ({
      id: `faction_${slugify(faction.name)}`,
      name: faction.name,
      description: faction.description,
      disposition: normalizeDisposition(faction.disposition),
      keyNpc: faction.keyNpc,
    })),
    locations: [
      {
        id: `location_${slugify(plan.hubTown.name)}`,
        name: plan.hubTown.name,
        description: plan.hubTown.description,
      },
      ...plan.regionalMap.map((location) => ({
        id: `location_${slugify(location.name)}`,
        name: location.name,
        description: location.description,
      })),
    ],
    events: [`Campaign setup: ${plan.premise}`],
    alliedNpcs: plan.alliedNpcs.map((npc) => ({ ...npc })),
    centralVillain: {
      ...plan.centralVillain,
      lieutenants: plan.centralVillain.lieutenants.map((npc) => ({ ...npc })),
    },
    hubTown: {
      ...plan.hubTown,
      locations: plan.hubTown.locations.map((location) => ({ ...location })),
    },
    regionalMap: plan.regionalMap.map((location) => ({ ...location })),
  }

  const storyArcs = plan.storyArcs.map((arc, arcIndex) => ({
    id: `arc_${slugify(arc.name)}_${arcIndex + 1}`,
    name: arc.name,
    status: (['seeded', 'active', 'climax'].includes(arc.status) ? arc.status : 'seeded') as 'seeded' | 'active' | 'climax',
    plotPoints: arc.plotPoints.map((plotPoint, plotIndex) => ({
      id: `plot_${arcIndex + 1}_${plotIndex + 1}`,
      description: plotPoint,
      resolved: false,
    })),
  }))

  return { worldState, storyArcs }
}

function cloneStoryArcs(storyArcs: StoryArc[]): StoryArc[] {
  return (Array.isArray(storyArcs) ? storyArcs : []).map((arc) => ({
    ...arc,
    plotPoints: Array.isArray(arc.plotPoints) ? arc.plotPoints.map((plotPoint) => ({ ...plotPoint })) : [],
  }))
}

function cloneWorldState(worldState: CampaignState['worldState']): CampaignState['worldState'] {
  return {
    factions: (worldState.factions ?? []).map((faction) => ({
      ...faction,
      ...(faction.keyNpc ? { keyNpc: { ...faction.keyNpc } } : {}),
    })),
    locations: (worldState.locations ?? []).map((location) => ({ ...location })),
    events: Array.isArray(worldState.events) ? [...worldState.events] : [],
    ...(Array.isArray(worldState.alliedNpcs) ? { alliedNpcs: worldState.alliedNpcs.map((npc) => ({ ...npc })) } : {}),
    ...(worldState.centralVillain
      ? {
          centralVillain: {
            ...worldState.centralVillain,
            lieutenants: Array.isArray(worldState.centralVillain.lieutenants)
              ? worldState.centralVillain.lieutenants.map((npc) => ({ ...npc }))
              : [],
          },
        }
      : {}),
    ...(worldState.hubTown
      ? {
          hubTown: {
            ...worldState.hubTown,
            locations: Array.isArray(worldState.hubTown.locations)
              ? worldState.hubTown.locations.map((location) => ({ ...location }))
              : [],
          },
        }
      : {}),
    ...(Array.isArray(worldState.regionalMap) ? { regionalMap: worldState.regionalMap.map((location) => ({ ...location })) } : {}),
  }
}

function normalizeStoryArcStatus(value: unknown, fallback: StoryArc['status'] = 'active'): StoryArc['status'] {
  const statusRaw = clampText(value, 20).toLowerCase()
  if (
    statusRaw === 'seeded' ||
    statusRaw === 'active' ||
    statusRaw === 'climax' ||
    statusRaw === 'resolved' ||
    statusRaw === 'failed'
  ) {
    return statusRaw
  }
  return fallback
}

function normalizeAdvanceStoryArc(raw: unknown, index: number): StoryArc | null {
  if (!isRecord(raw)) return null
  const name = clampText(raw.name, 120)
  if (!name) return null
  const arcId = clampText(raw.id, 120) || `arc_${slugify(name)}_${index + 1}`
  const status = normalizeStoryArcStatus(raw.status, 'active')
  const plotPoints = Array.isArray(raw.plotPoints)
    ? raw.plotPoints
      .map((entry, plotIndex) => {
        if (typeof entry === 'string') {
          const description = clampText(entry, 260)
          if (!description) return null
          return {
            id: `plot_${slugify(name)}_${plotIndex + 1}`,
            description,
            resolved: false,
          }
        }
        if (!isRecord(entry)) return null
        const description = clampText(entry.description, 260)
        if (!description) return null
        const id = clampText(entry.id, 120) || `plot_${slugify(name)}_${plotIndex + 1}`
        const adventureId = clampText(entry.adventureId, 120)
        return {
          id,
          description,
          resolved: Boolean(entry.resolved),
          ...(adventureId ? { adventureId } : {}),
        }
      })
      .filter((entry): entry is StoryArc['plotPoints'][number] => Boolean(entry))
      .slice(0, 8)
    : []

  return {
    id: arcId,
    name,
    status,
    plotPoints,
  }
}

function parseAdventureCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.floor(n))
}

function parseEventLine(raw: unknown): string {
  if (typeof raw === 'string') return clampText(raw, 320)
  if (isRecord(raw)) return clampText(raw.description, 320)
  return ''
}

function buildAdvanceCampaignPrompt(input: {
  campaign: CampaignState
  adventureSummary: string
}): string {
  const snapshot = JSON.stringify(
    {
      id: input.campaign.id,
      name: input.campaign.name,
      premise: input.campaign.premise,
      adventureCount: input.campaign.adventureCount,
      worldState: {
        factions: input.campaign.worldState.factions,
        alliedNpcs: input.campaign.worldState.alliedNpcs ?? [],
        centralVillain: input.campaign.worldState.centralVillain ?? null,
        hubTown: input.campaign.worldState.hubTown ?? null,
        regionalMap: input.campaign.worldState.regionalMap ?? [],
        recentEvents: (input.campaign.worldState.events ?? []).slice(-12),
      },
      storyArcs: input.campaign.storyArcs,
    },
    null,
    2
  ).slice(0, 14000)

  return (
    'Advance this RPG campaign after an adventure is complete. Return strict JSON only.\n\n' +
    `Current campaign state:\n${snapshot}\n\n` +
    `Adventure outcome summary:\n${input.adventureSummary}\n\n` +
    'Decide and encode these consequences:\n' +
    '- Which factions gained or lost power\n' +
    '- Which NPCs reacted (new allies, betrayals, deaths)\n' +
    '- Which plot points resolved or advanced\n' +
    '- What new threats emerged\n' +
    '- How the hub town changed\n\n' +
    'Return ONLY JSON with this shape:\n' +
    '{\n' +
    '  "narrativeSummary": string,\n' +
    '  "campaignPatch": {\n' +
    '    "premise": string,\n' +
    '    "adventureCount": number,\n' +
    '    "worldState": {\n' +
    '      "factions": [{ "id": string, "name": string, "description": string, "disposition": number, "keyNpc": { "name": string, "role": string, "description": string } }],\n' +
    '      "locations": [{ "id": string, "name": string, "description": string }],\n' +
    '      "events": [string],\n' +
    '      "alliedNpcs": [{ "name": string, "role": string, "description": string }],\n' +
    '      "centralVillain": { "name": string, "description": string, "objective": string, "lieutenants": [{ "name": string, "role": string, "description": string }] },\n' +
    '      "hubTown": { "name": string, "description": string, "locations": [{ "name": string, "description": string, "shopkeeper": string, "questGiver": string }] },\n' +
    '      "regionalMap": [{ "name": string, "description": string }]\n' +
    '    },\n' +
    '    "storyArcs": [{ "id": string, "name": string, "status": "seeded|active|climax|resolved|failed", "plotPoints": [{ "id": string, "description": string, "resolved": boolean, "adventureId": string }] }]\n' +
    '  }\n' +
    '}\n'
  )
}

function normalizeAdvanceCampaignResult(raw: unknown, current: CampaignState): {
  narrativeSummary: string
  patch: {
    premise?: string
    adventureCount?: number
    worldState: CampaignState['worldState']
    storyArcs: StoryArc[]
  }
} {
  const src = isRecord(raw) ? raw : {}
  const patchSrc = isRecord(src.campaignPatch) ? src.campaignPatch : src
  const worldSrc = isRecord(patchSrc.worldState) ? patchSrc.worldState : patchSrc

  const currentWorld = cloneWorldState(current.worldState)
  const factionLookup = new Map(
    currentWorld.factions.map((faction) => [String(faction.id || '').trim() || faction.name.trim().toLowerCase(), faction])
  )

  const factions = Array.isArray(worldSrc.factions)
    ? worldSrc.factions
      .map((entry, idx) => {
        if (!isRecord(entry)) return null
        const name = clampText(entry.name, 80)
        if (!name) return null
        const id = clampText(entry.id, 120) || `faction_${slugify(name)}`
        const existing = factionLookup.get(id) ?? factionLookup.get(name.trim().toLowerCase())
        const keyNpc = normalizeCampaignNpc(entry.keyNpc, 'Faction Contact') ?? existing?.keyNpc ?? {
          name: `${name} Envoy`,
          role: 'Faction Contact',
          description: 'Primary liaison for this faction.',
        }
        return {
          id: `${id}${idx > 0 && id === `faction_${slugify(name)}` ? `_${idx + 1}` : ''}`,
          name,
          description: clampText(entry.description, 320) || existing?.description || 'No details recorded.',
          disposition: normalizeDisposition(
            isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'disposition')
              ? entry.disposition
              : existing?.disposition ?? 0
          ),
          keyNpc,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, 8) as Faction[]
    : currentWorld.factions

  const locations = Array.isArray(worldSrc.locations)
    ? worldSrc.locations
      .map((entry, idx) => {
        if (!isRecord(entry)) return null
        const name = clampText(entry.name, 120)
        if (!name) return null
        const id = clampText(entry.id, 120) || `location_${slugify(name)}_${idx + 1}`
        const description = clampText(entry.description, 320) || 'No details recorded.'
        return { id, name, description }
      })
      .filter((entry): entry is CampaignState['worldState']['locations'][number] => Boolean(entry))
      .slice(0, 20)
    : currentWorld.locations

  const nextEventLines = Array.isArray(worldSrc.events)
    ? worldSrc.events.map((entry) => parseEventLine(entry)).filter(Boolean)
    : []
  const events = nextEventLines.length > 0
    ? [...currentWorld.events, ...nextEventLines].slice(-100)
    : currentWorld.events

  const alliedNpcs = Array.isArray(worldSrc.alliedNpcs)
    ? worldSrc.alliedNpcs
      .map((entry) => normalizeCampaignNpc(entry, 'Ally'))
      .filter((entry): entry is NonNullable<CampaignState['worldState']['alliedNpcs']>[number] => Boolean(entry))
      .slice(0, 8)
    : currentWorld.alliedNpcs

  const centralVillain = isRecord(worldSrc.centralVillain)
    ? normalizeCampaignVillain(worldSrc.centralVillain)
    : currentWorld.centralVillain

  const hubTown = isRecord(worldSrc.hubTown)
    ? (() => {
        const name = clampText(worldSrc.hubTown.name, 120) || currentWorld.hubTown?.name || 'Waystone'
        const description =
          clampText(worldSrc.hubTown.description, 320) ||
          currentWorld.hubTown?.description ||
          'A frontier settlement where alliances are forged under pressure.'
        const locations = Array.isArray(worldSrc.hubTown.locations)
          ? worldSrc.hubTown.locations
            .map((entry) => normalizeHubTownLocation(entry))
            .filter((entry): entry is NonNullable<CampaignState['worldState']['hubTown']>['locations'][number] => Boolean(entry))
            .slice(0, 8)
          : currentWorld.hubTown?.locations ?? []
        return { name, description, locations }
      })()
    : currentWorld.hubTown

  const regionalMap = Array.isArray(worldSrc.regionalMap)
    ? worldSrc.regionalMap
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = clampText(entry.name, 100)
        if (!name) return null
        const description = clampText(entry.description, 260) || 'No details recorded.'
        return { name, description }
      })
      .filter((entry): entry is NonNullable<CampaignState['worldState']['regionalMap']>[number] => Boolean(entry))
      .slice(0, 20)
    : currentWorld.regionalMap

  const storyArcs = Array.isArray(patchSrc.storyArcs)
    ? patchSrc.storyArcs
      .map((entry, idx) => normalizeAdvanceStoryArc(entry, idx))
      .filter((entry): entry is StoryArc => Boolean(entry))
      .slice(0, 10)
    : cloneStoryArcs(current.storyArcs)
  const finalStoryArcs = storyArcs.length > 0 ? storyArcs : cloneStoryArcs(current.storyArcs)

  const worldState: CampaignState['worldState'] = {
    factions,
    locations,
    events,
    ...(Array.isArray(alliedNpcs) && alliedNpcs.length > 0 ? { alliedNpcs } : {}),
    ...(centralVillain ? { centralVillain } : {}),
    ...(hubTown ? { hubTown } : {}),
    ...(Array.isArray(regionalMap) && regionalMap.length > 0 ? { regionalMap } : {}),
  }

  const proposedPremise = clampText(patchSrc.premise, 500)
  const narrativeSummary =
    clampText(src.narrativeSummary, 2000) ||
    clampText(src.summary, 2000) ||
    clampText((patchSrc as Record<string, unknown>).narrativeSummary, 2000) ||
    (nextEventLines[0] ? `Campaign advanced: ${nextEventLines[0]}` : 'Campaign state advanced after the latest adventure.')

  const adventureCount = parseAdventureCount((patchSrc as Record<string, unknown>).adventureCount, current.adventureCount)
  return {
    narrativeSummary,
    patch: {
      ...(proposedPremise ? { premise: proposedPremise } : {}),
      ...(adventureCount !== current.adventureCount ? { adventureCount } : {}),
      worldState,
      storyArcs: finalStoryArcs,
    },
  }
}

export function createGmTool(ctx: EnvironmentContext): PiAgentTool {
  return {
    name: 'gm',
    label: 'GM',
    description:
      'Grimlock-only GM tool for live dungeon adjudication. You are the Dungeon Master — your job is to make every encounter MEMORABLE and TACTICAL.\n\n' +
      'Commands:\n' +
      '- consult_library: ALWAYS use this BEFORE crafting encounters or when the party enters a new room type. Query pdf-brain for monster tactics ("how do [monster] fight tactically"), encounter design ("interesting dungeon room ideas"), or terrain hazards. The knowledge base has "The Monsters Know What They\'re Doing" with detailed tactics for every D&D monster. USE THIS LIBERALLY.\n' +
      '- plan_campaign: Build a full campaign bible from party composition and library research. Generates factions, villain, allies, hub town, story arcs, and regional map.\n' +
      '- advance_campaign: After an adventure ends, evolve campaign world state (faction power shifts, NPC reactions, arc progression, new threats, hub town consequences) and persist updates.\n' +
      '- craft_dungeon: Design a multi-room dungeon. ALWAYS consult_library first for inspiration. Vary room types: combat, puzzle, trap, treasure, NPC encounter, environmental hazard. NEVER repeat the same monster twice in a row.\n' +
      '- narrate: Bring rooms to life with vivid sensory details. Describe sounds, smells, lighting, temperature. Make players FEEL the dungeon.\n' +
      '- add_event: Inject surprises mid-encounter: reinforcements arrive, the floor collapses, a prisoner calls for help, a rival adventuring party appears. Keep players on their toes.\n' +
      '- adjust_difficulty: If the party is steamrolling, add hazards or buff enemies. If they\'re dying, offer escape routes or weaken foes. Good DMs adapt.\n' +
      '- review_party: Check party composition and health BEFORE designing encounters. Tailor difficulty to the weakest member.\n\n' +
      'MONSTER VARIETY IS CRITICAL: Use undead, aberrations, constructs, beasts, elementals, dragons, demons, oozes, fey — NOT just goblins and humanoids. Each monster type fights differently. Consult the library to learn HOW they fight!\n\n' +
      'ENCOUNTER DESIGN: Every encounter should have at least one twist — terrain hazard, environmental effect, or tactical wrinkle. Flat rooms with flat enemies are BORING.\n',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['narrate', 'adjust_difficulty', 'add_event', 'review_party', 'craft_dungeon', 'consult_library', 'plan_campaign', 'advance_campaign'],
        },
        gameId: { type: 'string', description: 'RPG game id (optional; defaults to your active adventure).' },
        campaignId: { type: 'string', description: 'Campaign id (required for advance_campaign).' },
        adventureSummary: { type: 'string', description: 'Outcome summary for the completed adventure (required for advance_campaign).' },
        roomIndex: { type: 'number', description: 'Target room index (defaults to current room).' },
        text: { type: 'string', description: 'Narration/event text.' },
        kind: { type: 'string', description: 'Event kind (npc|hazard|loot|twist|other).' },
        query: { type: 'string', description: 'pdf-brain search query (consult_library)' },
        theme: { type: 'string', description: 'Optional theme hint for craft_dungeon.' },
        partyComposition: { type: 'string', description: 'Optional party composition hint (craft_dungeon, plan_campaign).' },
        // Difficulty knobs (apply broadly to the room)
        enemyHpDelta: { type: 'number' },
        enemyAttackDelta: { type: 'number' },
        enemyDodgeDelta: { type: 'number' },
        enemyDexDelta: { type: 'number' },
        autoCrumbleAttempts: { type: 'number', description: 'Barrier auto-crumble threshold (default 5).' },
        skillCheckTarget: { type: 'number', description: 'Barrier skill check target percentage (default 30).' },
        addHazard: { type: 'string', description: 'Add a hazard tag to the room.' },
        removeHazard: { type: 'string', description: 'Remove a hazard tag from the room.' },
      },
      required: ['command'],
    },
    execute: async (_toolCallId: string, rawParams: unknown) => {
      if (!isGrimlock(ctx.agentName)) {
        throw new Error('tool not available')
      }

      const params = normalizeArgs(rawParams)
      const command = typeof params.command === 'string' ? params.command : ''

      if (command === 'advance_campaign') {
        const campaignId = clampText(params.campaignId, 160)
        const adventureSummary = clampText(params.adventureSummary, 4000)
        if (!campaignId) throw new Error('campaignId is required for advance_campaign')
        if (!adventureSummary) throw new Error('adventureSummary is required for advance_campaign')

        const campaign = await getCampaign(ctx.db, campaignId)
        if (!campaign) throw new Error(`Campaign not found: ${campaignId}`)

        const ai = isRecord(ctx.env) && isRecord(ctx.env.AI) && typeof (ctx.env.AI as { run?: unknown }).run === 'function'
          ? (ctx.env.AI as { run: (model: string, input: Record<string, unknown>) => Promise<unknown> })
          : null
        if (!ai) throw new Error('AI binding unavailable for advance_campaign')

        const prompt = buildAdvanceCampaignPrompt({ campaign, adventureSummary })
        const aiResult = await ai.run(ADVANCE_CAMPAIGN_MODEL, {
          messages: [
            {
              role: 'system',
              content:
                'You are a veteran campaign GM. Return strict JSON only. No prose outside JSON.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.25,
          max_tokens: 3500,
        })

        const responseText = extractAiResponseText(aiResult)
        const parsed = parseJsonObjectText(responseText)
        const normalized = normalizeAdvanceCampaignResult(parsed, campaign)
        await updateCampaign(ctx.db, campaignId, normalized.patch as any)
        const updatedCampaign = (await getCampaign(ctx.db, campaignId)) ?? campaign

        return {
          content: toTextContent(normalized.narrativeSummary),
          details: {
            campaignId,
            campaign: updatedCampaign,
            campaignPatch: normalized.patch,
          },
        }
      }

      const explicitGameId = typeof params.gameId === 'string' ? params.gameId.trim() : ''
      const gameId = explicitGameId || (await findActiveGameForGrimlock(ctx))
      if (!gameId) throw new Error('No active RPG game found')

      const game = await loadRpgGame(ctx, gameId)

      const now = Date.now()

      if (command === 'review_party') {
        const summary = summarizeParty(game)
        game.log.push({ at: now, who: 'GM', what: '[GM] review_party' })
        await persistRpgGame(ctx, game)
        return { content: toTextContent(summary), details: { gameId, roomIndex: game.roomIndex } }
      }

      if (command === 'consult_library') {
        const query = clampText(params.query, 240)
        if (!query) throw new Error('query is required for consult_library')

        const resultText = await consultLibrary(ctx, query)
        cacheLibraryResult(game, query, resultText)

        game.log.push({ at: now, who: 'GM', what: `[GM] consult_library: ${query}` })
        recordNarrativeBeat(game, { kind: 'gm', text: 'consult_library', roomIndex: game.roomIndex, at: now })
        await persistRpgGame(ctx, game)

        return { content: toTextContent(resultText || '(no results)'), details: { gameId, roomIndex: game.roomIndex, query } }
      }

      if (command === 'plan_campaign') {
        const partyHint = clampText(params.partyComposition, 1200)
        const partySnapshot = describePartyForCampaign(game, partyHint)
        if (!partySnapshot) throw new Error('party composition is required for plan_campaign')

        const libraryQueries = [
          'campaign design patterns for party-driven arcs (Game Angry)',
          "faction design patterns and fronts for long campaigns (The Monsters Know What They're Doing, DM advice)",
          'hub town and regional map design for sandbox campaigns',
        ]
        const libraryFindings: Array<{ query: string; result: string }> = []
        for (const query of libraryQueries) {
          const resultText = await consultLibrary(ctx, query)
          cacheLibraryResult(game, query, resultText)
          libraryFindings.push({ query, result: resultText })
        }

        const prompt = buildPlanCampaignPrompt({
          partySnapshot,
          libraryFindings,
        })

        const ai = isRecord(ctx.env) && isRecord(ctx.env.AI) && typeof (ctx.env.AI as { run?: unknown }).run === 'function'
          ? (ctx.env.AI as { run: (model: string, input: Record<string, unknown>) => Promise<unknown> })
          : null
        if (!ai) throw new Error('AI binding unavailable for plan_campaign')

        const aiResult = await ai.run(PLAN_CAMPAIGN_MODEL, {
          messages: [
            {
              role: 'system',
              content:
                'You are a veteran tabletop campaign designer. Return strict JSON only. No prose outside JSON.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 3000,
        })

        const responseText = extractAiResponseText(aiResult)
        const parsedPlan = parseJsonObjectText(responseText)
        const normalizedPlan = normalizeCampaignPlan(parsedPlan)
        const createOptions = campaignPlanToCreateOptions(normalizedPlan)
        const campaign = await createCampaign(
          ctx.db,
          normalizedPlan.campaignName,
          normalizedPlan.premise,
          createOptions as any
        )

        game.log.push({ at: now, who: 'GM', what: '[GM] plan_campaign' })
        recordNarrativeBeat(game, { kind: 'gm', text: 'plan_campaign', roomIndex: game.roomIndex, at: now })
        await persistRpgGame(ctx, game)

        return {
          content: toTextContent(`Campaign planned: ${campaign.name}`),
          details: {
            gameId,
            roomIndex: game.roomIndex,
            campaign,
            libraryContext: { ...(game.libraryContext ?? {}) },
          },
        }
      }

      if (command === 'craft_dungeon') {
        const themeHint = clampText(params.theme, 80)
        const partyHint = clampText(params.partyComposition, 180)

        const partySnapshot = describePartyForDungeon(game, partyHint)
        const campaignSnapshot = describeCampaignForDungeon(game)
        const partyClasses = uniquePartyClasses(game.party)
        const promptThemeName = themeHint || clampText(game.theme?.name, 80) || 'Forgotten Depths'

        const queries = [
          'encounter design pacing and difficulty curve (Game Angry)',
          'BRP opposed roll mechanics combat (BRP SRD)',
          "monster tactics for goblins and orcs (The Monsters Know What They're Doing)",
          'dungeon exploration procedures (OSE)',
        ]

        const libraryFindings: Array<{ query: string; result: string }> = []
        for (const query of queries) {
          const resultText = await consultLibrary(ctx, query)
          cacheLibraryResult(game, query, resultText)
          libraryFindings.push({ query, result: resultText })
        }

        const ai = isRecord(ctx.env) && isRecord(ctx.env.AI) && typeof (ctx.env.AI as { run?: unknown }).run === 'function'
          ? (ctx.env.AI as { run: (model: string, input: Record<string, unknown>) => Promise<unknown> })
          : null

        let difficultyCurve: DifficultyTier[] = []
        let fallbackReason = ''
        let craftedByAi = false
        if (ai) {
          try {
            const prompt = buildCraftDungeonPrompt({
              partySnapshot,
              campaignSnapshot,
              themeName: promptThemeName,
              libraryFindings,
            })
            const aiResult = await ai.run(CRAFT_DUNGEON_MODEL, {
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a veteran tactical dungeon master. Return strict JSON only. No prose outside JSON.',
                },
                {
                  role: 'user',
                  content: prompt,
                },
              ],
              temperature: 0.3,
              max_tokens: 3500,
            })

            const responseText = extractAiResponseText(aiResult)
            const parsed = parseJsonObjectText(responseText)
            const normalized = normalizeCraftDungeonResult(parsed, {
              partyClasses,
              themeName: promptThemeName,
            })
            if (normalized) {
              game.dungeon = normalized.rooms
              difficultyCurve = normalized.difficultyCurve
              const finalThemeName = themeHint || normalized.themeName || promptThemeName
              game.theme = { ...game.theme, name: finalThemeName }
              rewriteDungeonThemePrefix(game.dungeon, promptThemeName, finalThemeName)
              craftedByAi = true
            } else {
              fallbackReason = 'invalid_llm_output'
            }
          } catch (error) {
            const message = error instanceof Error ? clampText(error.message, 160) : ''
            fallbackReason = message ? `ai_error:${message}` : 'ai_error'
          }
        } else {
          fallbackReason = 'ai_binding_unavailable'
        }

        if (!craftedByAi) {
          const fallbackThemeName = themeHint || promptThemeName
          const generated = craftDungeonFromLibrary({
            theme: {
              name: fallbackThemeName,
              backstory: clampText(game.theme?.backstory, 240) || 'A perilous delve shaped by grim omens.',
            },
            party: game.party,
            libraryContext: game.libraryContext ?? {},
          })
          game.dungeon = generated.rooms
          game.theme = { ...game.theme, name: fallbackThemeName }
          difficultyCurve = generated.difficultyCurve
        }

        game.roomIndex = 0
        const initial = game.dungeon[0]
        if (initial && (initial.type === 'combat' || initial.type === 'boss')) {
          game.mode = 'combat'
          game.combat = { enemies: (initial as Room & { enemies: Enemy[] }).enemies.map((e) => ({ ...e })) }
        } else {
          game.mode = 'exploring'
          game.combat = undefined
        }

        game.dungeonContext = {
          craftedAt: now,
          libraryContext: { ...(game.libraryContext ?? {}) },
          designNotes: [
            `party: ${String(partySnapshot || '(empty)').slice(0, 800)}`,
            campaignSnapshot ? `campaign: ${campaignSnapshot.slice(0, 800)}` : 'campaign: (none)',
            themeHint ? `theme_hint: ${themeHint}` : `theme: ${game.theme.name}`,
            fallbackReason ? `llm_fallback: ${fallbackReason}` : `llm_model: ${CRAFT_DUNGEON_MODEL}`,
          ],
          difficultyCurve,
        }

        game.log.push({ at: now, who: 'GM', what: '[GM] craft_dungeon' })
        recordNarrativeBeat(game, { kind: 'gm', text: 'craft_dungeon', roomIndex: 0, at: now })
        await persistRpgGame(ctx, game)

        return {
          content: toTextContent(`Dungeon crafted: ${game.theme.name} (${game.dungeon.length} rooms)`),
          details: { gameId, roomIndex: 0, dungeon: game.dungeon, dungeonContext: game.dungeonContext, theme: game.theme },
        }
      }

      const roomIndexRaw = params.roomIndex
      const roomIndex =
        typeof roomIndexRaw === 'number' && Number.isFinite(roomIndexRaw)
          ? Math.max(0, Math.min(game.dungeon.length - 1, Math.floor(roomIndexRaw)))
          : game.roomIndex

      const room = game.dungeon[roomIndex]
      if (!room) throw new Error(`Room not found: ${roomIndex}`)

      if (command === 'narrate') {
        const text = clampText(params.text, 1000)
        if (!text) throw new Error('text is required for narrate')
        game.log.push({ at: now, who: 'GM', what: `[GM] ${text}` })
        recordNarrativeBeat(game, { kind: 'gm', text: 'narrate', roomIndex, at: now })
        await persistRpgGame(ctx, game)
        return { content: toTextContent(text), details: { gameId, roomIndex } }
      }

      if (command === 'add_event') {
        const kind = clampText(params.kind, 40) || 'other'
        const text = clampText(params.text, 1000)
        if (!text) throw new Error('text is required for add_event')

        const meta = ensureRoomMeta(room)
        meta.gmEvents ??= []
        meta.gmEvents.push({ at: now, kind, text })
        if (meta.gmEvents.length > 25) meta.gmEvents.splice(0, meta.gmEvents.length - 25)

        game.log.push({ at: now, who: 'GM', what: `[GM] add_event (${kind}): ${text}` })
        recordNarrativeBeat(game, { kind: 'gm', text: 'add_event', roomIndex, at: now })
        await persistRpgGame(ctx, game)
        return { content: toTextContent(`Event added (${kind}).`), details: { gameId, roomIndex, kind } }
      }

      if (command === 'adjust_difficulty') {
        const hpDelta = clampInt(params.enemyHpDelta, 0, { min: -999, max: 999 })
        const attackDelta = clampInt(params.enemyAttackDelta, 0, { min: -999, max: 999 })
        const dodgeDelta = clampInt(params.enemyDodgeDelta, 0, { min: -999, max: 999 })
        const dexDelta = clampInt(params.enemyDexDelta, 0, { min: -999, max: 999 })

        const addHazard = clampText(params.addHazard, 80)
        const removeHazard = clampText(params.removeHazard, 80)

        // Barrier difficulty knobs (used by rpg-engine explore()).
        const autoCrumbleAttempts = isRecord(params) && 'autoCrumbleAttempts' in params
          ? clampInt((params as any).autoCrumbleAttempts, 5, { min: 1, max: 20 })
          : undefined
        const skillCheckTarget = isRecord(params) && 'skillCheckTarget' in params
          ? clampInt((params as any).skillCheckTarget, 30, { min: 1, max: 100 })
          : undefined

        if (room.type === 'combat' || room.type === 'boss') {
          adjustEnemyStats(room.enemies, { hpDelta, attackDelta, dodgeDelta, dexDelta })
          // Keep current combat snapshot in sync if we're adjusting the active room.
          if (game.roomIndex === roomIndex && game.combat?.enemies) {
            adjustEnemyStats(game.combat.enemies, { hpDelta, attackDelta, dodgeDelta, dexDelta })
          }
        }

        if (room.type === 'barrier') {
          const barrier = room as Room & { requiredClass: RpgClass; autoCrumbleAttempts?: number; skillCheckTarget?: number }
          if (autoCrumbleAttempts !== undefined) barrier.autoCrumbleAttempts = autoCrumbleAttempts
          if (skillCheckTarget !== undefined) barrier.skillCheckTarget = skillCheckTarget
        }

        if (addHazard || removeHazard) {
          const meta = ensureRoomMeta(room)
          meta.hazards ??= []
          if (addHazard && !meta.hazards.includes(addHazard)) meta.hazards.push(addHazard)
          if (removeHazard) meta.hazards = meta.hazards.filter((h) => h !== removeHazard)
          if (meta.hazards.length === 0) delete (meta as any).hazards
        }

        game.log.push({ at: now, who: 'GM', what: `[GM] adjust_difficulty (room ${roomIndex})` })
        recordNarrativeBeat(game, { kind: 'gm', text: 'adjust_difficulty', roomIndex, at: now })
        await persistRpgGame(ctx, game)

        return { content: toTextContent(`Difficulty adjusted for room ${roomIndex}.`), details: { gameId, roomIndex } }
      }

      throw new Error(`Unknown gm command: ${command}`)
    },
  }
}
