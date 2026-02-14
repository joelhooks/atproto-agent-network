import type { EnvironmentContext } from '../../types'
import type { RpgGameState } from '../../../games/rpg-engine'

import type { GameEventEmitter, GamePhase } from '../interfaces'

type ReactiveRpgContext = EnvironmentContext & {
  reactiveMode?: boolean
  wakeAgent?: (agentName: string, detail?: Record<string, unknown>) => Promise<void> | void
}

export type ReactiveStateSnapshot = {
  phase: RpgGameState['phase']
  mode: RpgGameState['mode']
  currentPlayer: string
}

export function isReactiveModeEnabled(ctx: EnvironmentContext): boolean {
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

export function createReactiveGameEventEmitter(
  ctx: EnvironmentContext,
  game: RpgGameState,
  deps: {
    emitEnvironmentCompleted: (
      ctx: EnvironmentContext,
      input: { gameId: string; game: RpgGameState }
    ) => Promise<void>
  },
): GameEventEmitter {
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
      deps.emitEnvironmentCompleted(environmentCtx, { gameId, game: state }),
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

export async function emitReactiveSignals(
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
