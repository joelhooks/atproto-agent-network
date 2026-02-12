import { describe, expect, it } from 'vitest'
import { createCampaign } from './campaign'

import type {
  CampaignState,
  Faction,
  PlotPoint,
  StoryArc,
  WorldState,
} from './campaign'

describe('campaign types', () => {
  it('exposes campaign domain types', () => {
    expect(typeof createCampaign).toBe('function')

    const faction: Faction = {
      id: 'faction-1',
      name: 'Guild of Dawn',
      disposition: 2,
      description: 'A powerful mercantile guild.',
    }

    const plotPoint: PlotPoint = {
      id: 'plot-1',
      description: 'Recover the obsidian key.',
      resolved: false,
      adventureId: 'adv-1',
    }

    const storyArc: StoryArc = {
      id: 'arc-1',
      name: 'Shadows Over Greyhaven',
      status: 'active',
      plotPoints: [plotPoint],
    }

    const worldState: WorldState = {
      factions: [faction],
      locations: [
        { id: 'loc-1', name: 'Greyhaven', description: 'A city on the coast.' },
      ],
      events: ['The council closed the harbor gates.'],
    }

    const campaign: CampaignState = {
      id: 'campaign-1',
      name: 'Greyhaven Chronicles',
      premise: 'A kingdom in decline faces ancient threats.',
      worldState,
      storyArcs: [storyArc],
      adventureCount: 0,
    }

    expect(campaign.name).toBe('Greyhaven Chronicles')
    expect(campaign.storyArcs[0]?.status).toBe('active')
    expect(campaign.worldState.factions[0]?.name).toBe('Guild of Dawn')
  })
})
