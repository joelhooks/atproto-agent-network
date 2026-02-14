import { describe, expect, it } from 'vitest'

import type { CreateCampaignOptions } from '../interfaces'
import {
  formatFactionStandingLine,
  normalizeCreateCampaignOptions,
  normalizeStoryArcs,
  normalizeWorldState,
  parseCampaignAdventureCount,
  worldStateWithoutMeta,
} from './normalizers'

describe('campaign normalizers', () => {
  it('normalizes createCampaign options from both string and object inputs', () => {
    expect(normalizeCreateCampaignOptions('  Stormwatch  ')).toEqual({ theme: 'Stormwatch' })
    expect(normalizeCreateCampaignOptions('   ')).toEqual({})

    const fromObject = normalizeCreateCampaignOptions({
      theme: '  Emberfall  ',
      party: [{ klass: 'Warrior', level: 2 }],
      worldState: { factions: [], locations: [], events: [] },
      storyArcs: [],
    } satisfies CreateCampaignOptions)

    expect(fromObject.theme).toBe('Emberfall')
    expect(fromObject.party).toHaveLength(1)
    expect(fromObject.worldState?.events).toEqual([])
    expect(fromObject.storyArcs).toEqual([])
  })

  it('normalizes world state and strips meta adventureCount from campaign payload', () => {
    const world = normalizeWorldState(
      {
        factions: [{ name: 'Iron Vanguard', disposition: 140.9, description: 'Guard', keyNpc: { name: 'Mirel' } }],
        locations: [{ name: 'Old Keep' }],
        events: ['  Bridge defended.  ', { description: 'Siege line collapsed.' }, { text: 'ignored' }],
        centralVillain: { name: 'Duke Thorne' },
        hubTown: { name: 'Cinderwatch', locations: [{ name: 'Bazaar' }] },
        regionalMap: [{ name: 'Ash Crypt' }],
        adventureCount: '4',
      },
      { adventureCount: 1 }
    )

    expect(world.factions[0]?.disposition).toBe(100)
    expect(world.factions[0]?.keyNpc?.role).toBe('Contact')
    expect(world.locations[0]?.description).toBe('No details recorded.')
    expect(world.events).toEqual(['Bridge defended.', 'Siege line collapsed.'])
    expect(world.adventureCount).toBe(4)

    expect(worldStateWithoutMeta(world)).toEqual({
      factions: world.factions,
      locations: world.locations,
      events: world.events,
      centralVillain: world.centralVillain,
      hubTown: world.hubTown,
      regionalMap: world.regionalMap,
    })
  })

  it('normalizes story arcs, disposition strings, and adventure count fallback values', () => {
    const arcs = normalizeStoryArcs([
      {
        name: 'Cometfall',
        status: 'unknown-status',
        plotPoints: [{ description: 'Recover the sigil', resolved: 1 }],
      },
      { status: 'active' },
    ])

    expect(arcs).toHaveLength(1)
    expect(arcs[0]?.status).toBe('active')
    expect(arcs[0]?.id.startsWith('arc_')).toBe(true)
    expect(arcs[0]?.plotPoints[0]?.id.startsWith('plot_')).toBe(true)
    expect(arcs[0]?.plotPoints[0]?.description).toBe('Recover the sigil')
    expect(arcs[0]?.plotPoints[0]?.resolved).toBe(true)

    expect(parseCampaignAdventureCount('not-a-number', 7)).toBe(7)
    expect(parseCampaignAdventureCount(-3, 7)).toBe(0)
    expect(formatFactionStandingLine({ name: 'Iron Vanguard', disposition: '-130' })).toContain('hostile (-100)')
  })
})
