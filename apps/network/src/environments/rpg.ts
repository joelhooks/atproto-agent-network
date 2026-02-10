import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

import {
  attack,
  awardXp,
  type Character,
  createCharacter,
  createDice,
  createGame,
  describeRoom,
  explore,
  gameCharacterToPersistent,
  generateFantasyName,
  gmInterveneIfStuck,
  partyWipe,
  persistentToGameCharacter,
  resolveSkillCheck,
  soloMultiplier,
  type RpgClass,
  type FeedMessage,
  type FeedMessageType,
  type RpgGameState,
  XP_PER_ADVENTURE_COMPLETE,
  XP_PER_BOSS_KILL,
  XP_PER_ENEMY_KILL,
  XP_PER_ROOM_CLEAR,
  XP_TABLE,
} from '../games/rpg-engine'

import type { PersistentCharacter } from '@atproto-agent/core'

import type { AgentEnvironment, EnvironmentContext, ToolCall } from './types'
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

function addXpEarned(game: RpgGameState, who: string, amount: number): void {
  const agent = String(who ?? '').trim()
  const amt = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  if (!agent || amt <= 0) return
  game.xpEarned ??= {}
  game.xpEarned[agent] = (game.xpEarned[agent] ?? 0) + amt
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

function normalizeToolCallArguments(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

type GameRow = { id: string; state: string; type?: string | null }

function dayPrefixFromTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length < 10) return null
  return s.slice(0, 10)
}

function getMaxGamesPerDay(ctx: EnvironmentContext): number {
  const raw = (ctx as any)?.maxGamesPerDay
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return 50
}

async function anyPlayingRpgGamesExist(ctx: EnvironmentContext): Promise<boolean> {
  try {
    const row = await ctx.db
      .prepare("SELECT id FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') LIMIT 1")
      .first<{ id: string }>()
    return Boolean(row?.id)
  } catch {
    return false
  }
}

async function countFinishedRpgGamesToday(ctx: EnvironmentContext): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const { results } = await ctx.db
      .prepare("SELECT id, updated_at FROM games WHERE type = 'rpg' AND phase = 'finished'")
      .all<{ id: string; updated_at: string }>()
    return (results ?? []).filter((r) => dayPrefixFromTimestamp(r?.updated_at) === today).length
  } catch {
    return 0
  }
}

async function emitGameCompleted(ctx: EnvironmentContext, input: { gameId: string; game: RpgGameState }): Promise<void> {
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
  const theme = capChars(String((game as any).theme ?? 'mysterious').trim(), 32)

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

async function findActiveGameForAgent(ctx: EnvironmentContext): Promise<GameRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    // Check as player first
    const asPlayer = await ctx.db
      .prepare("SELECT id, state, type FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') AND players LIKE ? LIMIT 1")
      .bind(`%${agentName}%`)
      .first<GameRow>()
    if (asPlayer) return asPlayer

    // Check as host/DM
    const asHost = await ctx.db
      .prepare("SELECT id, state, type FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') AND host_agent = ? LIMIT 1")
      .bind(agentName)
      .first<GameRow>()
    return asHost ?? null
  } catch {
    return null
  }
}

async function findActiveGameWhereItsMyTurn(ctx: EnvironmentContext): Promise<GameRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const row = await ctx.db
      .prepare(
        "SELECT id, state, type FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') AND json_extract(state, '$.currentPlayer') = ?"
      )
      .bind(agentName)
      .first<GameRow>()
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

async function findJoinableGamesForAgent(
  ctx: EnvironmentContext,
  input: { limit?: number }
): Promise<Array<{ id: string; game: RpgGameState }>> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return []

  try {
    const { results } = await ctx.db
      .prepare("SELECT id, state FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY updated_at DESC")
      .all<GameRow>()

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
        '- cast_spell: Cast a spell (stub)\n' +
        '- use_skill: Attempt a generic skill check\n' +
        '- rest: Recover some HP/MP\n' +
        '- status: Show game state\n',
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
              'cast_spell',
              'use_skill',
              'rest',
              'status',
            ],
          },
          gameId: { type: 'string', description: 'Game ID (optional; defaults to your active adventure).' },
          players: { type: 'array', items: { type: 'string' }, description: 'Players for new_game.' },
          klass: { type: 'string', enum: ['Warrior', 'Scout', 'Mage', 'Healer'], description: 'Class for create_character.' },
          defender: { type: 'string', description: 'Party member to attack (out of combat only).' },
          spell: { type: 'string', description: 'Spell name for cast_spell.' },
          skill: { type: 'string', description: 'Skill name for use_skill (defaults to use_skill).' },
          message: { type: 'string', description: 'Narration/response message for setup phase.' },
          to: {
            type: 'string',
            description: 'Routing target: @agent, @party (broadcast), or @dm.',
          },
          type: { type: 'string', enum: ['ic', 'ooc'], description: 'ic = in-character, ooc = table talk.' },
          target: { type: 'string', description: 'Target player agent for DM narration (setup phase).' },
          backstories: { type: 'object', additionalProperties: { type: 'string' }, description: 'Final backstories by agent.' },
        },
        required: ['command'],
      },
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const params = normalizeToolCallArguments(rawParams)
        const command = typeof params.command === 'string' ? params.command : ''
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
            .prepare("SELECT state FROM games WHERE id = ? AND type = 'rpg'")
            .bind(gameId)
            .first<{ state: string }>()

          if (!row) throw new Error(`Adventure ${gameId} not found`)

          const game = JSON.parse(row.state) as RpgGameState
          if (game.phase !== 'playing') {
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
          if (ctx.loadCharacter) {
            const persistent = await ctx.loadCharacter() as PersistentCharacter | null
            if (persistent && persistent.klass) {
              joined = persistentToGameCharacter(persistent, agentName)
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
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, players = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, JSON.stringify(players), gameId)
            .run()

          await ctx.broadcast({
            event_type: 'environment.joined',
            context: { environment: 'rpg', gameId, agent: agentName, klass },
          })

          return {
            content: toTextContent(`Joined adventure: ${gameId} as ${fantasyName} (${agentName}) the ${klass}\nParty: ${summarizeParty(game)}`),
            details: { gameId, joined },
          }
        }

        if (command === 'new_game') {
          const agentName = ctx.agentName.trim()

          // Only Grimlock can create new games
          if (agentName !== 'grimlock') {
            const joinable = await findJoinableGamesForAgent(ctx, { limit: 5 })
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
            .prepare("SELECT id FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') LIMIT 1")
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

          const players = Array.isArray(params.players)
            ? params.players.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : []
          // Grimlock is the DM, never a player — strip from player list and ensure we have real players
          const filteredPlayers = players.filter((p) => p !== 'grimlock')
          if (filteredPlayers.length < players.length && filteredPlayers.length === 0) {
            // Grimlock tried to create a solo game — use the default player list instead
            filteredPlayers.push('slag', 'snarl', 'swoop')
          }
          const finalPlayers = filteredPlayers.length > 0 ? filteredPlayers : players
          if (finalPlayers.length < 1) throw new Error('Need at least 1 player')

          // Prefer joining an open adventure when a solo new_game is requested.
          if (finalPlayers.length <= 1) {
            const joinable = await findJoinableGamesForAgent(ctx, { limit: 5 })
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
          const game = createGame({ id: gameId, players: finalPlayers })

          // Backstory setup phase: only run when at least one party member has no backstory.
          // Note: we can only inspect in-game state here (DM cannot read other agents' persistent storage).
          const missingBackstory = Array.isArray(game.party)
            ? game.party.some((p: any) => typeof p?.backstory !== 'string' || p.backstory.trim().length === 0)
            : true
          if (missingBackstory) {
            ;(game as any).setupPhase = {
              currentPlayerIndex: 0,
              exchangeCount: 0,
              maxExchanges: 2,
              dialogues: {},
              complete: false,
            }
            // Setup begins with the DM (grimlock) asking the first question.
            game.phase = 'setup' as any
            game.currentPlayer = 'grimlock'
          }

          // Ensure type column exists (migration from catan-only schema)
          await db.prepare("ALTER TABLE games ADD COLUMN type TEXT DEFAULT 'catan'").run().catch(() => {/* already exists */})

          await db
            .prepare(
              "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
            )
            .bind(gameId, 'rpg', ctx.agentName.trim() || 'unknown', JSON.stringify(game), game.phase, JSON.stringify(finalPlayers))
            .run()

          await ctx.broadcast({
            event_type: 'environment.created',
            context: { environment: 'rpg', gameId, host: ctx.agentName.trim() || 'unknown', players: finalPlayers },
          })

          return {
            content: toTextContent(
              `Adventure created: ${gameId}\nPlayers: ${finalPlayers.join(', ')}\n\n` +
                `Room 1/${game.dungeon.length}: ${describeRoom(game, 0)}`
            ),
            details: { gameId, type: 'rpg', players: finalPlayers, phase: game.phase },
          }
        }

        // Resolve gameId (explicit or active)
        let gameId = typeof params.gameId === 'string' ? params.gameId : ''
        if (!gameId) {
          const row = await findActiveGameForAgent(ctx)
          if (!row) {
            // List joinable games so agent knows what to do
            const joinable = await db
              .prepare("SELECT id, players FROM games WHERE type = 'rpg' AND phase IN ('playing', 'setup') ORDER BY created_at DESC LIMIT 5")
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
          .prepare("SELECT state FROM games WHERE id = ? AND type = 'rpg'")
          .bind(gameId)
          .first<{ state: string }>()

        if (!row) throw new Error(`Adventure ${gameId} not found`)

        const game = JSON.parse(row.state) as RpgGameState
        game.party ??= []
        game.feedMessages ??= []
        game.round ??= 1

        const setupPhase = (game as any).setupPhase as RpgGameState['setupPhase'] | undefined
        const setupActive = Boolean(setupPhase && !setupPhase.complete)

        // Normalize turn state eagerly so dead players never softlock the game.
        // During setup, currentPlayer may be 'grimlock' (not in party), so skip normalization.
        if (!setupActive) {
          const beforePhase = game.phase
          const dirty = normalizeTurnState(game)
          if (dirty) {
            await db
              .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
              .run()
            if (beforePhase !== 'finished' && game.phase === 'finished') {
              await emitGameCompleted(ctx, { gameId, game })
            }
          }
        }

        if (command === 'status') {
          const room = game.dungeon[game.roomIndex]
          const description = describeRoom(game, game.roomIndex)
          return {
            content: toTextContent(
              `Adventure: ${gameId}\n` +
                `Mode: ${game.mode} | Phase: ${game.phase}\n` +
                `Room ${game.roomIndex + 1}/${game.dungeon.length}: ${room?.type ?? 'unknown'}\n` +
                `${description}\n\n` +
                `Current player: ${game.currentPlayer}\n` +
                `Party: ${summarizeParty(game)}`
            ),
            details: {
              gameId,
              mode: game.mode,
              phase: game.phase,
              roomIndex: game.roomIndex,
              currentPlayer: game.currentPlayer,
            },
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

            await db
              .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
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

            await db
              .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
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
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
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
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
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
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
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

          const beforePhase = game.phase
          const beforeRoomIndex = game.roomIndex
          const attemptedRoomIndex = game.roomIndex + 1
          const result = explore(game, { dice })

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

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (beforePhase !== 'finished' && game.phase === 'finished') {
            await emitGameCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(
              (() => {
                if (game.phase !== 'playing') return 'The adventure is complete.'
                const roomNow = game.dungeon[game.roomIndex]
                if (!roomNow) return 'The adventure is complete.'
                return `You enter: ${roomNow.type}\n${describeRoom(game, game.roomIndex)}\n\nParty: ${summarizeParty(game)}`
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

                // XP rewards are accumulated into game state and applied to persistent characters at game end.
                if (hpBefore > 0 && enemy.hp === 0) {
                  addXpEarned(game, attackerName, XP_PER_ENEMY_KILL)
                  game.log.push({ at: Date.now(), who: attackerName, what: `gained ${XP_PER_ENEMY_KILL} XP (kill: ${enemy.name})` })

                  if (enemy.tactics?.kind === 'boss') {
                    addXpEarned(game, attackerName, XP_PER_BOSS_KILL)
                    game.log.push({ at: Date.now(), who: attackerName, what: `gained ${XP_PER_BOSS_KILL} XP (boss kill)` })
                  }
                }
              } else {
                text = `The ${enemy.name} avoids your attack.`
              }

              if (enemy.hp > 0 && game.phase === 'playing') {
                const counterAtk = resolveSkillCheck({ skill: enemy.attack, dice })
                const counterDod = resolveSkillCheck({ skill: attacker.skills.dodge, dice })
                const atkMargin = counterAtk.success ? enemy.attack - counterAtk.roll : -Infinity
                const dodMargin = counterDod.success ? attacker.skills.dodge - counterDod.roll : -Infinity
                const counterHit = counterAtk.success && (!counterDod.success || atkMargin > dodMargin)

                if (counterHit) {
                  const raw = dice.d(6)
                  const dmg = Math.max(0, Math.floor(raw * soloMultiplier(game.party.length)))
                  attacker.hp = Math.max(0, attacker.hp - dmg)
                  text += `\nThe ${enemy.name} counter-attacks for ${dmg}. (HP ${attacker.hp}/${attacker.maxHp})`
                  partyWipe(game)
                } else {
                  text += `\nThe ${enemy.name} counter-attacks but misses.`
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

              await db
                .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
                .run()

              if (beforePhase !== 'finished' && game.phase === 'finished') {
                await emitGameCompleted(ctx, { gameId, game })
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

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (beforePhase !== 'finished' && game.phase === 'finished') {
            await emitGameCompleted(ctx, { gameId, game })
          }

          return {
            content: toTextContent(`${result.detail}.\nParty: ${summarizeParty(game)}`),
            details: { gameId, hit: result.hit },
          }
        }

        if (command === 'rest') {
          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before resting')
          if ((actor.hp ?? 0) <= 0) {
            return { ok: false, error: 'You are dead. You cannot rest until revived.' }
          }

          actor.hp = Math.min(actor.maxHp, actor.hp + 2)
          actor.mp = Math.min(actor.maxMp, actor.mp + 1)

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
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

          const skillName = typeof params.skill === 'string' ? params.skill : 'use_skill'
          if (!isRecord(actor.skills) || typeof (actor.skills as any)[skillName] !== 'number') {
            return { ok: false, error: `Unknown skill: ${skillName}` }
          }

          const current = Number((actor.skills as any)[skillName])
          const check = resolveSkillCheck({ skill: current, dice })
          if (check.success) {
            ;(actor.skills as any)[skillName] = check.nextSkill
          }

          gmInterveneIfStuck(game, {
            player: ctx.agentName.trim() || 'unknown',
            action: 'use_skill',
            target: `skill:${skillName}`,
          })

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(
              `${check.success ? 'Success' : 'Fail'} (rolled ${check.roll} vs ${current}).` +
                (check.success ? ` Skill improves to ${check.nextSkill}.` : '')
            ),
            details: { gameId, skill: skillName, roll: check.roll, success: check.success, nextSkill: check.nextSkill },
          }
        }

        if (command === 'cast_spell') {
          const actor = game.party.find((p) => isCharacter(p, ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before casting')

          const spell = typeof params.spell === 'string' ? params.spell.trim() : 'spell'
          if (actor.mp <= 0) return { ok: false, error: 'Out of MP' }
          actor.mp -= 1

          const check = resolveSkillCheck({ skill: actor.skills.cast_spell, dice })
          if (check.success) actor.skills.cast_spell = check.nextSkill

          gmInterveneIfStuck(game, {
            player: ctx.agentName.trim() || 'unknown',
            action: 'cast_spell',
            target: `spell:${spell}`,
          })

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`${check.success ? 'Spell succeeds' : 'Spell fizzles'}: ${spell}`),
            details: { gameId, spell, success: check.success, roll: check.roll },
          }
        }

        throw new Error(`Unknown rpg command: ${command}`)
      },
    }
  },

  async buildContext(ctx: EnvironmentContext): Promise<string[]> {
    const row = (await findActiveGameWhereItsMyTurn(ctx)) ?? (await findActiveGameForAgent(ctx))
    if (!row) {
      const joinable = await findJoinableGamesForAgent(ctx, { limit: 5 })
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
        const party = Array.isArray(game.party) ? game.party : []
        const idx = Math.max(0, Math.min(party.length - 1, Math.floor(setupPhase.currentPlayerIndex ?? 0)))
        const current = party[idx]
        const currentAgent = current ? (current.agent ?? current.name) : ''

        if (agentName.toLowerCase() === 'grimlock') {
          return [
            `🎮🎮🎮 SETUP PHASE: You are interviewing ${currentAgent || 'the next player'} about their character.`,
            'Ask about their origin, motivation, and appearance. Keep it brief (2-3 exchanges per player).',
            'You MUST use the rpg tool: command:"setup_narrate" with target:<agent> and message:<question>. After all players respond, use command:"setup_finalize" with backstories for each agent.',
            'DO NOT use the "message" tool for this — ONLY use the "rpg" tool with setup commands.',
          ]
        }

        if (agentName === currentAgent) {
          return [
            "🎮🎮🎮 The DM is asking about your character's backstory.",
            'You MUST use the rpg tool with command:"setup_respond" and message:"<your response>". Do NOT use "message" or "remember" — ONLY the "rpg" tool delivers your answer to the DM.',
          ]
        }

        return [`Waiting for ${currentAgent || 'the current player'} to finish backstory with DM.`]
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

      // Inject role-based skills
      const isGrimlockAgent = ctx.agentName.trim().toLowerCase() === 'grimlock'
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
        lines.push(...feedLines)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(...roleSkillLines)
        lines.push('')
        lines.push(`Use the rpg tool to act: rpg({"command":"explore","gameId":"${row.id}"}) or rpg({"command":"status","gameId":"${row.id}"})`)
        lines.push(`DO NOT create a new game.`)
      } else {
        lines.push(`🎲 Active RPG adventure: ${row.id} — waiting for ${game.currentPlayer}.`)
        if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
        lines.push(...persistentLines)
        lines.push(...feedLines)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(...roleSkillLines)
        lines.push('Wait for your turn.')
        lines.push(`DO NOT create a new game.`)
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
        'cast_spell',
        'use_skill',
        'rest',
        'create_character',
        'send_message',
        'setup_narrate',
        'setup_respond',
        'setup_finalize',
      ].includes(cmd)
    })
  },

  async getAutoPlayActions(ctx: EnvironmentContext): Promise<ToolCall[]> {
    const row = await findActiveGameWhereItsMyTurn(ctx)
    if (!row) {
      const active = await findActiveGameForAgent(ctx)
      if (active) return []

      // Grimlock: when there are no playing games, auto-create a fresh dungeon.
      const agentName = ctx.agentName.trim()
      if (agentName === 'grimlock') {
        const anyPlaying = await anyPlayingRpgGamesExist(ctx)
        if (anyPlaying) return []

        const maxGamesPerDay = getMaxGamesPerDay(ctx)
        const finishedToday = await countFinishedRpgGamesToday(ctx)
        if (finishedToday >= maxGamesPerDay) return []

        return [{ name: 'rpg', arguments: { command: 'new_game', players: ['slag', 'snarl', 'swoop'] } }]
      }

      const joinable = await findJoinableGamesForAgent(ctx, { limit: 1 })
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

        // DM turn: ask an opening question if no dialogue yet for this player.
        if (ctx.agentName.trim() === 'grimlock') {
          const dialogues = (setupPhase.dialogues ?? {}) as Record<string, string[]>
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
