import type { Character, RpgGameState } from '../../games/rpg-engine'
import { deserializePhaseMachine } from '../phase-machine'
import type { EnvironmentContext, ToolCall } from '../types'
import type { BuildContextDependencies } from './context-builder'
import {
  findActiveGameForAgent,
  findActiveGameWhereItsMyTurn,
  findJoinableEnvironmentsForAgent,
  pickJoinClass,
} from './context-builder'
import { tickHubTownDowntime } from './systems/hub-town'

export type AutoPlayDependencies = Pick<BuildContextDependencies, 'isCharacter' | 'isReactiveModeEnabled'>

function dayPrefixFromTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length < 10) return null
  return trimmed.slice(0, 10)
}

function getMaxEnvironmentsPerDay(ctx: EnvironmentContext): number {
  const raw = (ctx as any)?.maxEnvironmentsPerDay ?? (ctx as any)?.maxGamesPerDay
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (Number.isFinite(value) && value > 0) return Math.floor(value)
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
    return (results ?? []).filter((row) => dayPrefixFromTimestamp(row?.updated_at) === today).length
  } catch {
    return 0
  }
}

function defaultIsCharacter(character: Character, identity: string): boolean {
  return character.agent === identity || character.name === identity
}

export async function getAutoPlayActions(ctx: EnvironmentContext, deps: AutoPlayDependencies): Promise<ToolCall[]> {
  const agentName = ctx.agentName.trim()
  const isCharacter = deps.isCharacter ?? defaultIsCharacter
  const isReactiveModeEnabled = deps.isReactiveModeEnabled ?? (() => false)

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

  if (agentName === 'grimlock') {
    const active = row ?? activeRow
    if (active) {
      try {
        const state = JSON.parse(active.state) as RpgGameState
        if (Array.isArray(state.dungeon) && state.dungeon.length === 0) {
          return [{ name: 'gm', arguments: { command: 'craft_dungeon', gameId: active.id } }]
        }
      } catch {
        // Ignore malformed state.
      }
      if (!row) return []
    }
  }

  if (!row) {
    if (agentName === 'grimlock') {
      const anyPlaying = await anyPlayingRpgEnvironmentsExist(ctx)
      if (anyPlaying) return []

      const maxEnvironmentsPerDay = getMaxEnvironmentsPerDay(ctx)
      const finishedToday = await countFinishedRpgEnvironmentsToday(ctx)
      if (finishedToday >= maxEnvironmentsPerDay) return []

      try {
        const campaignRow = await ctx.db
          .prepare('SELECT id FROM campaigns ORDER BY created_at DESC LIMIT 1')
          .first<{ id: string }>()
        if (campaignRow?.id) {
          return [{ name: 'rpg', arguments: { command: 'new_game', players: ['slag', 'snarl', 'swoop'], campaignId: campaignRow.id } }]
        }
      } catch {
        // No campaigns table or no campaigns — fall through to standalone.
      }
      return [{ name: 'rpg', arguments: { command: 'new_game', players: ['slag', 'snarl', 'swoop'] } }]
    }

    const joinable = await findJoinableEnvironmentsForAgent(ctx, { limit: 1, isCharacter })
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

      if (ctx.agentName.trim() === 'grimlock') {
        const dialogues = (setupPhase.dialogues ?? {}) as Record<string, string[]>
        const phaseMachineState = (state as any).phaseMachine
        if (phaseMachineState) {
          const phaseMachine = deserializePhaseMachine(phaseMachineState)
          const currentPhase = phaseMachine.getCurrentPhase()
          if (currentPhase?.transitionOn === 'setup_finalize') {
            const backstories: Record<string, string> = {}
            for (const [agent, messages] of Object.entries(dialogues)) {
              backstories[agent] = messages.filter((_, index) => index % 2 === 1).join(' ') || 'A mysterious adventurer.'
            }
            return [{ name: 'rpg', arguments: { command: 'setup_finalize', gameId: row.id, backstories } }]
          }
        }

        const existing = Array.isArray(dialogues[currentAgent]) ? dialogues[currentAgent] : []
        if (existing.length === 0) {
          return [{
            name: 'rpg',
            arguments: {
              command: 'setup_narrate',
              gameId: row.id,
              target: currentAgent,
              message: 'Tell me about your character. Where did you come from, and what do you look like?',
            },
          }]
        }
        return []
      }

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
}
