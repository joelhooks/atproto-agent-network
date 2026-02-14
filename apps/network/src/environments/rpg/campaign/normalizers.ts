import { generateTid } from '../../../../../../packages/core/src/identity'

import type {
  CampaignHubTown,
  CampaignHubTownLocation,
  CampaignNpc,
  CampaignPartyMemberSeed,
  CampaignRegionalLocation,
  CampaignVillain,
  StoryArc,
  WorldState,
} from '../../../games/rpg-engine'
import { getDispositionTier } from '../../../games/rpg-engine'
import type { CreateCampaignOptions } from '../interfaces'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCreateCampaignOptions(input?: CreateCampaignOptions | string): CreateCampaignOptions {
  if (typeof input === 'string') {
    const theme = input.trim()
    return theme ? { theme } : {}
  }
  if (!isRecord(input)) return {}

  const theme = typeof input.theme === 'string' ? input.theme.trim() : ''
  const party = Array.isArray(input.party) ? (input.party as CampaignPartyMemberSeed[]) : undefined
  const worldState = isRecord(input.worldState) ? (input.worldState as WorldState) : undefined
  const storyArcs = Array.isArray(input.storyArcs) ? (input.storyArcs as StoryArc[]) : undefined
  return {
    ...(theme ? { theme } : {}),
    ...(party ? { party } : {}),
    ...(worldState ? { worldState } : {}),
    ...(storyArcs ? { storyArcs } : {}),
  }
}

export function normalizeDisposition(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(-100, Math.min(100, Math.floor(n)))
}

function formatSignedDisposition(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`
}

function dispositionTierLabel(value: number): string {
  const tier = getDispositionTier(value)
  return tier === 'allied' ? 'allies' : tier
}

export function formatFactionStandingLine(input: { name: string; disposition: unknown }): string {
  const disposition = normalizeDisposition(input.disposition)
  return `The ${input.name} considers you ${dispositionTierLabel(disposition)} (${formatSignedDisposition(disposition)})`
}

export function buildDefaultWorldState(): WorldState {
  return {
    factions: [],
    locations: [],
    events: [],
  }
}

export function buildDefaultStoryArcs(): StoryArc[] {
  return []
}

export function parseCampaignAdventureCount(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return Math.max(0, Math.floor(fallback))
  return Math.max(0, Math.floor(n))
}

export function normalizeCampaignNpc(raw: unknown): CampaignNpc | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const role = String(raw.role ?? '').trim() || 'Contact'
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  return { name, role, description }
}

export function normalizeCampaignVillain(raw: unknown): CampaignVillain | undefined {
  if (!isRecord(raw)) return undefined
  const name = String(raw.name ?? '').trim()
  if (!name) return undefined
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  const objective = String(raw.objective ?? '').trim() || 'Advance a hidden agenda.'
  const lieutenants = Array.isArray(raw.lieutenants)
    ? raw.lieutenants
      .map((entry) => normalizeCampaignNpc(entry))
      .filter((entry): entry is CampaignNpc => Boolean(entry))
      .slice(0, 6)
    : []
  return { name, description, objective, lieutenants }
}

export function normalizeCampaignHubTownLocation(raw: unknown): CampaignHubTownLocation | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  const shopkeeper = typeof raw.shopkeeper === 'string' ? raw.shopkeeper.trim() : ''
  const questGiver = typeof raw.questGiver === 'string' ? raw.questGiver.trim() : ''
  return {
    name,
    description,
    ...(shopkeeper ? { shopkeeper } : {}),
    ...(questGiver ? { questGiver } : {}),
  }
}

export function normalizeCampaignHubTown(raw: unknown): CampaignHubTown | undefined {
  if (!isRecord(raw)) return undefined
  const name = String(raw.name ?? '').trim()
  if (!name) return undefined
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  const locations = Array.isArray(raw.locations)
    ? raw.locations
      .map((entry) => normalizeCampaignHubTownLocation(entry))
      .filter((entry): entry is CampaignHubTownLocation => Boolean(entry))
      .slice(0, 8)
    : []
  return { name, description, locations }
}

export function normalizeCampaignRegionalLocation(raw: unknown): CampaignRegionalLocation | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const description = String(raw.description ?? '').trim() || 'No details recorded.'
  return { name, description }
}

export function normalizeWorldState(raw: unknown, input: { adventureCount: number }): WorldState & { adventureCount: number } {
  const fallback = buildDefaultWorldState()
  const src = isRecord(raw) ? raw : {}

  const factions = Array.isArray(src.factions)
    ? src.factions
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = String(entry.name ?? '').trim()
        if (!name) return null
        const keyNpc = normalizeCampaignNpc(entry.keyNpc)
        return {
          id: String(entry.id ?? `faction_${generateTid()}`),
          name,
          disposition: normalizeDisposition(entry.disposition),
          description: String(entry.description ?? '').trim() || 'Unknown faction motives.',
          ...(keyNpc ? { keyNpc } : {}),
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : fallback.factions

  const locations = Array.isArray(src.locations)
    ? src.locations
      .map((entry) => {
        if (!isRecord(entry)) return null
        const name = String(entry.name ?? '').trim()
        if (!name) return null
        return {
          id: String(entry.id ?? `location_${generateTid()}`),
          name,
          description: String(entry.description ?? '').trim() || 'No details recorded.',
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : fallback.locations

  const events = Array.isArray(src.events)
    ? src.events
      .map((entry) => {
        if (typeof entry === 'string') {
          const text = entry.trim()
          return text ? text : null
        }
        if (!isRecord(entry)) return null
        const text = String(entry.description ?? '').trim()
        return text ? text : null
      })
      .filter((entry): entry is string => Boolean(entry))
    : fallback.events

  const alliedNpcs = Array.isArray(src.alliedNpcs)
    ? src.alliedNpcs
      .map((entry) => normalizeCampaignNpc(entry))
      .filter((entry): entry is CampaignNpc => Boolean(entry))
      .slice(0, 6)
    : []
  const centralVillain = normalizeCampaignVillain(src.centralVillain)
  const hubTown = normalizeCampaignHubTown(src.hubTown)
  const regionalMap = Array.isArray(src.regionalMap)
    ? src.regionalMap
      .map((entry) => normalizeCampaignRegionalLocation(entry))
      .filter((entry): entry is CampaignRegionalLocation => Boolean(entry))
      .slice(0, 16)
    : []

  const adventureCount = parseCampaignAdventureCount((src as Record<string, unknown>).adventureCount, input.adventureCount)
  return {
    factions,
    locations,
    events,
    ...(alliedNpcs.length ? { alliedNpcs } : {}),
    ...(centralVillain ? { centralVillain } : {}),
    ...(hubTown ? { hubTown } : {}),
    ...(regionalMap.length ? { regionalMap } : {}),
    adventureCount,
  }
}

export function normalizeStoryArcs(raw: unknown): StoryArc[] {
  const fallback = buildDefaultStoryArcs()
  if (!Array.isArray(raw)) return fallback
  const arcs = raw
    .map((entry) => {
      if (!isRecord(entry)) return null
      const name = String(entry.name ?? '').trim()
      if (!name) return null
      const statusRaw = String(entry.status ?? '').trim()
      const status: StoryArc['status'] =
        statusRaw === 'seeded' ||
        statusRaw === 'active' ||
        statusRaw === 'climax' ||
        statusRaw === 'resolved' ||
        statusRaw === 'failed'
          ? statusRaw
          : 'active'
      const plotPoints = Array.isArray(entry.plotPoints)
        ? entry.plotPoints
          .map((point) => {
            if (!isRecord(point)) return null
            const description = String(point.description ?? '').trim()
            if (!description) return null
            const adventureId = typeof point.adventureId === 'string' ? point.adventureId : undefined
            return {
              id: String(point.id ?? `plot_${generateTid()}`),
              description,
              resolved: Boolean(point.resolved),
              ...(adventureId ? { adventureId } : {}),
            }
          })
          .filter((point): point is StoryArc['plotPoints'][number] => Boolean(point))
        : []
      return {
        id: String(entry.id ?? `arc_${generateTid()}`),
        name,
        status,
        plotPoints,
      }
    })
    .filter((arc): arc is StoryArc => Boolean(arc))

  return arcs.length > 0 ? arcs : fallback
}

export function worldStateWithoutMeta(state: WorldState & { adventureCount: number }): WorldState {
  return {
    factions: state.factions,
    locations: state.locations,
    events: state.events,
    ...(Array.isArray(state.alliedNpcs) && state.alliedNpcs.length > 0 ? { alliedNpcs: state.alliedNpcs } : {}),
    ...(state.centralVillain ? { centralVillain: state.centralVillain } : {}),
    ...(state.hubTown ? { hubTown: state.hubTown } : {}),
    ...(Array.isArray(state.regionalMap) && state.regionalMap.length > 0 ? { regionalMap: state.regionalMap } : {}),
  }
}
