import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createGame } from '../games/rpg-engine'
import { rpgEnvironment } from './rpg'

describe('rpgEnvironment', () => {
  it('combat: enemies counter-attack, scaling damage up for solo parties', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    async function runOnce(party: string[]): Promise<number> {
      const gameId = `rpg_test_counter_${party.length}`
      const game = createGame({
        id: gameId,
        players: party,
        dungeon: [
          {
            type: 'combat',
            description: 'Goblins!',
            enemies: [{ name: 'Goblin', hp: 20, DEX: 40, attack: 100, dodge: 1 }],
          },
          { type: 'rest', description: 'after' },
        ],
      })
      game.phase = 'playing'
      game.mode = 'combat'
      game.currentPlayer = 'alice'

      const alice = game.party.find((p) => p.name === 'alice')!
      alice.hp = 12
      alice.skills.attack = 1 // ensure player misses with roll 100
      alice.skills.dodge = 1 // ensure counter hits with roll 100

      await db
        .prepare(
          "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
        )
        .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(party))
        .run()

      const randoms = [
        0.99999, // player attack roll 100 (miss)
        0.0, // enemy dodge roll 1 (unused due to miss, but still consumed)
        0.0, // enemy attack roll 1 (hit)
        0.99999, // player dodge roll 100 (fail)
        0.2, // damage d6 -> 2
      ]
      let i = 0
      const spy = vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++] ?? 0.0)
      try {
        const tool = rpgEnvironment.getTool(ctx as any)
        await tool.execute('toolcall-attack', { command: 'attack', gameId })
      } finally {
        spy.mockRestore()
      }

      const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
      const updated = JSON.parse(row.state)
      return updated.party.find((p: any) => p.name === 'alice').hp
    }

    const soloHp = await runOnce(['alice'])
    const trioHp = await runOnce(['alice', 'bob', 'carl'])

    expect(soloHp).toBe(8) // 12 - (2 * soloMultiplier(1)=2.0) => 12-4
    expect(trioHp).toBe(10) // 12 - (2 * soloMultiplier(3)=1.0) => 12-2
  })

  it('join_game adds the agent to the party with the chosen class', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'bob',
      agentDid: 'did:cf:bob',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_join_game'
    const game = createGame({ id: gameId, players: ['alice'] })
    game.phase = 'playing'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-join', { command: 'join_game', gameId, klass: 'Mage' })

    const row = await db.prepare('SELECT state, players FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    expect(updated.party.map((p: any) => [p.name, p.klass])).toContainEqual(['bob', 'Mage'])
    expect(JSON.parse(row.players)).toContain('bob')
  })

  it('new_game suggests joining an open adventure (<3 players) instead of creating a solo one', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'bob',
      agentDid: 'did:cf:bob',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_join_suggestion'
    const game = createGame({ id: gameId, players: ['alice'] })
    game.phase = 'playing'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-new-game', { command: 'new_game', players: ['bob'] })

    expect(result).toMatchObject({ ok: false })
    expect(String((result as any).error)).toContain('join_game')
    expect(String((result as any).error)).toContain(gameId)
  })

  it("logs a structured game.completed event when the adventure finishes (phase becomes 'finished')", async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_game_completed'
    const game = createGame({ id: gameId, players: ['alice'] })

    // Force immediate completion: explore() finishes if roomIndex is already at last room.
    game.phase = 'playing'
    game.roomIndex = Math.max(0, game.dungeon.length - 1)
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const tool = rpgEnvironment.getTool(ctx as any)
      await tool.execute('toolcall-1', { command: 'explore', gameId })

      const completedLine = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event_type":"game.completed"'))

      expect(completedLine).toBeTruthy()
      expect(JSON.parse(completedLine!)).toMatchObject({
        event_type: 'game.completed',
        type: 'rpg',
        gameId,
      })
    } finally {
      logSpy.mockRestore()
    }
  })
})
