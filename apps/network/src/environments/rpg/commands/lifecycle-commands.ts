import type { PersistentCharacter } from '@atproto-agent/core'

import { generateTid } from '../../../../../../packages/core/src/identity'
import { pickTheme, buildDungeonDesignPrompt, parseDungeonDesign } from '../dungeon-designer'

// ── pdf-brain tactical research for dungeon design ────────────────────────────

async function consultPdfBrain(webhookUrl: string, query: string): Promise<string> {
  try {
    const parsed = new URL(webhookUrl)
    const token = parsed.searchParams.get('token')
    if (token) parsed.searchParams.delete('token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(parsed.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'consult_library', query, limit: 3, expand: 1500 }),
    })
    if (!response.ok) return ''
    const json = (await response.json()) as Record<string, unknown>
    return typeof json.text === 'string' ? json.text : typeof json.result === 'string' ? json.result : ''
  } catch {
    return '' // pdf-brain unavailable, not fatal
  }
}

async function researchTacticsForDungeon(webhookUrl: string | undefined, themeName: string): Promise<string> {
  if (!webhookUrl) return ''
  const queries = [
    `monster combat tactics strategy intelligent enemies "The Monsters Know"`,
    `encounter design varied enemy tactics flanking focus fire retreat morale`,
    `dungeon encounter pacing difficulty curve boss fight design`,
  ]
  const results = await Promise.all(queries.map(q => consultPdfBrain(webhookUrl, q)))
  const combined = results.filter(Boolean).join('\n\n---\n\n')
  // Limit to ~3000 chars to not blow up the prompt
  return combined.slice(0, 3000)
}

import {
  craftDungeonFromLibrary,
  createCharacter,
  createGame,
  describeRoom,
  generateFantasyName,
  persistentToGameCharacter,
  type CampaignState,
  type Character,
  type Enemy,
  type Room,
  type RpgClass,
  type RpgGameState,
  type DifficultyTier,
} from '../../../games/rpg-engine'
import { createRpgSetupPhaseMachine, deserializePhaseMachine, serializePhaseMachine } from '../../phase-machine'
import type { EnvironmentContext } from '../../types'
import { buildCampaignDungeonThread } from '../campaign/campaign-logic'
import { formatFactionStandingLine } from '../campaign/normalizers'
import { buildHubTownNarration, countHubTownIdleTurn, ensureHubTownState } from '../systems/hub-town'
import { recomputeTurnOrder } from '../systems/turn-manager'

type CommandFailure = { ok: false; error: string }
type CommandSuccess = {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
}

type EnvironmentRow = { id: string; state: string; type?: string | null }

export type LifecycleCommandResult = CommandFailure | CommandSuccess

type LifecycleContext = Pick<EnvironmentContext, 'agentName' | 'db' | 'broadcast' | 'loadCharacter' | 'saveCharacter'> & {
  /** Optional LLM text generation for dungeon design */
  generateText?: (prompt: string) => Promise<string>
  /** Optional webhook URL for pdf-brain consult_library queries */
  webhookUrl?: string
}

export type LifecycleCommandDeps = {
  getCampaign: (db: D1Database, id: string) => Promise<CampaignState | null>
  linkAdventureToCampaign: (db: D1Database, envId: string, campaignId: string) => Promise<number>
}

export type LifecycleCommandInput = {
  command: string
  params: Record<string, unknown>
  ctx: LifecycleContext
  deps: LifecycleCommandDeps
  game?: RpgGameState
  gameId?: string
  setupActive?: boolean
}

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function isCharacter(character: Character, identity: string): boolean {
  return character.agent === identity || character.name === identity
}

function summarizeParty(game: RpgGameState): string {
  return game.party
    .map((member) => {
      const agentTag = member.agent ? ` [${member.agent}]` : ''
      return `${member.name}(${member.klass})${agentTag} HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp}`
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

function generateJoinName(klass: RpgClass, partyIndex: number): string {
  return generateFantasyName(klass, partyIndex)
}

function buildRerolledPersistentCharacter(previous: PersistentCharacter, fresh: Character): PersistentCharacter {
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

async function saveGameState(db: D1Database, gameId: string, game: RpgGameState): Promise<void> {
  await db
    .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
    .run()
}

async function findJoinableEnvironmentsForAgent(
  ctx: LifecycleContext,
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
        if (Array.isArray(game.party) && game.party.some((member) => member && isCharacter(member, agentName))) continue
        if (!Array.isArray(game.party) || game.party.length >= 6) continue
        joinable.push({ id: row.id, game })
        if (joinable.length >= limit) break
      } catch {
        // Ignore corrupt state rows.
      }
    }

    return joinable
  } catch {
    return []
  }
}

export async function executeLifecycleCommand(input: LifecycleCommandInput): Promise<LifecycleCommandResult | null> {
  const { command, params, ctx, deps } = input

  if (command === 'join_game') {
    const gameId = typeof params.gameId === 'string' ? params.gameId.trim() : ''
    if (!gameId) throw new Error('gameId required for join_game')

    const klass = typeof params.klass === 'string' ? (params.klass as RpgClass) : null
    if (!klass || !['Warrior', 'Scout', 'Mage', 'Healer'].includes(klass)) {
      throw new Error('klass required: Warrior | Scout | Mage | Healer')
    }

    const row = await ctx.db
      .prepare("SELECT state FROM environments WHERE id = ? AND type = 'rpg'")
      .bind(gameId)
      .first<{ state: string }>()

    if (!row) throw new Error(`Adventure ${gameId} not found`)

    const game = JSON.parse(row.state) as RpgGameState
    if (game.phase !== 'playing' && game.phase !== 'setup') {
      return { ok: false, error: `Adventure ${gameId} is not joinable (phase: ${game.phase})` }
    }

    if (!Array.isArray(game.party) || game.party.length >= 6) {
      return { ok: false, error: `Adventure ${gameId} party is full` }
    }

    const agentName = ctx.agentName.trim() || 'unknown'
    if (game.party.some((member) => isCharacter(member, agentName))) {
      return { ok: false, error: `Already in active adventure ${gameId}.` }
    }

    const fantasyName = generateJoinName(klass, game.party.length)

    let joined: Character
    let rerollNotice = ''
    if (ctx.loadCharacter) {
      const persistent = (await ctx.loadCharacter()) as PersistentCharacter | null
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

    const players = game.party.map((member) => member.agent ?? member.name)
    await ctx.db
      .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, players = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, JSON.stringify(players), gameId)
      .run()

    await ctx.broadcast({
      event_type: 'environment.joined',
      context: { environment: 'rpg', gameId, agent: agentName, klass },
    })

    return {
      content: toTextContent(
        `${rerollNotice}Joined adventure: ${gameId} as ${fantasyName} (${agentName}) the ${klass}\nParty: ${summarizeParty(game)}`
      ),
      details: { gameId, joined },
    }
  }

  if (command === 'new_game') {
    const agentName = ctx.agentName.trim()

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

    const existing = await ctx.db
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

    const players = Array.isArray(params.players)
      ? params.players.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const parsedPlayers = players
      .map((player) => player.toLowerCase().trim())
      .filter((player) => player !== 'grimlock')
    // Use provided players or fall back to default party
    const finalPlayers = parsedPlayers.length > 0
      ? parsedPlayers
      : ['slag', 'snarl', 'swoop', 'sludge', 'scout']
    if (finalPlayers.length < 1) throw new Error('Need at least 1 player')

    const requestedCampaignId = typeof params.campaignId === 'string'
      ? params.campaignId.trim()
      : typeof params.campaign_id === 'string'
        ? params.campaign_id.trim()
        : ''

    const campaignState = requestedCampaignId ? await deps.getCampaign(ctx.db, requestedCampaignId) : null
    const campaignThread = campaignState ? buildCampaignDungeonThread(campaignState) : null
    if (requestedCampaignId && !campaignState) {
      return { ok: false, error: `Campaign ${requestedCampaignId} not found.` }
    }

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

    // Skip setup phase entirely — backstory interviews require a DM agent (grimlock)
    // to be looping, which isn't always available. Go straight to playing.
    // Setup can be opted into via params.setup = true if a DM agent is running.
    const wantSetup = params.setup === true || params.setup === 'true'
    if (wantSetup) {
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
    } else {
      // Skip setup — auto-generate backstories + dungeon, go straight to playing
      game.phase = 'playing'
      for (const member of game.party ?? []) {
        if (member && typeof member === 'object' && 'name' in member && !(member as any).backstory) {
          (member as any).backstory = `A battle-hardened adventurer who joined the party seeking glory and treasure.`
        }
      }
      game.setupPhase = { currentPlayerIndex: 0, exchangeCount: 0, maxExchanges: 0, dialogues: {}, complete: true }

      // Generate dungeon — Grimlock designs with wacky themes via LLM
      const compact = params.compact === true || params.compact === 'true'
      // Query recent game themes from D1 to avoid repeats
      let usedThemes: string[] = []
      try {
        const recentGames = await ctx.db
          .prepare("SELECT state FROM environments WHERE type = 'rpg' ORDER BY rowid DESC LIMIT 10")
          .all<{ state: string }>()
        usedThemes = (recentGames.results ?? [])
          .map(r => { try { return JSON.parse(r.state)?.theme?.name } catch { return null } })
          .filter((n): n is string => typeof n === 'string')
      } catch { /* table might not exist yet, that's fine */ }
      const dungeonTheme = pickTheme(usedThemes)
      game.theme = dungeonTheme

      // Research tactics from pdf-brain before designing the dungeon
      const tacticalResearch = await researchTacticsForDungeon(ctx.webhookUrl, dungeonTheme.name)

      // Try LLM-designed dungeon, fall back to static if unavailable
      let generated: { rooms: Room[]; difficultyCurve: DifficultyTier[]; designNotes: string[] }
      if (ctx.generateText) {
        try {
          const prompt = buildDungeonDesignPrompt({ theme: dungeonTheme, party: game.party, compact, tacticalResearch })
          const llmResponse = await ctx.generateText(prompt)
          const designed = parseDungeonDesign(llmResponse, dungeonTheme, game.party, compact)
          generated = designed
        } catch {
          generated = craftDungeonFromLibrary({
            theme: dungeonTheme,
            party: game.party,
            libraryContext: (game as any).libraryContext ?? {},
            compact,
          })
        }
      } else {
        generated = craftDungeonFromLibrary({
          theme: dungeonTheme,
          party: game.party,
          libraryContext: (game as any).libraryContext ?? {},
          compact,
        })
      }
      game.dungeon = generated.rooms
      game.roomIndex = 0
      const initial = game.dungeon[0]
      if (initial && (initial.type === 'combat' || initial.type === 'boss')) {
        game.mode = 'combat'
        game.combat = { enemies: ((initial as Room & { enemies: Enemy[] }).enemies ?? []).map((e: Enemy) => ({ ...e })) }
      } else {
        game.mode = 'exploring'
        game.combat = undefined
      }
      recomputeTurnOrder(game)
      const first = game.turnOrder[0] ?? game.party[0]
      game.currentPlayer = first
        ? (typeof first === 'string' ? first : (first as Character).agent ?? (first as Character).name)
        : 'unknown'
    }

    await ctx.db.prepare("ALTER TABLE environments ADD COLUMN type TEXT DEFAULT 'catan'").run().catch(() => undefined)

    await ctx.db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', ctx.agentName.trim() || 'unknown', JSON.stringify(game), game.phase, JSON.stringify(finalPlayers))
      .run()

    if (campaignState) {
      const adventureNumber = await deps.linkAdventureToCampaign(ctx.db, gameId, campaignState.id)
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

  const game = input.game
  const gameId = input.gameId
  if (!game || !gameId) return null

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

      await saveGameState(ctx.db, gameId, game)

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
      `Room ${game.roomIndex + 1}/${game.dungeon.length}\n` +
      `${description}\n\n` +
      `Current player: ${game.currentPlayer}\n` +
      `Party: ${summarizeParty(game)}`

    if (input.setupActive) {
      const pmData = (game as any).phaseMachine
      if (pmData) {
        const phaseMachine = deserializePhaseMachine(pmData)
        const currentPhase = phaseMachine.getCurrentPhase()
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
        const campaign = await deps.getCampaign(ctx.db, campaignId)
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
        // Ignore DB lookup errors and fall back to cached context.
      }
    }

    if (lines.length === 0) {
      const cached = Array.isArray(game.campaignContext?.factions) ? game.campaignContext.factions : []
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

  if (command === 'create_character') {
    const klass = typeof params.klass === 'string' ? (params.klass as RpgClass) : null
    if (!klass || !['Warrior', 'Scout', 'Mage', 'Healer'].includes(klass)) {
      throw new Error('klass required: Warrior | Scout | Mage | Healer')
    }

    const agentName = ctx.agentName.trim() || 'unknown'
    const existing = game.party.find((member) => isCharacter(member, agentName))
    const fantasyName = existing?.name ?? generateJoinName(klass, game.party.length)
    const updated = createCharacter({ name: fantasyName, klass, agent: agentName })
    if (existing) {
      Object.assign(existing, updated)
    } else {
      game.party.push(updated)
    }
    recomputeTurnOrder(game)

    await saveGameState(ctx.db, gameId, game)

    return {
      content: toTextContent(`Character ready: ${fantasyName} (${agentName}) the ${klass}\nParty: ${summarizeParty(game)}`),
      details: { gameId, character: updated },
    }
  }

  return null
}
