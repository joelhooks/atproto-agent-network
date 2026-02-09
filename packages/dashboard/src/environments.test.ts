import { describe, expect, it } from 'vitest'

import { renderEnvironmentCard } from './environments'

describe('dashboard environment cards', () => {
  it('renders a catan environment summary with VP/settlements/roads/resources', () => {
    const html = renderEnvironmentCard(
      {
        id: 'catan_1',
        type: 'catan',
        hostAgent: 'grimlock',
        phase: 'playing',
        players: ['grimlock', 'slag'],
        winner: null,
        createdAt: '2026-02-09T00:00:00.000Z',
        updatedAt: '2026-02-09T00:00:00.000Z',
        state: {
          id: 'catan_1',
          phase: 'playing',
          turn: 3,
          staleTurns: 0,
          currentPlayer: 'grimlock',
          players: [
            {
              name: 'grimlock',
              victoryPoints: 4,
              settlements: [1, 2],
              roads: [1, 2, 3],
              resources: { wood: 2, brick: 1, sheep: 0, wheat: 1, ore: 0 },
            },
            {
              name: 'slag',
              victoryPoints: 2,
              settlements: [3],
              roads: [4],
              resources: { wood: 0, brick: 0, sheep: 1, wheat: 0, ore: 2 },
            },
          ],
          board: { hexes: [], vertices: [], edges: [] },
          lastDiceRoll: null,
          trades: [],
          log: [],
          winner: null,
          setupRound: 0,
        },
      },
      'grimlock'
    )

    expect(html).toContain('Catan')
    expect(html).toContain('playing')
    expect(html).toContain('VP')
    expect(html).toContain('settle')
    expect(html).toContain('road')
    expect(html).toContain('wood')
  })

  it('renders an rpg environment character sheet with class, HP, skills, and room', () => {
    const html = renderEnvironmentCard(
      {
        id: 'rpg_1',
        type: 'rpg',
        hostAgent: 'snarl',
        phase: 'playing',
        players: ['snarl', 'swoop'],
        winner: null,
        createdAt: '2026-02-09T00:00:00.000Z',
        updatedAt: '2026-02-09T00:00:00.000Z',
        state: {
          id: 'rpg_1',
          type: 'rpg',
          phase: 'playing',
          mode: 'exploring',
          roomIndex: 0,
          dungeon: [{ type: 'rest', description: 'A quiet alcove.' }],
          party: [
            {
              name: 'swoop',
              klass: 'Mage',
              stats: { STR: 35, DEX: 45, INT: 80, WIS: 55 },
              skills: { attack: 55, dodge: 45, cast_spell: 65, use_skill: 50 },
              hp: 9,
              maxHp: 9,
              mp: 10,
              maxMp: 10,
            },
          ],
          turnOrder: [],
          currentPlayer: 'swoop',
          log: [],
        },
      },
      'swoop'
    )

    expect(html).toContain('RPG')
    expect(html).toContain('Mage')
    expect(html).toContain('HP')
    expect(html).toContain('Skills')
    expect(html).toContain('Room')
  })
})
