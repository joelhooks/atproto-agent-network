import { describe, expect, it } from 'vitest'

import {
  XP_PER_BARRIER_BRUTE_FORCE,
  XP_PER_BARRIER_CLEAR,
  XP_PER_BOSS_KILL,
  XP_PER_ENEMY_KILL,
  XP_PER_ROOM_CLEAR,
  createCharacter,
  createGame,
  type Enemy,
  type RpgGameState,
} from '../../../games/rpg-engine'
import {
  addLoggedXp,
  addXpEarned,
  awardBarrierClearMilestoneXp,
  awardKillXp,
  awardRoomClearXp,
  calculateEncounterXp,
} from './xp-system'

function makeGame(): RpgGameState {
  const alice = createCharacter({ name: 'Alice', agent: 'alice', klass: 'Warrior' })
  const bob = createCharacter({ name: 'Bob', agent: 'bob', klass: 'Scout' })
  return createGame({
    id: 'xp-system',
    players: [alice, bob],
    dungeon: [{ type: 'rest', description: 'camp' }],
  })
}

describe('xp-system', () => {
  it('addXpEarned tracks earned XP and levels up party members', () => {
    const game = makeGame()
    const alice = game.party.find((member) => member.agent === 'alice')!
    alice.xp = 95
    const hpBefore = alice.maxHp
    const mpBefore = alice.maxMp
    const attackBefore = alice.skills.attack

    addXpEarned(game, 'alice', 10, { now: () => 42, random: () => 0 })

    expect(game.xpEarned).toEqual({ alice: 10 })
    expect(alice.level).toBe(2)
    expect(alice.maxHp).toBe(hpBefore + 7)
    expect(alice.maxMp).toBe(mpBefore + 5)
    expect(alice.skills.attack).toBe(attackBefore + 5)
    expect(game.log.some((entry) => entry.what.includes('LEVEL UP: Alice reaches Level 2'))).toBe(true)
  })

  it('addLoggedXp appends an audit log entry', () => {
    const game = makeGame()

    addLoggedXp(game, 'alice', 15, 'quest objective', { now: () => 84, random: () => 0.5 })

    expect(game.xpEarned).toEqual({ alice: 15 })
    expect(game.log.at(-1)?.what).toBe('gained 15 XP (quest objective)')
  })

  it('awardRoomClearXp awards only living party members', () => {
    const game = makeGame()
    const bob = game.party.find((member) => member.agent === 'bob')!
    bob.hp = 0

    awardRoomClearXp(game, { now: () => 100, random: () => 0.2 })

    expect(game.xpEarned?.alice).toBe(XP_PER_ROOM_CLEAR)
    expect(game.xpEarned?.bob).toBeUndefined()
  })

  it('awardKillXp grants base + boss bonus and appends kill log entries', () => {
    const game = makeGame()
    const boss: Enemy = {
      name: 'Hydra',
      hp: 0,
      maxHp: 40,
      DEX: 30,
      attack: 40,
      dodge: 20,
      tactics: { kind: 'boss' },
    }

    awardKillXp(game, 'alice', boss, { now: () => 10, random: () => 0.5 })

    expect(game.xpEarned?.alice).toBe(XP_PER_ENEMY_KILL + XP_PER_BOSS_KILL)
    expect(game.log.some((entry) => entry.what.includes(`gained ${XP_PER_ENEMY_KILL} XP (kill: Hydra)`))).toBe(true)
    expect(game.log.some((entry) => entry.what.includes(`gained ${XP_PER_BOSS_KILL} XP (boss kill)`))).toBe(true)
  })

  it('calculateEncounterXp matches encounter composition', () => {
    const enemies: Enemy[] = [
      { name: 'Goblin', hp: 10, maxHp: 10, DEX: 20, attack: 20, dodge: 20, tactics: { kind: 'goblin' } },
      { name: 'Wyrm', hp: 30, maxHp: 30, DEX: 25, attack: 35, dodge: 25, tactics: { kind: 'boss' } },
    ]

    expect(calculateEncounterXp(enemies)).toBe(XP_PER_ENEMY_KILL * 2 + XP_PER_BOSS_KILL)
  })

  it('awardBarrierClearMilestoneXp routes rewards by log cues', () => {
    const game = makeGame()

    awardBarrierClearMilestoneXp(game, {
      logSlice: [{ who: 'alice', what: 'barrier: brute_force' }],
      fallbackActorId: 'bob',
    })
    expect(game.xpEarned?.alice).toBe(XP_PER_BARRIER_BRUTE_FORCE)

    awardBarrierClearMilestoneXp(game, {
      logSlice: [{ who: 'GM', what: 'barrier: resolved by Scout' }],
      fallbackActorId: 'alice',
    })
    expect(game.xpEarned?.bob).toBe(XP_PER_BARRIER_CLEAR)
  })
})
