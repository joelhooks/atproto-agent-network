import { describe, expect, it } from 'vitest'

import type { PersistentCharacter } from '@atproto-agent/core'

import { createGame } from '../../../../games/rpg-engine'
import {
  InMemoryCampaignRepository,
  InMemoryCharacterRepository,
  InMemoryGameStateRepository,
} from './in-memory'

describe('InMemory repositories', () => {
  it('supports game create/load/save/find flows', async () => {
    const games = new InMemoryGameStateRepository()
    const game = createGame({ id: 'rpg_in_memory_game', players: ['slag', 'snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })

    await games.create(game.id, game, { hostAgent: 'grimlock', players: ['slag', 'snarl'], type: 'rpg' })

    const active = await games.findActiveForAgent('slag')
    expect(active?.id).toBe(game.id)

    const loaded = await games.load(game.id)
    loaded.phase = 'finished'
    ;(loaded as { winner?: string }).winner = 'slag'
    await games.save(game.id, loaded)

    const after = await games.load(game.id)
    expect(after.phase).toBe('finished')
  })

  it('supports campaign lifecycle and adventure linking', async () => {
    const games = new InMemoryGameStateRepository()
    const campaigns = new InMemoryCampaignRepository(games)

    const game = createGame({ id: 'rpg_in_memory_link', players: ['slag'], dungeon: [{ type: 'rest', description: 'safe' }] })
    await games.create(game.id, game, { hostAgent: 'grimlock', players: ['slag'], type: 'rpg' })

    const campaign = await campaigns.create('Ashen Crown', 'A shattered realm')
    await campaigns.update(campaign.id, { adventureCount: 2 })

    const adventureNumber = await campaigns.linkAdventure(game.id, campaign.id)
    expect(adventureNumber).toBe(3)

    const latest = await campaigns.findLatest()
    expect(latest?.id).toBe(campaign.id)
  })

  it('supports character load/save', async () => {
    const characters = new InMemoryCharacterRepository()

    const character: PersistentCharacter = {
      name: 'Skarn',
      klass: 'Warrior',
      level: 1,
      xp: 0,
      maxHp: 12,
      maxMp: 5,
      skills: { attack: 30, dodge: 25, cast_spell: 15, use_skill: 20 },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: [],
      achievements: [],
      inventory: [],
      createdAt: 1,
      updatedAt: 1,
      gamesPlayed: 0,
      deaths: 0,
      dead: false,
    }

    await characters.save(character)
    await expect(characters.load()).resolves.toEqual(character)
  })
})
