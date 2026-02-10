import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createCharacter, createGame, findCharacter } from '../games/rpg-engine'
import { rpgEnvironment } from './rpg'
import { DM_SKILL_BRIEF, WARRIOR_SKILL_BRIEF } from './rpg-skills'

describe('rpgEnvironment', () => {
  it('skips dead players in turn order (hp <= 0) and never assigns them as currentPlayer', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_skip_dead_turn'
    const game = createGame({
      id: gameId,
      players: ['swoop', 'alice'],
      dungeon: [{ type: 'rest', description: 'safe' }, { type: 'rest', description: 'after' }],
    })

    // Simulate a production-softlock state: the current player is dead.
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'swoop'
    findCharacter(game, 'swoop')!.hp = 0

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['swoop', 'alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-explore', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    expect(updated.currentPlayer).toBe('alice')
    expect(updated.turnOrder.map((p: any) => p.agent ?? p.name)).not.toContain('swoop')
    expect(updated.party.find((p: any) => (p.agent ?? p.name) === 'swoop').hp).toBe(0)
    expect(updated.log.some((e: any) => String(e.what).includes('is dead, skipping turn'))).toBe(true)
  })

  it('when a player dies mid-combat, the turn immediately advances to the next living player and persists', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'swoop',
      agentDid: 'did:cf:swoop',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_die_mid_combat_advances'
    const game = createGame({
      id: gameId,
      players: ['swoop', 'alice'],
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
    game.currentPlayer = 'swoop'

    const swoop = findCharacter(game, 'swoop')!
    swoop.hp = 1
    swoop.skills.attack = 1 // ensure player misses with roll 100
    swoop.skills.dodge = 1 // ensure counter hits with roll 100

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'swoop', JSON.stringify(game), game.phase, JSON.stringify(['swoop', 'alice']))
      .run()

    const randoms = [
      0.99999, // player attack roll 100 (miss)
      0.0, // enemy dodge roll 1 (unused due to miss, but still consumed)
      0.0, // enemy attack roll 1 (hit)
      0.99999, // player dodge roll 100 (fail)
      0.99999, // damage d6 -> 6 (kills swoop at 1 HP, scaled up for partySize=2)
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

    expect(updated.party.find((p: any) => (p.agent ?? p.name) === 'swoop').hp).toBe(0)
    expect(updated.currentPlayer).toBe('alice')
    expect(updated.turnOrder.map((p: any) => p.agent ?? p.name)).toEqual(['alice'])
    expect(updated.log.some((e: any) => String(e.what).includes('is dead, skipping turn'))).toBe(true)
  })

  it('TPK ends the game (all players hp <= 0)', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_tpk_ends_game'
    const game = createGame({
      id: gameId,
      players: ['alice', 'bob'],
      dungeon: [{ type: 'combat', description: 'oops', enemies: [{ name: 'Goblin', hp: 1, DEX: 40, attack: 1, dodge: 1 }] }],
    })

    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'alice'
    findCharacter(game, 'alice')!.hp = 0
    findCharacter(game, 'bob')!.hp = 0

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-status', { command: 'status', gameId })

    const row = await db.prepare('SELECT state, phase FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    expect(row.phase).toBe('finished')
    expect(updated.phase).toBe('finished')
    expect(updated.mode).toBe('finished')
  })

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

      const alice = findCharacter(game, 'alice')!
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
      return updated.party.find((p: any) => (p.agent ?? p.name) === 'alice').hp
    }

    const soloHp = await runOnce(['alice'])
    const trioHp = await runOnce(['alice', 'bob', 'carl'])

    expect(soloHp).toBe(8) // 12 - (2 * soloMultiplier(1)=2.0) => 12-4
    expect(trioHp).toBe(10) // 12 - (2 * soloMultiplier(3)=1.0) => 12-2
  })

  it('stuck detection: same action 5x triggers GM intervention, resolves obstacle, and advances', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_stuck_detection'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'A goblin blocks the path.',
          enemies: [{ name: 'Goblin', hp: 20, DEX: 40, attack: 100, dodge: 1 }],
        },
        { type: 'rest', description: 'A quiet alcove.' },
      ],
    })

    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'alice'

    const alice = findCharacter(game, 'alice')!
    alice.hp = alice.maxHp
    alice.skills.attack = 1 // ensure player misses with roll 100
    alice.skills.dodge = 1 // ensure counter hits with roll 100

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    // Each combat attack consumes 5 Math.random() values in rpg.ts combat resolution.
    // Repeat a deterministic miss + counter-hit pattern 5 times.
    const pattern = [
      0.99999, // player attack roll 100 (miss)
      0.0, // enemy dodge roll 1 (unused due to miss, but still consumed)
      0.0, // enemy attack roll 1 (hit)
      0.99999, // player dodge roll 100 (fail)
      0.0, // damage d6 -> 1 (scaled to 2 for solo), ensures survival across 5 turns
    ]
    const randoms = Array.from({ length: 5 }, () => pattern).flat()
    let i = 0
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++] ?? 0.0)
    try {
      const tool = rpgEnvironment.getTool(ctx as any)
      for (let n = 0; n < 5; n += 1) {
        await tool.execute(`toolcall-attack-${n}`, { command: 'attack', gameId })
      }
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    // GM should have advanced the party one room.
    expect(updated.roomIndex).toBe(1)
    expect(updated.mode).toBe('exploring')
    expect(updated.combat).toBeUndefined()

    // GM should log a warning + narrative line.
    expect(updated.log.some((e: any) => String(e.what).includes('stuck'))).toBe(true)
    expect(updated.log.some((e: any) => String(e.what).includes('The dungeon shifts around you'))).toBe(true)

    // Action history should be stored per-player and reflect 5 identical actions.
    expect(updated.actionHistory?.alice).toHaveLength(5)
    expect(updated.actionHistory?.alice?.every((a: any) => a.action === 'attack')).toBe(true)
    expect(updated.actionHistory?.alice?.every((a: any) => a.target === 'enemy:Goblin')).toBe(true)
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

    expect(updated.party.some((p: any) => p.agent === 'bob' && p.klass === 'Mage')).toBe(true)
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

  it('non-grimlock agent calling new_game gets rejected with helpful message', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'bob',
      agentDid: 'did:cf:bob',
      db: db as any,
      broadcast,
    }

    // Create a joinable game so the error lists it
    const gameId = 'rpg_test_grimlock_guard'
    const game = createGame({ id: gameId, players: ['alice'] })
    game.phase = 'playing'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-new', { command: 'new_game', players: ['bob'] })

    expect(result).toMatchObject({ ok: false })
    const error = String((result as any).error)
    expect(error).toContain('Only Grimlock can create new dungeons')
    expect(error).toContain('join_game')
    expect(error).toContain(gameId)
  })

  it('grimlock calling new_game succeeds', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
    }

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-new', { command: 'new_game', players: ['slag', 'snarl', 'swoop'] })

    expect(result).toHaveProperty('content')
    expect(result).toHaveProperty('details')
    // Grimlock is DM, never a player — players should be the actual agents
    expect((result as any).details.players).toContain('slag')
    expect((result as any).details.players).not.toContain('grimlock')
    expect((result as any).details.phase).toBe('playing')
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

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'game.completed',
          gameId,
          type: 'rpg',
        })
      )

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

  it('grimlock auto-creates a new dungeon when there are no playing games', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
    }

    const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)
    expect(calls).toEqual([{ name: 'rpg', arguments: { command: 'new_game', players: ['slag', 'snarl', 'swoop'] } }])
  })

  it('grimlock does not auto-create a dungeon if any playing game exists', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_someone_else_playing'
    const game = createGame({ id: gameId, players: ['alice'] })
    game.phase = 'playing'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)
    expect(calls).toEqual([])
  })

  it('grimlock respects maxGamesPerDay when auto-creating dungeons', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      maxGamesPerDay: 2,
    }

    for (let i = 0; i < 2; i++) {
      const gameId = `rpg_test_finished_${i}`
      const game = createGame({ id: gameId, players: ['grimlock'] })
      game.phase = 'finished'
      await db
        .prepare(
          "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
        )
        .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock']))
        .run()
    }

    const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)
    expect(calls).toEqual([])
  })

  it('room descriptions reference prior party actions (narrativeContext) after room 3+, and boss calls back to the journey', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_dynamic_narrative'
    const alice = createCharacter({ name: 'alice', klass: 'Warrior' })
    const game = createGame({
      id: gameId,
      players: [alice],
      dungeon: [
        { type: 'rest', description: 'A cold stone antechamber.' },
        { type: 'treasure', description: 'A toppled shrine with offerings scattered in dust.' },
        { type: 'barrier', requiredClass: 'Mage', description: 'A sealed archway bars the way. Only a Mage can open it.' },
        { type: 'rest', description: 'A narrow ledge above a black drop.' },
        { type: 'puzzle', description: 'A wall of runes waits for an answer.' },
        { type: 'boss', description: 'A final chamber yawns open.', enemies: [{ name: 'Dungeon Boss', hp: 30, DEX: 55, attack: 55, dodge: 35 }] },
      ],
    })

    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)

    // Room 2: treasure (no callback required yet)
    await tool.execute('toolcall-explore-1', { command: 'explore', gameId })

    // Room 3+: barrier should reference the treasure/item found earlier.
    const barrier = await tool.execute('toolcall-explore-2', { command: 'explore', gameId })
    const barrierText = String((barrier as any)?.content?.[0]?.text ?? '')
    expect(barrierText).toContain('You enter: barrier')
    expect(barrierText).toContain('soot-black opal')

    // Advance to the boss room. Boss description should callback to at least 2 earlier beats.
    await tool.execute('toolcall-explore-3', { command: 'explore', gameId })
    await tool.execute('toolcall-explore-4', { command: 'explore', gameId })
    const boss = await tool.execute('toolcall-explore-5', { command: 'explore', gameId })
    const bossText = String((boss as any)?.content?.[0]?.text ?? '')

    expect(bossText).toContain('You enter: boss')
    expect(bossText).toContain('soot-black opal')
    expect(bossText).toContain('bruised shoulder')
  })

  // ---------------------------------------------------------------------------
  // buildContext skill injection tests
  // ---------------------------------------------------------------------------

  async function setupBuildContextGame(db: any, agentName: string, currentPlayer: string, klass: string) {
    const gameId = `rpg_test_skills_${agentName}_${currentPlayer}`
    const char = createCharacter({ name: agentName, klass: klass as any })
    const game = createGame({
      id: gameId,
      players: [char],
      dungeon: [{ type: 'rest', description: 'A quiet room.' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = currentPlayer

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', agentName, JSON.stringify(game), game.phase, JSON.stringify([agentName]))
      .run()

    return gameId
  }

  it("buildContext injects DM skill for grimlock on grimlock's turn", async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    await setupBuildContextGame(db, 'grimlock', 'grimlock', 'Warrior')

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    // Full DM skill should be present (check distinctive phrase)
    expect(text).toContain('Monster Selection')
    expect(text).toContain('Goblins (CR 1/4)')
    // Brief should NOT be the only thing
    expect(text).not.toContain(DM_SKILL_BRIEF)
  })

  it("buildContext injects DM brief for grimlock when it's NOT grimlock's turn", async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    await setupBuildContextGame(db, 'grimlock', 'someone_else', 'Warrior')

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain('Observe the party')
    // Full skill should NOT be present
    expect(text).not.toContain('Goblins (CR 1/4)')
  })

  it("buildContext injects warrior skill on warrior's turn", async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    await setupBuildContextGame(db, 'slag', 'slag', 'Warrior')

    const ctx = { agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast }
    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain('YOUR ROLE — WARRIOR')
    expect(text).toContain('Taunt/Grapple')
    // Party tactics should also be included
    expect(text).toContain('Party Coordination & Action Economy')
  })

  it('buildContext injects warrior brief when NOT the warrior\'s turn', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    await setupBuildContextGame(db, 'slag', 'someone_else', 'Warrior')

    const ctx = { agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast }
    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain(WARRIOR_SKILL_BRIEF)
    // Full skill should NOT be present
    expect(text).not.toContain('Taunt/Grapple')
    // Party tactics should NOT be present when waiting
    expect(text).not.toContain('Party Coordination & Action Economy')
  })

  it('join_game uses persistent character when loadCharacter returns one', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const persistentChar = {
      name: 'Thorin',
      klass: 'Warrior',
      level: 3,
      xp: 500,
      maxHp: 25,
      maxMp: 3,
      skills: { attack: 70, dodge: 40, cast_spell: 10, use_skill: 50 },
      adventureLog: ['Slew a dragon'],
      achievements: [],
      inventory: ['Axe'],
      createdAt: 1000,
      updatedAt: 2000,
      gamesPlayed: 5,
      deaths: 1,
    }

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter: vi.fn().mockResolvedValue(persistentChar),
      saveCharacter: vi.fn(),
    }

    // Create a game for alice to join
    const game = createGame({
      id: 'rpg_persist_test',
      players: ['grimlock'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'

    await db.prepare(
      "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).bind('rpg_persist_test', 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock'])).run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute!('call-1', { command: 'join_game', gameId: 'rpg_persist_test', klass: 'Warrior' })

    expect(ctx.loadCharacter).toHaveBeenCalled()

    // Verify the joined character has persistent stats
    const updatedRow = await db.prepare("SELECT state FROM games WHERE id = 'rpg_persist_test'").first<{ state: string }>()
    const updatedGame = JSON.parse(updatedRow!.state)
    const alice = updatedGame.party.find((p: any) => p.agent === 'alice')
    expect(alice).toBeDefined()
    expect(alice.maxHp).toBe(25)
    expect(alice.hp).toBe(25)
    expect(alice.skills.attack).toBe(70)
  })
})
