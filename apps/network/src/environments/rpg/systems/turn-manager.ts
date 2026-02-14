import type { Character, RpgGameState } from '../../../games/rpg-engine'
import { partyWipe } from '../../../games/rpg-engine'

export type TurnManagerOptions = {
  now?: () => number
}

function characterId(character: Character | null | undefined): string {
  if (!character) return 'unknown'
  return character.agent ?? character.name
}

function isCharacter(character: Character, identity: string): boolean {
  return character.agent === identity || character.name === identity
}

function isLiving(character: Character | null | undefined): boolean {
  return Boolean(character) && (character!.hp ?? 0) > 0
}

function logSkipDeadTurn(game: RpgGameState, name: string, now: () => number): void {
  const who = String(name || '').trim()
  if (!who) return
  game.log ??= []
  game.log.push({ at: now(), who: 'GM', what: `${who} is dead, skipping turn` })
}

export function computeInitiativeOrder(party: Character[]): Character[] {
  return [...party].sort((a, b) => {
    const dex = b.stats.DEX - a.stats.DEX
    if (dex !== 0) return dex
    return a.name.localeCompare(b.name)
  })
}

export function normalizeTurnState(game: RpgGameState, options: TurnManagerOptions = {}): boolean {
  const now = options.now ?? Date.now
  const before = {
    phase: game.phase,
    mode: game.mode,
    currentPlayer: game.currentPlayer,
    turnOrderNames: Array.isArray(game.turnOrder) ? game.turnOrder.map((player) => player.name) : [],
  }

  game.party ??= []
  game.log ??= []

  const initiative = computeInitiativeOrder(game.party)
  const living = initiative.filter(isLiving)

  // Remove dead players from active turn rotation while preserving full party state.
  game.turnOrder = living

  if (living.length === 0) {
    partyWipe(game)
    game.phase = 'finished'
    game.mode = 'finished'
    game.combat = undefined
    game.currentPlayer = 'none'
  } else {
    const index = initiative.findIndex((player) => isCharacter(player, game.currentPlayer))
    const current = index >= 0 ? initiative[index] : undefined
    if (!isLiving(current)) {
      if (current && (current.hp ?? 0) <= 0) logSkipDeadTurn(game, current.name, now)

      if (index < 0) {
        game.currentPlayer = characterId(living[0])
      } else {
        const start = index
        for (let offset = 1; offset <= initiative.length; offset += 1) {
          const candidate = initiative[(start + offset) % initiative.length]
          if (!candidate) continue
          if (isLiving(candidate)) {
            game.currentPlayer = characterId(candidate)
            break
          }
          logSkipDeadTurn(game, candidate.name, now)
        }
      }
    }
  }

  const after = {
    phase: game.phase,
    mode: game.mode,
    currentPlayer: game.currentPlayer,
    turnOrderNames: game.turnOrder.map((player) => player.name),
  }

  return (
    before.phase !== after.phase ||
    before.mode !== after.mode ||
    before.currentPlayer !== after.currentPlayer ||
    JSON.stringify(before.turnOrderNames) !== JSON.stringify(after.turnOrderNames)
  )
}

export function advanceTurn(game: RpgGameState, options: TurnManagerOptions = {}): void {
  const now = options.now ?? Date.now
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

  const index = initiative.findIndex((player) => isCharacter(player, game.currentPlayer))
  const current = index >= 0 ? initiative[index] : undefined
  if (current && (current.hp ?? 0) <= 0) logSkipDeadTurn(game, current.name, now)

  const start = index >= 0 ? index : -1
  for (let offset = 1; offset <= initiative.length; offset += 1) {
    const nextIndex = (start + offset) % initiative.length
    const candidate = initiative[nextIndex]
    if (!candidate) continue
    if (isLiving(candidate)) {
      if (index >= 0 && nextIndex <= index) {
        game.round = (game.round ?? 1) + 1
      }
      game.currentPlayer = characterId(candidate)
      return
    }
    logSkipDeadTurn(game, candidate.name, now)
  }

  game.currentPlayer = characterId(living[0])
}

export function recomputeTurnOrder(game: RpgGameState, options: TurnManagerOptions = {}): void {
  normalizeTurnState(game, options)
}
