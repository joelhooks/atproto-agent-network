import type { Character, FeedMessage, FeedMessageType, RpgGameState } from '../../../games/rpg-engine'
import { deserializePhaseMachine, serializePhaseMachine } from '../../phase-machine'
import type { EnvironmentContext } from '../../types'
import { recomputeTurnOrder } from '../systems/turn-manager'

type CommandFailure = { ok: false; error: string }
type CommandSuccess = {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
}

export type SocialCommandResult = CommandFailure | CommandSuccess

type SocialContext = Pick<EnvironmentContext, 'agentName' | 'db'>

export type SocialCommandInput = {
  command: string
  params: Record<string, unknown>
  game: RpgGameState
  gameId: string
  ctx: SocialContext
}

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function characterId(character: Character | undefined | null): string {
  if (!character) return 'unknown'
  return character.agent ?? character.name
}

function capChars(text: string, max: number): string {
  if (!text) return ''
  const value = String(text)
  if (value.length <= max) return value
  return value.slice(0, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function saveGameState(db: D1Database, gameId: string, game: RpgGameState): Promise<void> {
  await db
    .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
    .run()
}

export async function executeSocialCommand(input: SocialCommandInput): Promise<SocialCommandResult | null> {
  const { command, params, game, gameId, ctx } = input

  if (command === 'setup_narrate' || command === 'setup_respond' || command === 'setup_finalize') {
    const setupPhase = game.setupPhase
    if (!setupPhase) {
      return { ok: false, error: 'No setup phase is active for this adventure.' }
    }
    const sp = setupPhase

    const agentName = ctx.agentName.trim()
    const party = Array.isArray(game.party) ? game.party : []
    const currentIdx = Math.max(0, Math.min(party.length - 1, Math.floor(sp.currentPlayerIndex ?? 0)))
    const current = party[currentIdx]
    const currentAgent = current ? (current.agent ?? current.name) : ''

    function ensureDialoguesKey(key: string): string[] {
      sp.dialogues ??= {}
      const normalized = String(key || '').trim() || 'unknown'
      const list = sp.dialogues[normalized] ?? []
      sp.dialogues[normalized] = list
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

      if (targetRaw) {
        const idx = party.findIndex((member: any) => (member?.agent ?? member?.name) === target)
        if (idx >= 0) {
          sp.currentPlayerIndex = idx
          sp.exchangeCount = 0
        }
      }

      ensureDialoguesKey(target).push(message)
      game.currentPlayer = target

      const phaseMachineData = (game as any).phaseMachine
      if (phaseMachineData) {
        const phaseMachine = deserializePhaseMachine(phaseMachineData)
        phaseMachine.advance({ command: 'setup_narrate', target })
        ;(game as any).phaseMachine = serializePhaseMachine(phaseMachine)
      }

      await saveGameState(ctx.db, gameId, game)
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

      if (sp.exchangeCount >= Math.max(1, Math.floor(sp.maxExchanges ?? 2))) {
        sp.currentPlayerIndex = currentIdx + 1
        sp.exchangeCount = 0

        if (sp.currentPlayerIndex >= party.length) {
          sp.complete = true
        }
      }

      game.currentPlayer = 'grimlock'

      const phaseMachineData = (game as any).phaseMachine
      if (phaseMachineData) {
        const phaseMachine = deserializePhaseMachine(phaseMachineData)
        phaseMachine.advance({ command: 'setup_respond', agent: agentName })
        ;(game as any).phaseMachine = serializePhaseMachine(phaseMachine)
      }

      await saveGameState(ctx.db, gameId, game)
      return { content: toTextContent(`You: ${message}`), details: { gameId } }
    }

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

    game.roomIndex = 0
    const room0 = game.dungeon?.[0]
    if (room0 && (room0.type === 'combat' || room0.type === 'boss')) {
      game.mode = 'combat'
      game.combat = { enemies: (room0 as any).enemies?.map((enemy: any) => ({ ...enemy })) ?? [] }
    } else {
      game.mode = 'exploring'
      game.combat = undefined
    }
    recomputeTurnOrder(game)
    game.currentPlayer = characterId(game.turnOrder[0]) ?? characterId(game.party[0]) ?? 'unknown'
    game.phase = 'playing'

    await saveGameState(ctx.db, gameId, game)
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
      const options = [...allowed].filter((handle) => handle !== '@party' && handle !== '@dm').sort()
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

    await saveGameState(ctx.db, gameId, game)

    return {
      content: toTextContent(`Sent ${type.toUpperCase()} message to ${to}: ${message}`),
      details: { gameId, message: entry },
    }
  }

  return null
}
