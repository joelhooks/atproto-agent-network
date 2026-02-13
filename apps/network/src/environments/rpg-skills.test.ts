import { describe, expect, it } from 'vitest'

import { DM_SKILL, MAGE_SKILL, PARTY_TACTICS, SCOUT_SKILL, WARRIOR_SKILL } from './rpg-skills'

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

describe('player coordination prompts', () => {
  it('replaces think_aloud with environment_broadcast in party tactics', () => {
    expect(PARTY_TACTICS).toContain('Use `environment_broadcast` to share tactical plans BEFORE acting')
    expect(PARTY_TACTICS).not.toContain('Use `think_aloud` to share tactical plans BEFORE acting')
  })

  it('adds warrior/scout/mage team coordination protocol sections', () => {
    expect(WARRIOR_SKILL).toContain('## Team Coordination Protocol')
    expect(WARRIOR_SKILL).toContain('ANNOUNCE when taunting/tanking')
    expect(WARRIOR_SKILL).toContain('call for heals when low')
    expect(WARRIOR_SKILL).toContain('Use `environment_broadcast` for ALL team communication, not think_aloud')

    expect(SCOUT_SKILL).toContain('## Team Coordination Protocol')
    expect(SCOUT_SKILL).toContain('Report scouted dangers via broadcast')
    expect(SCOUT_SKILL).toContain('Call trap locations immediately')
    expect(SCOUT_SKILL).toContain('Announce flanking plans before committing')
    expect(SCOUT_SKILL).toContain('Use `environment_broadcast` for ALL team communication, not think_aloud')

    expect(MAGE_SKILL).toContain('## Team Coordination Protocol')
    expect(MAGE_SKILL).toContain('Announce AoE targeting before casting')
    expect(MAGE_SKILL).toContain('Request protection when channeling/casting')
    expect(MAGE_SKILL).toContain('Report MP status as fights evolve')
    expect(MAGE_SKILL).toContain('Use `environment_broadcast` for ALL team communication, not think_aloud')
  })
})
