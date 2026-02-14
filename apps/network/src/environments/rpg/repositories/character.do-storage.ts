import type { PersistentCharacter } from '@atproto-agent/core'

import type { CharacterRepository } from '../interfaces'

export const RPG_CHARACTER_STORAGE_KEY = 'rpg:character'

export class DOCharacterRepository implements CharacterRepository {
  constructor(private readonly storage: Pick<DurableObjectStorage, 'get' | 'put'>) {}

  async load(): Promise<PersistentCharacter | null> {
    const value = await this.storage.get<PersistentCharacter>(RPG_CHARACTER_STORAGE_KEY)
    return value ?? null
  }

  async save(character: PersistentCharacter): Promise<void> {
    await this.storage.put(RPG_CHARACTER_STORAGE_KEY, character)
  }
}
