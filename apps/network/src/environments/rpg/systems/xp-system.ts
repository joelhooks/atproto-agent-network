import type { Character, RpgGameState, Skills } from '../../../games/rpg-engine'
import {
  XP_PER_ADVENTURE_COMPLETE,
  XP_PER_ROOM_CLEAR,
  XP_TABLE,
} from '../../../games/rpg-engine'

export type XpSystemOptions = {
  now?: () => number
  random?: () => number
}

function characterId(character: Character | null | undefined): string {
  if (!character) return 'unknown'
  return character.agent ?? character.name
}

function isCharacter(character: Character, identity: string): boolean {
  return character.agent === identity || character.name === identity
}

export function addXpEarned(game: RpgGameState, who: string, amount: number, options: XpSystemOptions = {}): void {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const agent = String(who ?? '').trim()
  const earned = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  if (!agent || earned <= 0) return

  game.xpEarned ??= {}
  game.xpEarned[agent] = (game.xpEarned[agent] ?? 0) + earned

  const member = Array.isArray(game.party) ? game.party.find((player) => player && isCharacter(player, agent)) : undefined
  if (!member) return

  member.xp = (Number.isFinite(member.xp) ? (member.xp as number) : 0) + earned
  member.level = Number.isFinite(member.level) ? Math.max(1, Math.floor(member.level as number)) : 1

  while (member.level < XP_TABLE.length && (member.xp ?? 0) >= (XP_TABLE[member.level] ?? Number.POSITIVE_INFINITY)) {
    member.level += 1
    const hpGain = 5 + member.level
    const mpGain = 3 + member.level
    member.maxHp = (Number.isFinite(member.maxHp) ? member.maxHp : 0) + hpGain
    member.maxMp = (Number.isFinite(member.maxMp) ? member.maxMp : 0) + mpGain

    const skills: Skills =
      member.skills && typeof member.skills === 'object'
        ? member.skills
        : { attack: 30, dodge: 25, cast_spell: 25, use_skill: 25 }
    const keys = Object.keys(skills).sort()
    let boostedSkill = ''
    if (keys.length > 0) {
      const index = Math.min(keys.length - 1, Math.floor(random() * keys.length))
      const key = keys[index]!
      const current = Number((skills as Record<string, unknown>)[key])
      ;(skills as Record<string, unknown>)[key] = (Number.isFinite(current) ? current : 0) + 5
      boostedSkill = key
    }

    member.skills = skills
    game.log ??= []
    game.log.push({
      at: now(),
      who: agent,
      what: `LEVEL UP: ${member.name} reaches Level ${member.level}! (+${hpGain} HP, +${mpGain} MP)${boostedSkill ? ` (+5 ${boostedSkill})` : ''}`,
    })
  }
}

export function addLoggedXp(
  game: RpgGameState,
  who: string,
  amount: number,
  reason: string,
  options: XpSystemOptions = {}
): void {
  const now = options.now ?? Date.now
  const identity = String(who ?? '').trim()
  const earned = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  if (!identity || earned <= 0) return
  addXpEarned(game, identity, earned, options)
  game.log ??= []
  game.log.push({
    at: now(),
    who: identity,
    what: `gained ${earned} XP (${reason})`,
  })
}

function livingPartyIds(game: RpgGameState): string[] {
  const party = Array.isArray(game.party) ? game.party : []
  return party.filter((member) => (member?.hp ?? 0) > 0).map((member) => characterId(member))
}

export function awardRoomClearXp(game: RpgGameState, options: XpSystemOptions = {}): void {
  for (const id of livingPartyIds(game)) addXpEarned(game, id, XP_PER_ROOM_CLEAR, options)
}

export function awardAdventureCompleteXp(game: RpgGameState, options: XpSystemOptions = {}): void {
  for (const id of livingPartyIds(game)) addXpEarned(game, id, XP_PER_ADVENTURE_COMPLETE, options)
}
