import { describe, expect, it } from 'vitest'

import type { PersistentCharacter } from '@atproto-agent/core'

import { DOCharacterRepository } from './character.do-storage'

class FakeStorage {
  private readonly data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key)
    return value == null ? undefined : structuredClone(value as T)
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value))
  }
}

describe('DOCharacterRepository', () => {
  it('returns null when no character is present', async () => {
    const storage = new FakeStorage()
    const repo = new DOCharacterRepository(storage as unknown as DurableObjectStorage)

    await expect(repo.load()).resolves.toBeNull()
  })

  it('saves and loads the persistent character at rpg:character', async () => {
    const storage = new FakeStorage()
    const repo = new DOCharacterRepository(storage as unknown as DurableObjectStorage)

    const character: PersistentCharacter = {
      name: 'Skarn',
      klass: 'Warrior',
      level: 3,
      xp: 220,
      maxHp: 20,
      maxMp: 8,
      skills: { attack: 42, dodge: 33, cast_spell: 15, use_skill: 24 },
      backstory: 'Former caravan guard.',
      motivation: 'Protect the village.',
      appearance: 'Scarred and broad-shouldered.',
      personalityTraits: ['gruff', 'loyal'],
      adventureLog: [],
      achievements: ['First Blood'],
      inventory: [],
      createdAt: 1,
      updatedAt: 2,
      gamesPlayed: 5,
      deaths: 0,
      dead: false,
    }

    await repo.save(character)

    const loaded = await repo.load()
    expect(loaded).toEqual(character)
  })

  it('overwrites existing character state on save', async () => {
    const storage = new FakeStorage()
    const repo = new DOCharacterRepository(storage as unknown as DurableObjectStorage)

    const first: PersistentCharacter = {
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

    const second: PersistentCharacter = {
      ...first,
      level: 2,
      xp: 80,
      updatedAt: 2,
    }

    await repo.save(first)
    await repo.save(second)

    await expect(repo.load()).resolves.toEqual(second)
  })
})
