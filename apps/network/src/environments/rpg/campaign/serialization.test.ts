import { describe, expect, it } from 'vitest'

import type { CampaignState } from '../../../games/rpg-engine'
import { rowToCampaignState, serializeWorldState, type CampaignRow } from './serialization'

function makeCampaign(input?: Partial<CampaignState>): CampaignState {
  return {
    id: 'campaign_1',
    name: 'Ashen Crown',
    premise: 'A fractured crown ignites war.',
    worldState: {
      factions: [{ id: 'f1', name: 'Iron Vanguard', disposition: 20, description: 'Border wardens' }],
      locations: [{ id: 'l1', name: 'Old Keep', description: 'Collapsed fortification' }],
      events: ['A caravan vanished at dusk.'],
    },
    storyArcs: [
      {
        id: 'arc_1',
        name: 'Crownfire',
        status: 'active',
        plotPoints: [{ id: 'pp_1', description: 'Recover the ember sigil.', resolved: false }],
      },
    ],
    adventureCount: 3,
    ...input,
  }
}

describe('campaign serialization', () => {
  it('serializes campaign world state with adventureCount and optional world data', () => {
    const serialized = serializeWorldState(
      makeCampaign({
        worldState: {
          factions: [],
          locations: [],
          events: [],
          alliedNpcs: [{ name: 'Iri', role: 'Quartermaster', description: 'Supplies expeditions.' }],
          centralVillain: { name: 'Duke Thorne', description: 'A warlord.', objective: 'Seize the crown.', lieutenants: [] },
        },
      })
    )
    const payload = JSON.parse(serialized)

    expect(payload).toMatchObject({
      factions: [],
      locations: [],
      events: [],
      adventureCount: 3,
    })
    expect(payload.alliedNpcs).toHaveLength(1)
    expect(payload.centralVillain.name).toBe('Duke Thorne')
  })

  it('maps D1 rows to CampaignState and strips adventureCount from worldState', () => {
    const row: CampaignRow = {
      id: 'campaign_row_1',
      name: '  Emberfall  ',
      premise: '  Hold the frontier.  ',
      world_state: JSON.stringify({
        factions: [{ id: 'f1', name: 'Wardens', disposition: '9', description: 'Road defenders' }],
        locations: [],
        events: ['Adventure #1 ended in victory.'],
        adventureCount: '2',
      }),
      story_arcs: JSON.stringify([
        {
          id: 'arc_1',
          name: 'Frontier Oaths',
          status: 'active',
          plotPoints: [{ id: 'pp_1', description: 'Secure the bridge', resolved: false }],
        },
      ]),
      created_at: null,
      updated_at: null,
    }

    const campaign = rowToCampaignState(row)
    expect(campaign.name).toBe('Emberfall')
    expect(campaign.premise).toBe('Hold the frontier.')
    expect(campaign.adventureCount).toBe(2)
    expect(campaign.worldState).toEqual({
      factions: [{ id: 'f1', name: 'Wardens', disposition: 9, description: 'Road defenders' }],
      locations: [],
      events: ['Adventure #1 ended in victory.'],
    })
    expect(campaign.storyArcs).toHaveLength(1)
  })

  it('falls back gracefully when row JSON is invalid', () => {
    const campaign = rowToCampaignState({
      id: 'campaign_bad_json',
      name: '',
      premise: null,
      world_state: '{bad json',
      story_arcs: 'nope',
      created_at: null,
      updated_at: null,
    })

    expect(campaign.name).toBe('Untitled Campaign')
    expect(campaign.worldState).toEqual({ factions: [], locations: [], events: [] })
    expect(campaign.storyArcs).toEqual([])
    expect(campaign.adventureCount).toBe(0)
  })
})
