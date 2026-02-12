import { describe, expect, it } from 'vitest'

import { DM_SKILL } from './rpg-skills'

describe('DM_SKILL campaign lifecycle playbook', () => {
  it('includes explicit lifecycle rules used by autoplay heuristics', () => {
    expect(DM_SKILL).toContain('## Campaign Lifecycle Playbook')
    expect(DM_SKILL).toContain('### When dungeon has 0 rooms')
    expect(DM_SKILL).toContain('consult_library')
    expect(DM_SKILL).toContain('craft_dungeon')

    expect(DM_SKILL).toContain('### When adventure ends')
    expect(DM_SKILL).toContain('advance_campaign')
    expect(DM_SKILL).toContain('hub_town')

    expect(DM_SKILL).toContain('### When in hub_town and party embarks')
    expect(DM_SKILL).toContain('start next adventure')

    expect(DM_SKILL).toContain("### When it's not your turn")
    expect(DM_SKILL).toContain('observe')
    expect(DM_SKILL).toContain('prepare next encounter')
    expect(DM_SKILL).toContain('upcoming rooms')
  })
})
