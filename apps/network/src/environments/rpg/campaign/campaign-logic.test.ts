import { describe, expect, it } from 'vitest'

import type { CampaignState, StoryArc } from '../../../games/rpg-engine'
import {
  applyDispositionForEncounterOutcome,
  buildCampaignDungeonThread,
  pickCampaignObjective,
  resolveStoryArcsForAdventureOutcome,
} from './campaign-logic'

function makeCampaign(input?: Partial<CampaignState>): CampaignState {
  return {
    id: 'campaign_1',
    name: 'Ashfall Chronicles',
    premise: 'A comet fractures the north.',
    worldState: {
      factions: [{ id: 'iron', name: 'Iron Vanguard', disposition: 10, description: 'Defenders of the passes.' }],
      locations: [],
      events: [],
    },
    storyArcs: [],
    adventureCount: 0,
    ...input,
  }
}

describe('campaign logic', () => {
  it('picks the first unresolved plot point from active arcs', () => {
    const objective = pickCampaignObjective(
      makeCampaign({
        storyArcs: [
          {
            id: 'arc_done',
            name: 'Completed Arc',
            status: 'active',
            plotPoints: [{ id: 'pp_done', description: 'Done', resolved: true }],
          },
          {
            id: 'arc_focus',
            name: 'Cometfall Conspiracy',
            status: 'active',
            plotPoints: [{ id: 'pp_focus', description: 'Recover the sunstone', resolved: false }],
          },
        ],
      })
    )

    expect(objective).toEqual({
      arcId: 'arc_focus',
      arcName: 'Cometfall Conspiracy',
      plotPointId: 'pp_focus',
      plotPoint: 'Recover the sunstone',
    })
  })

  it('builds a campaign dungeon thread with objective theming and recap lines', () => {
    const thread = buildCampaignDungeonThread(
      makeCampaign({
        premise: 'The crown war escalates.',
        worldState: {
          factions: [],
          locations: [],
          events: [
            'Adventure #1 (rpg_1) ended in victory: The gate was held.',
            'Adventure #2 (rpg_2) ended in tpk: The camp fell.',
          ],
        },
        storyArcs: [
          {
            id: 'arc_focus',
            name: 'Crownfire',
            status: 'active',
            plotPoints: [{ id: 'pp_focus', description: 'Recover the ember sigil', resolved: false }],
          },
        ],
        adventureCount: 2,
      })
    )

    expect(thread.objective?.arcId).toBe('arc_focus')
    expect(thread.themedCampaignState.premise).toContain('Current objective: Crownfire: Recover the ember sigil.')
    expect(thread.campaignLog.some((line) => line.startsWith('Previously on:'))).toBe(true)
    expect(thread.campaignLog.some((line) => line.includes('Adventure #2'))).toBe(true)
  })

  it('resolves arcs by objective and marks tpk outcomes as failed', () => {
    const next = resolveStoryArcsForAdventureOutcome({
      storyArcs: [
        {
          id: 'arc_alpha',
          name: 'Alpha',
          status: 'active',
          plotPoints: [{ id: 'pp_alpha', description: 'Scout the pass', resolved: false }],
        },
        {
          id: 'arc_beta',
          name: 'Beta',
          status: 'active',
          plotPoints: [{ id: 'pp_beta', description: 'Secure the relic', resolved: false }],
        },
      ] satisfies StoryArc[],
      gameId: 'rpg_9',
      outcome: 'tpk',
      objective: { arcId: 'arc_beta', plotPointId: 'pp_beta' },
    })

    const beta = next.find((arc) => arc.id === 'arc_beta')
    expect(beta?.status).toBe('failed')
    expect(beta?.plotPoints[0]).toMatchObject({
      id: 'pp_beta',
      resolved: true,
      adventureId: 'rpg_9',
    })
  })

  it('applies disposition tracking once per faction for encounter outcomes', () => {
    const afterKill = applyDispositionForEncounterOutcome({
      campaign: makeCampaign(),
      enemies: [
        { name: 'Iron Scout', hp: 4, DEX: 45, attack: 35, dodge: 20, factionId: 'iron' },
        { name: 'Iron Captain', hp: 8, DEX: 55, attack: 45, dodge: 25, factionId: 'iron' },
      ],
      resolution: 'kill',
      reason: 'Violence against faction patrol.',
    })
    expect(afterKill.worldState.factions[0]?.disposition).toBe(-10)

    const afterNegotiation = applyDispositionForEncounterOutcome({
      campaign: afterKill,
      enemies: [{ name: 'Iron Envoy', hp: 6, DEX: 50, attack: 30, dodge: 30, factionId: 'iron' }],
      resolution: 'negotiate',
      reason: 'Brokered truce with patrol.',
    })
    expect(afterNegotiation.worldState.factions[0]?.disposition).toBe(0)
  })
})
