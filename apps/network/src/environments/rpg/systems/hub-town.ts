import type {
  HubTownLocation,
  HubTownState,
  RpgGameState,
} from '../../../games/rpg-engine'
import {
  advanceHubTownIdleTurns,
  createHubTownState,
} from '../../../games/rpg-engine'

const HUB_TOWN_LOCATION_LABEL: Record<HubTownLocation, string> = {
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
