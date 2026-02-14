import type {
  Character,
  HubTownLocation,
  HubTownState,
  RpgGameState,
} from '../../../games/rpg-engine'
import {
  advanceHubTownIdleTurns,
  createHubTownState,
  DEFAULT_HUB_TOWN_AUTO_EMBARK_TURNS,
} from '../../../games/rpg-engine'
import { buyHubTownItem, ensureCharacterLootState, sellHubTownItem } from './loot-system'
import { advanceTurn, computeInitiativeOrder } from './turn-manager'
import type {
  HubTownDowntimeResult,
  HubTownSystem,
  HubTownTransitionResult,
  HubTownVisitResult,
} from '../interfaces'

export const HUB_TOWN_LOCATIONS: readonly HubTownLocation[] = ['tavern', 'market', 'temple', 'guild_hall']

export const HUB_TOWN_LOCATION_LABEL: Record<HubTownLocation, string> = {
  tavern: 'Hearthfire Tavern',
  market: 'Lantern Market',
  temple: 'Temple of Dawn',
  guild_hall: "Adventurers' Guild Hall",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeHubTownLocation(value: unknown): HubTownLocation | null {
  const location = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (location === 'tavern' || location === 'market' || location === 'temple' || location === 'guild_hall') {
    return location
  }
  return null
}

export function ensureHubTownState(game: RpgGameState): HubTownState {
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

export function resetHubTownIdle(game: RpgGameState): void {
  if (game.phase !== 'hub_town') return
  const hub = ensureHubTownState(game)
  hub.idleTurns = 0
}

export function countHubTownIdleTurn(game: RpgGameState): number {
  const next = advanceHubTownIdleTurns(ensureHubTownState(game))
  ;(game as Record<string, unknown>).hubTown = next.state as unknown as Record<string, unknown>
  return next.state.idleTurns
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

function currentAgentName(agentName: string): string {
  return String(agentName ?? '').trim()
}

function turnError(game: RpgGameState, agentName: string): string | null {
  const agent = currentAgentName(agentName)
  if (game.currentPlayer !== agent) return `Not your turn. Current player: ${game.currentPlayer}`
  return null
}

export type HubTownBuyActionResult =
  | { ok: false; error: string }
  | { ok: true; itemId: string; gold: number; cost: number; itemName: string }

export type HubTownSellActionResult =
  | { ok: false; error: string }
  | { ok: true; itemId: string; gold: number; value: number; itemName: string }

export function buildHubTownNarration(
  game: RpgGameState,
  input: { location: HubTownLocation; cue: string }
): string {
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

export function visitHubTownLocation(
  game: RpgGameState,
  input: { agentName: string; location: unknown }
): HubTownVisitResult {
  if (game.phase !== 'hub_town') return { ok: false, error: 'visit_location is only available in hub_town.' }
  const blocked = turnError(game, input.agentName)
  if (blocked) return { ok: false, error: blocked }

  const location = normalizeHubTownLocation(input.location)
  if (!location) return { ok: false, error: `location required: ${HUB_TOWN_LOCATIONS.join(', ')}` }

  const hub = ensureHubTownState(game)
  hub.location = location
  resetHubTownIdle(game)
  advanceTurn(game)
  return { ok: true, location }
}

export function buyFromHubTownMarket(
  game: RpgGameState,
  input: { agentName: string; itemId: unknown }
): HubTownBuyActionResult {
  if (game.phase !== 'hub_town') return { ok: false, error: 'buy_item is only available in hub_town.' }
  const blocked = turnError(game, input.agentName)
  if (blocked) return { ok: false, error: blocked }

  const hub = ensureHubTownState(game)
  if (hub.location !== 'market') {
    return { ok: false, error: 'You must be at the market to buy items. Use visit_location("market").' }
  }

  const agent = currentAgentName(input.agentName) || 'unknown'
  const actor = game.party.find((member) => member && isCharacter(member, agent))
  if (!actor) throw new Error('Create your character before buying items')
  ensureCharacterLootState(actor)

  const itemId = typeof input.itemId === 'string' ? input.itemId.trim().toLowerCase() : ''
  const purchase = buyHubTownItem(actor, itemId)
  if (!purchase.ok) return { ok: false, error: purchase.error }

  resetHubTownIdle(game)
  advanceTurn(game)
  return {
    ok: true,
    itemId,
    gold: actor.gold,
    cost: purchase.listing.cost,
    itemName: purchase.listing.item.name,
  }
}

export function sellToHubTownMarket(
  game: RpgGameState,
  input: { agentName: string; itemId: unknown }
): HubTownSellActionResult {
  if (game.phase !== 'hub_town') return { ok: false, error: 'sell_item is only available in hub_town.' }
  const blocked = turnError(game, input.agentName)
  if (blocked) return { ok: false, error: blocked }

  const hub = ensureHubTownState(game)
  if (hub.location !== 'market') {
    return { ok: false, error: 'You must be at the market to sell items. Use visit_location("market").' }
  }

  const agent = currentAgentName(input.agentName) || 'unknown'
  const actor = game.party.find((member) => member && isCharacter(member, agent))
  if (!actor) throw new Error('Create your character before selling items')
  ensureCharacterLootState(actor)

  const itemId = typeof input.itemId === 'string' ? input.itemId.trim().toLowerCase() : ''
  const sale = sellHubTownItem(actor, itemId)
  if (!sale.ok) return { ok: false, error: sale.error }

  resetHubTownIdle(game)
  advanceTurn(game)
  return {
    ok: true,
    itemId: sale.itemId,
    gold: actor.gold,
    value: sale.value,
    itemName: sale.item.name,
  }
}

export function transitionCampaignCompletionToHubTown(
  game: RpgGameState,
  beforePhase: RpgGameState['phase']
): HubTownTransitionResult {
  if (beforePhase !== 'playing' || game.phase !== 'finished') return { completed: false, enteredHubTown: false }
  const campaignId = typeof game.campaignId === 'string' ? game.campaignId.trim() : ''
  if (!campaignId) return { completed: true, enteredHubTown: false }

  const hub = ensureHubTownState(game)
  hub.location = 'tavern'
  hub.idleTurns = 0
  hub.autoEmbarkAfter = Math.max(1, hub.autoEmbarkAfter || DEFAULT_HUB_TOWN_AUTO_EMBARK_TURNS)

  game.phase = 'hub_town'
  game.mode = 'finished'
  game.combat = undefined

  const initiative = computeInitiativeOrder(game.party ?? [])
  const living = initiative.find((member) => isLiving(member))
  if (living) game.currentPlayer = characterId(living)

  game.log ??= []
  game.log.push({ at: Date.now(), who: 'GM', what: 'hub_town: the party returns to town between adventures.' })
  return { completed: true, enteredHubTown: true }
}

export function tickHubTownDowntime(game: RpgGameState): HubTownDowntimeResult {
  const hub = ensureHubTownState(game)
  if (hub.idleTurns >= hub.autoEmbarkAfter) {
    return { hub, shouldEmbark: true, alreadyReady: true }
  }

  const next = advanceHubTownIdleTurns(hub)
  ;(game as Record<string, unknown>).hubTown = next.state as unknown as Record<string, unknown>
  return {
    hub: next.state,
    shouldEmbark: next.shouldEmbark,
    alreadyReady: false,
  }
}

export const hubTownSystem: HubTownSystem = {
  normalizeLocation: (value) => normalizeHubTownLocation(value),
  ensureState: (game) => ensureHubTownState(game),
  resetIdle: (game) => resetHubTownIdle(game),
  countIdleTurn: (game) => countHubTownIdleTurn(game),
  buildNarration: (game, input) => buildHubTownNarration(game, input),
  visit: (game, input) => visitHubTownLocation(game, input),
  buy: (game, input) => {
    const result = buyFromHubTownMarket(game, input)
    if (!result.ok) return result
    return { ok: true, itemId: result.itemId, gold: result.gold }
  },
  sell: (game, input) => {
    const result = sellToHubTownMarket(game, input)
    if (!result.ok) return result
    return { ok: true, itemId: result.itemId, gold: result.gold }
  },
  transitionCampaignCompletion: (game, beforePhase) => transitionCampaignCompletionToHubTown(game, beforePhase),
  tickDowntime: (game) => tickHubTownDowntime(game),
}
