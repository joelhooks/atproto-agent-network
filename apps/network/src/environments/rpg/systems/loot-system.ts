import type {
  Character,
  Dice,
  Enemy,
  LootItem,
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
import type { LootSystem } from '../interfaces'

export type LootSystemOptions = XpSystemOptions
export type HubTownShopItem = {
  id: string
  cost: number
  sellValue: number
  item: LootItem
}

export type HubTownBuyResult =
  | { ok: true; listing: HubTownShopItem; item: LootItem }
  | { ok: false; error: string }

export type HubTownSellResult =
  | { ok: true; item: LootItem; itemId: string; value: number }
  | { ok: false; error: string }

function characterId(character: Character | undefined | null): string {
  if (!character) return 'unknown'
  return character.agent ?? character.name
}

function clampGold(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

function clampSkill(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(100, Math.floor(value)))
}

export function ensureCharacterLootState(character: Character | undefined | null): void {
  if (!character) return
  character.inventory = Array.isArray(character.inventory) ? character.inventory : []
  character.gold = clampGold(character.gold)
}

export function normalizePartyLootState(game: RpgGameState): void {
  for (const member of Array.isArray(game.party) ? game.party : []) {
    ensureCharacterLootState(member)
  }
}

function roomLootTier(game: RpgGameState, roomIndex: number, roomType?: string): LootTier {
  if (roomType === 'boss') return 'boss'
  const total = Math.max(1, Array.isArray(game.dungeon) ? game.dungeon.length : 1)
  const progress = (Math.max(0, roomIndex) + 1) / total
  if (progress <= 0.4) return 'early'
  if (progress <= 0.8) return 'mid'
  return 'boss'
}

export function makeShopHealingPotion(dice: Dice): LootItem {
  return {
    name: 'Camp Healing Potion',
    rarity: 'common',
    slot: 'consumable',
    effects: [],
    consumable: { type: 'heal', amount: dice.d(6) + dice.d(6) + 3 },
    description: 'A reliable tonic mixed from field herbs and bright salts.',
  }
}

const HUB_TOWN_SHOP: Record<string, HubTownShopItem> = {
  iron_sword: {
    id: 'iron_sword',
    cost: 45,
    sellValue: 22,
    item: {
      name: 'Iron Sword',
      rarity: 'uncommon',
      slot: 'weapon',
      effects: [{ stat: 'attack', bonus: 3 }],
      description: 'A balanced, dependable blade favored by caravan guards.',
    },
  },
  chain_jerkin: {
    id: 'chain_jerkin',
    cost: 40,
    sellValue: 20,
    item: {
      name: 'Chain Jerkin',
      rarity: 'uncommon',
      slot: 'armor',
      effects: [{ stat: 'dodge', bonus: 3 }],
      description: 'Interlocked rings that soften glancing blows.',
    },
  },
  runed_charm: {
    id: 'runed_charm',
    cost: 55,
    sellValue: 27,
    item: {
      name: 'Runed Charm',
      rarity: 'rare',
      slot: 'trinket',
      effects: [{ stat: 'cast_spell', bonus: 4 }],
      description: 'A sigil-inscribed charm that steadies spellcraft.',
    },
  },
}

export function listHubTownShopItemIds(): string[] {
  return Object.keys(HUB_TOWN_SHOP).sort()
}

function hubTownItemIdFromName(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function hubTownItemIdFromInventory(item: LootItem): string {
  const explicit = typeof (item as { hubItemId?: unknown }).hubItemId === 'string'
    ? String((item as { hubItemId?: string }).hubItemId).trim()
    : ''
  if (explicit) return explicit
  return hubTownItemIdFromName(item.name)
}

function copyHubTownShopItem(entry: HubTownShopItem): LootItem {
  const item: LootItem = {
    ...entry.item,
    effects: (entry.item.effects ?? []).map((effect) => ({ ...effect })),
  }
  ;(item as { hubItemId?: string }).hubItemId = entry.id
  return item
}

export function removeLootEffectsFromCharacter(character: Character, item: LootItem): void {
  const effects = Array.isArray(item.effects) ? item.effects : []
  for (const effect of effects) {
    const stat = String(effect.stat ?? '').trim().toLowerCase()
    const bonus = Number.isFinite(effect.bonus) ? Math.floor(effect.bonus) : 0
    if (bonus === 0) continue
    if (stat === 'attack') {
      character.skills.attack = clampSkill(character.skills.attack - bonus)
      continue
    }
    if (stat === 'dodge') {
      character.skills.dodge = clampSkill(character.skills.dodge - bonus)
      continue
    }
    if (stat === 'cast_spell') {
      character.skills.cast_spell = clampSkill(character.skills.cast_spell - bonus)
      continue
    }
    if (stat === 'use_skill') {
      character.skills.use_skill = clampSkill(character.skills.use_skill - bonus)
      continue
    }
    if (stat === 'armor') {
      const baseArmor = Number.isFinite(character.armor) ? Math.floor(character.armor as number) : 0
      character.armor = Math.max(0, baseArmor - bonus)
    }
  }
}

export function fallbackSellValueForItem(item: LootItem): number {
  const byRarity: Record<string, number> = { common: 8, uncommon: 16, rare: 28, legendary: 50 }
  const rarity = String(item.rarity ?? '').toLowerCase()
  const baseline = byRarity[rarity] ?? 10
  const explicit = Number.isFinite(item.gold) ? Math.floor(item.gold as number) : 0
  if (explicit > 0) return Math.max(1, Math.floor(explicit * 0.5))
  return baseline
}

export function buyHubTownItem(actor: Character, itemId: string): HubTownBuyResult {
  ensureCharacterLootState(actor)
  const normalized = String(itemId ?? '').trim().toLowerCase()
  const listing = HUB_TOWN_SHOP[normalized]
  if (!listing) {
    return { ok: false, error: `Unknown itemId. Available: ${listHubTownShopItemIds().join(', ')}` }
  }
  if (actor.gold < listing.cost) {
    return { ok: false, error: `Not enough gold (need ${listing.cost}, have ${actor.gold}).` }
  }

  actor.gold -= listing.cost
  const item = copyHubTownShopItem(listing)
  applyLootToCharacter(actor, { items: [item], gold: 0 })
  return { ok: true, listing, item }
}

export function sellHubTownItem(actor: Character, itemId: string): HubTownSellResult {
  ensureCharacterLootState(actor)
  const normalized = String(itemId ?? '').trim().toLowerCase()
  if (!normalized) return { ok: false, error: 'itemId required for sell_item.' }

  const idx = actor.inventory.findIndex((item) => {
    if (!item) return false
    const invId = hubTownItemIdFromInventory(item)
    return invId === normalized || hubTownItemIdFromName(item.name) === normalized
  })
  if (idx < 0) return { ok: false, error: `No inventory item matches itemId "${normalized}".` }

  const [item] = actor.inventory.splice(idx, 1)
  if (!item) return { ok: false, error: `No inventory item matches itemId "${normalized}".` }

  removeLootEffectsFromCharacter(actor, item)
  const value = HUB_TOWN_SHOP[normalized]?.sellValue ?? fallbackSellValueForItem(item)
  actor.gold += value
  return { ok: true, item, itemId: normalized, value }
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

export const lootSystem: LootSystem = {
  resolveTreasure: (game, actor, dice) => resolveTreasureLoot(game, actor, dice),
  maybeAwardDrop: (game, actor, enemy, dice) => maybeAwardEnemyDrop(game, actor, enemy, dice),
}
