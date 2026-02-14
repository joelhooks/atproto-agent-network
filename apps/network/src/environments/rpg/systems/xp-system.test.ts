import { describe, expect, it } from 'vitest'

import { XP_PER_ROOM_CLEAR, createCharacter, createGame, type RpgGameState } from '../../../games/rpg-engine'
import { addLoggedXp, addXpEarned, awardRoomClearXp } from './xp-system'

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
})
