import type { PiAgentTool } from '@atproto-agent/agent'

import { createDice, generateDungeon, recordNarrativeBeat, type Enemy, type RpgClass, type RpgGameState, type Room } from '../games/rpg-engine'
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
    .prepare("SELECT id, state, type, phase FROM games WHERE id = ? AND type = 'rpg'")
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
    .prepare("SELECT id FROM games WHERE type = 'rpg' AND phase = 'playing' AND players LIKE ? ORDER BY updated_at DESC LIMIT 1")
    .bind(`%${agentName}%`)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function persistRpgGame(ctx: EnvironmentContext, game: RpgGameState): Promise<void> {
  await ctx.db
    .prepare("UPDATE games SET state = ?, phase = ?, updated_at = datetime('now') WHERE id = ? AND type = 'rpg'")
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

export function createGmTool(ctx: EnvironmentContext): PiAgentTool {
  return {
    name: 'gm',
    label: 'GM',
    description:
      'Grimlock-only GM tool for live dungeon adjudication.\n' +
      'Commands:\n' +
      '- narrate: Add a narrative message to the game log\n' +
      '- adjust_difficulty: Modify room difficulty mid-dungeon\n' +
      '- add_event: Inject an emergent event into the current room\n' +
      '- review_party: Summarize party status\n' +
      '- craft_dungeon: Consult pdf-brain and craft a paced dungeon tailored to the party\n' +
      '- consult_library: Query pdf-brain (via Grimlock webhook) for RPG GM knowledge\n',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['narrate', 'adjust_difficulty', 'add_event', 'review_party', 'craft_dungeon', 'consult_library'],
        },
        gameId: { type: 'string', description: 'RPG game id (optional; defaults to your active adventure).' },
        roomIndex: { type: 'number', description: 'Target room index (defaults to current room).' },
        text: { type: 'string', description: 'Narration/event text.' },
        kind: { type: 'string', description: 'Event kind (npc|hazard|loot|twist|other).' },
        query: { type: 'string', description: 'pdf-brain search query (consult_library)' },
        theme: { type: 'string', description: 'Optional theme hint for craft_dungeon.' },
        partyComposition: { type: 'string', description: 'Optional party composition hint (craft_dungeon).' },
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

      if (command === 'craft_dungeon') {
        const themeHint = clampText(params.theme, 80)
        const partyHint = clampText(params.partyComposition, 180)

        const party = Array.isArray(game.party) ? game.party : []
        const partySnapshot =
          partyHint ||
          party
            .map((p) => `${p.name}(${p.klass}) STR ${p.stats.STR} DEX ${p.stats.DEX} INT ${p.stats.INT} WIS ${p.stats.WIS}`)
            .join(' | ')

        const queries = [
          'encounter design pacing and difficulty curve (Game Angry)',
          'BRP opposed roll mechanics combat (BRP SRD)',
          "monster tactics for goblins and orcs (The Monsters Know What They're Doing)",
          'dungeon exploration procedures (OSE)',
        ]

        for (const query of queries) {
          const resultText = await consultLibrary(ctx, query)
          cacheLibraryResult(game, query, resultText)
        }

        // Plumbing only: still rely on the existing generator for the layout, but attach library context
        // on the dungeon state so future stories can shape encounters without additional lookups.
        const partyClasses = uniquePartyClasses(game.party)
        const generated = generateDungeon(12, createDice(), { partyClasses })

        game.dungeon = generated.rooms
        const fromTheme = generated.theme.name
        game.theme = generated.theme
        if (themeHint) {
          game.theme = { ...game.theme, name: themeHint }
          rewriteDungeonThemePrefix(game.dungeon, fromTheme, themeHint)
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
            themeHint ? `theme_hint: ${themeHint}` : `theme: ${game.theme.name}`,
          ],
          difficultyCurve: [],
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
