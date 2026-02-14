import type {
  Character,
  Dice,
  Enemy,
  LootTier,
  RpgGameState,
} from '../../../games/rpg-engine'
import {
  XP_PER_TREASURE_FIND,
  applyLootToCharacter,
  formatLootSummary,
  generateLoot,
  isBossEncounterRoom,
  recordNarrativeBeat,
} from '../../../games/rpg-engine'
import { addLoggedXp, type XpSystemOptions } from './xp-system'

export type LootSystemOptions = XpSystemOptions

function characterId(character: Character | undefined | null): string {
  if (!character) return 'unknown'
  return character.agent ?? character.name
}

function clampGold(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

function ensureCharacterLootState(character: Character | undefined | null): void {
  if (!character) return
  character.inventory = Array.isArray(character.inventory) ? character.inventory : []
  character.gold = clampGold(character.gold)
}

function roomLootTier(game: RpgGameState, roomIndex: number, roomType?: string): LootTier {
  if (roomType === 'boss') return 'boss'
  const total = Math.max(1, Array.isArray(game.dungeon) ? game.dungeon.length : 1)
  const progress = (Math.max(0, roomIndex) + 1) / total
  if (progress <= 0.4) return 'early'
  if (progress <= 0.8) return 'mid'
  return 'boss'
}

export function resolveTreasureLoot(
  game: RpgGameState,
  actor: Character,
  dice: Dice,
  options: LootSystemOptions = {}
): string {
  const now = options.now ?? Date.now
  ensureCharacterLootState(actor)
  const tier = roomLootTier(game, game.roomIndex, game.dungeon[game.roomIndex]?.type)
  const loot = generateLoot({ tier, source: 'treasure', dice, seedIndex: game.roomIndex })
  applyLootToCharacter(actor, loot)

  const treasureXp = Math.max(0, loot.items.length) * XP_PER_TREASURE_FIND
  if (treasureXp > 0) addLoggedXp(game, characterId(actor), treasureXp, 'treasure', options)

  const beat = loot.items[0]?.name ?? `${loot.gold} gold pieces`
  if (beat) recordNarrativeBeat(game, { kind: 'treasure', text: beat, roomIndex: game.roomIndex, at: now() })

  const summary = formatLootSummary(loot)
  game.log ??= []
  game.log.push({
    at: now(),
    who: characterId(actor),
    what: `Found: ${summary}`,
  })
  return `Found: ${summary}`
}

export function maybeAwardEnemyDrop(
  game: RpgGameState,
  actor: Character,
  enemy: Enemy,
  dice: Dice,
  options: LootSystemOptions = {}
): string | null {
  const now = options.now ?? Date.now
  ensureCharacterLootState(actor)
  const bossEnemy = enemy?.tactics?.kind === 'boss' || isBossEncounterRoom(game)
  const roll = dice.d100()
  if (!bossEnemy && roll > 20) return null

  const tier: LootTier = bossEnemy ? 'boss' : roomLootTier(game, game.roomIndex, game.dungeon[game.roomIndex]?.type)
  const loot = generateLoot({ tier, source: 'combat', dice, ...(bossEnemy ? { seedIndex: game.roomIndex } : {}) })
  applyLootToCharacter(actor, loot)
  const summary = formatLootSummary(loot)
  const line = `${enemy.name} dropped ${summary}`
  game.log ??= []
  game.log.push({
    at: now(),
    who: characterId(actor),
    what: `loot drop: ${line}`,
  })
  return line
}
