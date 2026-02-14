import { type CampaignState, createGame, type RpgGameState } from '../../../games/rpg-engine'
import { buildCampaignDungeonThread } from '../campaign/campaign-logic'
import { parseCampaignAdventureCount } from '../campaign/normalizers'
import {
  HUB_TOWN_LOCATION_LABEL,
  buildHubTownNarration,
  buyFromHubTownMarket,
  sellToHubTownMarket,
  visitHubTownLocation,
} from '../systems/hub-town'

type CommandFailure = { ok: false; error: string }
type CommandSuccess = {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
}

type HubTownCommandBaseInput = {
  game: RpgGameState
  gameId: string
  params: Record<string, unknown>
  agentName: string
  deps: HubTownCommandDeps
}

export type HubTownCommandResult = CommandFailure | CommandSuccess

export type HubTownCommandDeps = {
  saveGame: (game: RpgGameState) => Promise<void>
  summarizeParty: (game: RpgGameState) => string
  getCampaign: (id: string) => Promise<CampaignState | null>
  updateCampaign: (id: string, patch: { adventureCount: number }) => Promise<void>
  linkAdventureToCampaign: (envId: string, campaignId: string) => Promise<number>
}

export type HubTownCommandInput = HubTownCommandBaseInput & {
  command: string
}

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

export async function executeVisitLocationCommand(input: HubTownCommandBaseInput): Promise<HubTownCommandResult> {
  const { game, gameId, params, agentName, deps } = input

  const visit = visitHubTownLocation(game, { agentName, location: params.location })
  if (!visit.ok) return { ok: false, error: visit.error }

  await deps.saveGame(game)

  return {
    content: toTextContent(
      `${buildHubTownNarration(game, {
        location: visit.location,
        cue: `You make your way to the ${HUB_TOWN_LOCATION_LABEL[visit.location]}.`,
      })}\n\nParty: ${deps.summarizeParty(game)}`
    ),
    details: { gameId, location: visit.location },
  }
}

export async function executeBuyItemCommand(input: HubTownCommandBaseInput): Promise<HubTownCommandResult> {
  const { game, gameId, params, agentName, deps } = input

  const purchase = buyFromHubTownMarket(game, { agentName, itemId: params.itemId })
  if (!purchase.ok) return { ok: false, error: purchase.error }

  await deps.saveGame(game)

  return {
    content: toTextContent(
      `Bought ${purchase.itemId} (${purchase.itemName}) for ${purchase.cost} gold. (${purchase.gold} gold remaining)`
    ),
    details: { gameId, itemId: purchase.itemId, gold: purchase.gold },
  }
}

export async function executeSellItemCommand(input: HubTownCommandBaseInput): Promise<HubTownCommandResult> {
  const { game, gameId, params, agentName, deps } = input

  const sale = sellToHubTownMarket(game, { agentName, itemId: params.itemId })
  if (!sale.ok) return { ok: false, error: sale.error }

  await deps.saveGame(game)

  return {
    content: toTextContent(`Sold ${sale.itemId} (${sale.itemName}) for ${sale.value} gold. (${sale.gold} gold total)`),
    details: { gameId, itemId: sale.itemId, gold: sale.gold, value: sale.value },
  }
}

export async function executeEmbarkCommand(input: HubTownCommandBaseInput): Promise<HubTownCommandResult> {
  const { game, gameId, agentName, deps } = input

  if (game.phase !== 'hub_town') return { ok: false, error: 'embark is only available in hub_town.' }

  const actingAgent = agentName.trim()
  if (game.currentPlayer !== actingAgent) {
    return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
  }

  const campaignId = typeof game.campaignId === 'string' ? game.campaignId.trim() : ''
  let campaignState: CampaignState | null = null

  if (campaignId) {
    try {
      campaignState = await deps.getCampaign(campaignId)
    } catch {
      campaignState = null
    }
  }

  const fallbackAdventureCount = parseCampaignAdventureCount(game.campaignAdventureNumber, 1)
  const fallbackCampaignState: CampaignState | null = campaignId
    ? {
        id: campaignId,
        name: game.campaignContext?.name ?? 'Campaign',
        premise: game.campaignContext?.premise ?? '',
        worldState: { factions: [], locations: [], events: [] },
        storyArcs: [],
        adventureCount: fallbackAdventureCount,
      }
    : null

  const sourceCampaign = campaignState ?? fallbackCampaignState
  const campaignThread = sourceCampaign ? buildCampaignDungeonThread(sourceCampaign) : null
  const next = createGame({
    id: gameId,
    players: game.party,
    ...(campaignThread ? { campaignState: campaignThread.themedCampaignState } : {}),
  })

  if (campaignThread?.objective) {
    ;(next as Record<string, unknown>).campaignObjective = {
      ...campaignThread.objective,
    }
  }

  if (campaignThread && campaignThread.campaignLog.length > 0) {
    next.campaignLog = campaignThread.campaignLog
  }

  if (campaignThread?.objective && next.campaignContext) {
    const objectiveText = `${campaignThread.objective.arcName}: ${campaignThread.objective.plotPoint}`
    next.campaignContext.activeArcs = [objectiveText, ...(next.campaignContext.activeArcs ?? []).filter((arc) => arc !== objectiveText)].slice(0, 3)
  }

  if (campaignState) {
    const adventureNumber = Math.max(
      Math.floor(campaignState.adventureCount) + 1,
      Number.isFinite(next.campaignAdventureNumber) ? Math.floor(next.campaignAdventureNumber as number) : 1
    )
    next.campaignAdventureNumber = adventureNumber
    try {
      await deps.updateCampaign(campaignState.id, { adventureCount: adventureNumber })
    } catch {
      // best effort
    }
  }

  await deps.saveGame(next)

  if (campaignId) {
    try {
      await deps.linkAdventureToCampaign(gameId, campaignId)
    } catch {
      // best effort — don't break embark
    }
  }

  return {
    content: toTextContent(`You leave town and embark on the next adventure.\n\nParty: ${deps.summarizeParty(next)}`),
    details: {
      gameId,
      phase: next.phase,
      roomIndex: next.roomIndex,
      campaignId: next.campaignId ?? null,
      adventureNumber: next.campaignAdventureNumber ?? null,
    },
  }
}

export async function executeHubTownCommand(input: HubTownCommandInput): Promise<HubTownCommandResult | null> {
  const baseInput: HubTownCommandBaseInput = {
    game: input.game,
    gameId: input.gameId,
    params: input.params,
    agentName: input.agentName,
    deps: input.deps,
  }

  if (input.command === 'visit_location') return executeVisitLocationCommand(baseInput)
  if (input.command === 'buy_item') return executeBuyItemCommand(baseInput)
  if (input.command === 'sell_item') return executeSellItemCommand(baseInput)
  if (input.command === 'embark') return executeEmbarkCommand(baseInput)

  return null
}
