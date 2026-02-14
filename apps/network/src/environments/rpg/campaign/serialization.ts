import type { CampaignState } from '../../../games/rpg-engine'
import {
  normalizeStoryArcs,
  normalizeWorldState,
  parseCampaignAdventureCount,
  worldStateWithoutMeta,
} from './normalizers'

export type CampaignRow = {
  id: string
  name: string
  premise: string | null
  world_state: string | null
  story_arcs: string | null
  created_at: string | null
  updated_at: string | null
}

export function rowToCampaignState(row: CampaignRow): CampaignState {
  const name = String(row.name || 'Untitled Campaign').trim() || 'Untitled Campaign'
  const premise = String(row.premise || '').trim()
  const worldRaw = (() => {
    try {
      return row.world_state ? JSON.parse(row.world_state) : {}
    } catch {
      return {}
    }
  })()
  const arcsRaw = (() => {
    try {
      return row.story_arcs ? JSON.parse(row.story_arcs) : []
    } catch {
      return []
    }
  })()
  const worldStateWithMeta = normalizeWorldState(worldRaw, { adventureCount: 0 })
  const adventureCount = parseCampaignAdventureCount(worldStateWithMeta.adventureCount, 0)

  return {
    id: row.id,
    name,
    premise,
    worldState: worldStateWithoutMeta(worldStateWithMeta),
    storyArcs: normalizeStoryArcs(arcsRaw),
    adventureCount,
  }
}

export function serializeWorldState(state: CampaignState): string {
  const payload: Record<string, unknown> = {
    factions: state.worldState.factions,
    locations: state.worldState.locations,
    events: state.worldState.events,
    adventureCount: state.adventureCount,
  }
  if (Array.isArray(state.worldState.alliedNpcs) && state.worldState.alliedNpcs.length > 0) {
    payload.alliedNpcs = state.worldState.alliedNpcs
  }
  if (state.worldState.centralVillain) payload.centralVillain = state.worldState.centralVillain
  if (state.worldState.hubTown) payload.hubTown = state.worldState.hubTown
  if (Array.isArray(state.worldState.regionalMap) && state.worldState.regionalMap.length > 0) {
    payload.regionalMap = state.worldState.regionalMap
  }
  return JSON.stringify(payload)
}
