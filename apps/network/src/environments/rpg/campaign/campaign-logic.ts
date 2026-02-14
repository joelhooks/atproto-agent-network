import type { CampaignState, Enemy, StoryArc } from '../../../games/rpg-engine'
import { adjustDisposition, previously_on } from '../../../games/rpg-engine'

export type CampaignDungeonObjective = {
  arcId: string
  arcName: string
  plotPointId: string
  plotPoint: string
}

function factionIdsFromEnemies(enemies: Enemy[]): string[] {
  const ids = new Set<string>()
  for (const enemy of Array.isArray(enemies) ? enemies : []) {
    const factionId = typeof enemy?.factionId === 'string' ? enemy.factionId.trim() : ''
    if (!factionId) continue
    ids.add(factionId)
  }
  return [...ids]
}

export function applyDispositionForEncounterOutcome(input: {
  campaign: CampaignState
  enemies: Enemy[]
  resolution: 'kill' | 'negotiate'
  reason: string
}): CampaignState {
  const delta = input.resolution === 'kill' ? -20 : 10
  let next = input.campaign
  for (const factionId of factionIdsFromEnemies(input.enemies)) {
    next = adjustDisposition(next, factionId, delta, input.reason)
  }
  return next
}

function copyStoryArcs(storyArcs: StoryArc[]): StoryArc[] {
  return (Array.isArray(storyArcs) ? storyArcs : []).map((arc) => ({
    ...arc,
    plotPoints: Array.isArray(arc.plotPoints) ? arc.plotPoints.map((plotPoint) => ({ ...plotPoint })) : [],
  }))
}

function firstSentence(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const idx = clean.search(/[.!?]/)
  if (idx < 0) return clean.slice(0, 220)
  return clean.slice(0, Math.min(clean.length, idx + 1)).trim()
}

function adventureRecapsFromEvents(events: unknown, limit = 3): string[] {
  if (!Array.isArray(events)) return []
  const adventureEvents = events
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.startsWith('Adventure #'))
  const recent = adventureEvents.slice(Math.max(0, adventureEvents.length - Math.max(1, Math.floor(limit))))
  return recent.map((entry) => firstSentence(entry)).filter(Boolean)
}

export function pickCampaignObjective(campaign: CampaignState): CampaignDungeonObjective | null {
  const arcs = Array.isArray(campaign.storyArcs) ? campaign.storyArcs : []
  for (const arc of arcs) {
    if (!arc || arc.status !== 'active') continue
    const unresolved = Array.isArray(arc.plotPoints) ? arc.plotPoints.find((plotPoint) => !plotPoint.resolved) : null
    if (!unresolved) continue
    const plotPoint = String(unresolved.description || '').trim()
    if (!plotPoint) continue
    return {
      arcId: String(arc.id || ''),
      arcName: String(arc.name || '').trim() || 'Active Arc',
      plotPointId: String(unresolved.id || ''),
      plotPoint,
    }
  }
  return null
}

function themeCampaignStateForObjective(campaign: CampaignState, objective: CampaignDungeonObjective | null): CampaignState {
  if (!objective) return campaign
  const storyArcs = copyStoryArcs(campaign.storyArcs)
  const chosenIndex = storyArcs.findIndex((arc) => arc.id === objective.arcId)
  if (chosenIndex > 0) {
    const [chosen] = storyArcs.splice(chosenIndex, 1)
    if (chosen) storyArcs.unshift(chosen)
  }

  const objectiveLine = `${objective.arcName}: ${objective.plotPoint}`
  const basePremise = String(campaign.premise || '').trim()
  const alreadyPresent = basePremise.toLowerCase().includes(objective.plotPoint.toLowerCase())
  const premise = alreadyPresent
    ? basePremise
    : [basePremise, `Current objective: ${objectiveLine}.`].filter(Boolean).join(' ')

  return {
    ...campaign,
    premise,
    storyArcs,
  }
}

function campaignLogFromThread(input: {
  campaign: CampaignState
  objective: CampaignDungeonObjective | null
  recaps: string[]
  previouslyOn: string
}): string[] {
  const lines: string[] = [
    `Campaign: ${input.campaign.name}`,
    `Arc focus: ${input.objective?.arcName ?? 'none'}`,
    `Premise: ${input.campaign.premise}`,
  ]
  if (input.objective) {
    lines.push(`Current objective: ${input.objective.arcName} — ${input.objective.plotPoint}`)
  }
  if (input.previouslyOn) {
    lines.push(`Previously on: ${input.previouslyOn}`)
  }
  for (const recap of input.recaps) {
    const trimmed = String(recap || '').trim()
    if (!trimmed) continue
    lines.push(`Previously on: ${trimmed}`)
  }
  return lines
}

export function buildCampaignDungeonThread(campaign: CampaignState): {
  objective: CampaignDungeonObjective | null
  themedCampaignState: CampaignState
  campaignLog: string[]
} {
  const objective = pickCampaignObjective(campaign)
  const themedCampaignState = themeCampaignStateForObjective(campaign, objective)
  const recaps = adventureRecapsFromEvents(campaign.worldState?.events, 3)
  const previouslyOn = previously_on({
    campaignName: campaign.name,
    premise: campaign.premise,
    activeArcs: objective ? [objective.arcName] : campaign.storyArcs.filter((arc) => arc.status === 'active').map((arc) => arc.name),
    history: campaign.worldState?.events,
    adventureCount: campaign.adventureCount,
  })
  const campaignLog = campaignLogFromThread({ campaign, objective, recaps, previouslyOn })
  return {
    objective,
    themedCampaignState,
    campaignLog,
  }
}

export function resolveStoryArcsForAdventureOutcome(input: {
  storyArcs: StoryArc[]
  gameId: string
  outcome: 'victory' | 'tpk' | 'abandoned'
  objective?: Pick<CampaignDungeonObjective, 'arcId' | 'plotPointId'>
}): StoryArc[] {
  const nextArcs = copyStoryArcs(input.storyArcs)
  let targetArc: StoryArc | undefined
  let targetPoint: StoryArc['plotPoints'][number] | undefined

  if (input.objective?.arcId && input.objective?.plotPointId) {
    targetArc = nextArcs.find((arc) => arc.id === input.objective!.arcId)
    targetPoint = targetArc?.plotPoints.find((plotPoint) => plotPoint.id === input.objective!.plotPointId)
  }

  if (!targetArc || !targetPoint) {
    targetArc = nextArcs.find((arc) => arc.status === 'active' && arc.plotPoints.some((plotPoint) => !plotPoint.resolved))
    targetPoint = targetArc?.plotPoints.find((plotPoint) => !plotPoint.resolved)
  }

  if (targetPoint) {
    targetPoint.resolved = true
    targetPoint.adventureId = input.gameId
  }
  if (targetArc) {
    if (input.outcome === 'tpk') {
      targetArc.status = 'failed'
    } else if (!targetArc.plotPoints.some((plotPoint) => !plotPoint.resolved)) {
      targetArc.status = 'resolved'
    }
  }

  return nextArcs
}
