import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createCharacter, createGame, findCharacter } from '../games/rpg-engine'
import { compactAdventureLog, rpgEnvironment } from './rpg'
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

    // All living enemies counter-attack random party members. Min damage 1 per hit.
    expect(soloHp).toBeLessThan(12) // took at least 1 damage
    expect(trioHp).toBeLessThan(12) // took at least 1 damage
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
    expect((result as any).details.phase).toBe('setup')
  })

  it('new_game starts in setup phase with backstory interview', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
    }

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-new', { command: 'new_game', players: ['slag', 'snarl'] })
    const gameId = String((result as any)?.details?.gameId ?? '')
    expect(gameId).toContain('rpg_')

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    // Setup phase enabled — game starts in setup with backstory interview
    expect(updated.setupPhase).toBeDefined()
    expect(updated.phase).toBe('setup')
  })

  it('setup_narrate is DM-only, appends dialogue for the current player, and hands the turn to the player', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_setup_narrate'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    ;(game as any).setupPhase = {
      currentPlayerIndex: 0,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: {},
      complete: false,
    }
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'grimlock'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const nonDmTool = rpgEnvironment.getTool({ agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast } as any)
    const rejected = await nonDmTool.execute('toolcall-setup-narrate', { command: 'setup_narrate', gameId, message: 'yo' })
    expect(rejected).toMatchObject({ ok: false })
    expect(String((rejected as any).error)).toContain('Only Grimlock')

    const dmTool = rpgEnvironment.getTool({ agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast } as any)
    await dmTool.execute('toolcall-setup-narrate', { command: 'setup_narrate', gameId, message: 'Tell me about your origin.' })

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    expect(updated.setupPhase.dialogues.slag).toEqual([expect.stringContaining('Tell me about your origin')])
    expect(updated.currentPlayer).toBe('slag')
  })

  it('setup_respond appends the player response, increments exchangeCount, and advances to the next player at maxExchanges', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_setup_respond'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    ;(game as any).setupPhase = {
      currentPlayerIndex: 0,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: {},
      complete: false,
    }
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'slag'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const slagTool = rpgEnvironment.getTool({ agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast } as any)
    await slagTool.execute('toolcall-setup-respond-1', { command: 'setup_respond', gameId, message: 'I was born under a broken moon.' })

    {
      const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
      const updated = JSON.parse(row.state)
      expect(updated.setupPhase.exchangeCount).toBe(1)
      expect(updated.setupPhase.currentPlayerIndex).toBe(0)
      expect(updated.setupPhase.dialogues.slag).toEqual([expect.stringContaining('broken moon')])
      expect(updated.currentPlayer).toBe('grimlock')
    }

    const dmTool = rpgEnvironment.getTool({ agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast } as any)
    await dmTool.execute('toolcall-setup-narrate-2', { command: 'setup_narrate', gameId, message: 'And what drives you onward?' })

    await slagTool.execute('toolcall-setup-respond-2', { command: 'setup_respond', gameId, message: 'Vengeance, and a promise I cannot break.' })

    {
      const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
      const updated = JSON.parse(row.state)
      expect(updated.setupPhase.exchangeCount).toBe(0)
      expect(updated.setupPhase.currentPlayerIndex).toBe(1)
      expect(updated.currentPlayer).toBe('grimlock')
    }
  })

  it('setup_finalize writes backstories to the party, removes setupPhase, and returns the game to active exploration at room 0', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_setup_finalize'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }, { type: 'rest', description: 'after' }],
    })
    ;(game as any).setupPhase = {
      currentPlayerIndex: 1,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: {},
      complete: true,
    }
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'grimlock'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const dmTool = rpgEnvironment.getTool({ agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast } as any)
    await dmTool.execute('toolcall-setup-finalize', {
      command: 'setup_finalize',
      gameId,
      backstories: {
        slag: 'A blacksmith turned oathbreaker.',
        snarl: 'A scout who fled the glass woods.',
      },
    })

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    expect(updated.setupPhase).toBeUndefined()
    expect(updated.roomIndex).toBe(0)
    expect(updated.mode).toBe('exploring')
    expect(updated.currentPlayer).not.toBe('grimlock')
    expect(updated.party.find((p: any) => (p.agent ?? p.name) === 'slag').backstory).toContain('blacksmith')
    expect(updated.party.find((p: any) => (p.agent ?? p.name) === 'snarl').backstory).toContain('glass woods')
  })

  it('buildContext shows setup-phase prompts for DM, current player, and waiting players', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_setup_build_context'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    ;(game as any).setupPhase = {
      currentPlayerIndex: 0,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: {},
      complete: false,
    }
    game.phase = 'playing'
    game.mode = 'exploring'

    // DM prompt context comes from "it's my turn" lookup (grimlock is not in players).
    game.currentPlayer = 'grimlock'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const dmLines = await rpgEnvironment.buildContext({ agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast } as any)
    expect(dmLines.join('\n')).toContain('SETUP PHASE')
    expect(dmLines.join('\n')).toContain('slag')

    // Current player prompt
    game.currentPlayer = 'slag'
    await db
      .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
      .run()

    const slagLines = await rpgEnvironment.buildContext({ agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast } as any)
    expect(slagLines.join('\n')).toContain('backstory')
    expect(slagLines.join('\n')).toContain('setup_respond')

    const snarlLines = await rpgEnvironment.buildContext({ agentName: 'snarl', agentDid: 'did:cf:snarl', db: db as any, broadcast } as any)
    expect(snarlLines.join('\n')).toContain('Waiting')
    expect(snarlLines.join('\n')).toContain('slag')
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

  it('setup phase autoplay: grimlock asks an opening backstory question when no dialogue exists yet', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_setup_autoplay_dm'
    const game = createGame({ id: gameId, players: ['slag', 'snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })
    ;(game as any).setupPhase = {
      currentPlayerIndex: 0,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: {},
      complete: false,
    }
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'grimlock'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)

    expect(calls).toEqual([
      expect.objectContaining({
        name: 'rpg',
        arguments: expect.objectContaining({
          command: 'setup_narrate',
          gameId,
          target: 'slag',
        }),
      }),
    ])
  })

  it('setup phase autoplay: current player responds with setup_respond when it is their setup turn', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_setup_autoplay_player'
    const game = createGame({ id: gameId, players: ['slag', 'snarl'], dungeon: [{ type: 'rest', description: 'safe' }] })
    ;(game as any).setupPhase = {
      currentPlayerIndex: 0,
      exchangeCount: 0,
      maxExchanges: 2,
      dialogues: { slag: ['Tell me about your character.'] },
      complete: false,
    }
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'slag'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const ctx = { agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast }
    const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)

    expect(calls).toEqual([
      expect.objectContaining({
        name: 'rpg',
        arguments: expect.objectContaining({
          command: 'setup_respond',
          gameId,
          message: expect.any(String),
        }),
      }),
    ])
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
  // XP rewards
  // ---------------------------------------------------------------------------

  it('awards encounter and completion XP into game state (xpEarned) across the adventure', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_xp_rewards'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'combat', description: 'combat', enemies: [{ name: 'Goblin', hp: 1, DEX: 10, attack: 0, dodge: 0 }] },
        { type: 'boss', description: 'boss', enemies: [{ name: 'Dungeon Boss', hp: 1, DEX: 10, attack: 0, dodge: 0, tactics: { kind: 'boss' } }] },
        { type: 'rest', description: 'rest' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'
    // Ensure the attacker always succeeds the skill check.
    game.party[0]!.skills.attack = 100

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    // Kill the first enemy (+25).
    await tool.execute('toolcall-1', { command: 'attack', gameId })
    // Clear the combat room by advancing (+50) into the boss room.
    await tool.execute('toolcall-2', { command: 'explore', gameId })
    // Kill the boss enemy (+25) and get boss bonus (+100).
    await tool.execute('toolcall-3', { command: 'attack', gameId })
    // Clear the boss room by advancing (+50) into the last room.
    await tool.execute('toolcall-4', { command: 'explore', gameId })
    // Finish the adventure (+200).
    await tool.execute('toolcall-5', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.phase).toBe('finished')
    expect(updated.xpEarned).toEqual({ alice: 450 })
  })

  // ---------------------------------------------------------------------------
  // Non-combat encounter resolution
  // ---------------------------------------------------------------------------

  it('negotiate succeeds only when all remaining enemies are negotiable, ends combat, and awards 50% encounter XP', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_negotiate_success'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'combat',
          enemies: [
            { name: 'Goblin', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, negotiable: true, morale: 6 },
            { name: 'Goblin 2', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, negotiable: true, morale: 6 },
          ],
        },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.0) // d100 => 1 (success)
    try {
      await tool.execute('toolcall-negotiate', { command: 'negotiate', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)

    expect(updated.mode).toBe('exploring')
    expect(updated.combat).toBeUndefined()
    // 2 enemies * floor(25 * 0.5) = 24
    expect(updated.xpEarned).toEqual({ alice: 24 })
  })

  it('negotiate fails on undead/constructs even if marked negotiable', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_negotiate_undead_rejected'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'combat',
          enemies: [{ name: 'Skeleton', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, negotiable: true, morale: 12, tactics: { kind: 'skeleton' } }],
        },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const res = await tool.execute('toolcall-negotiate', { command: 'negotiate', gameId })
    expect((res as any).ok).toBe(false)
    expect(String((res as any).error ?? '')).toContain('negotiate')

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.mode).toBe('combat')
    expect(updated.combat?.enemies?.length).toBe(1)
  })

  it('negotiate failure triggers a free enemy attack round', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_negotiate_failure_free_attacks'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'combat',
          enemies: [{ name: 'Goblin', hp: 10, maxHp: 10, DEX: 10, attack: 100, dodge: 0, negotiable: true, morale: 6 }],
        },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'
    findCharacter(game, 'alice')!.skills.dodge = 1

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const aliceBefore = findCharacter(game, 'alice')!.hp
    // negotiate roll (100 fail), then enemy attacks (target selection, atk roll, dodge roll, damage)
    const randoms = [0.99999, 0.0, 0.0, 0.99999, 0.0]
    let i = 0
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++] ?? 0.0)
    try {
      await tool.execute('toolcall-negotiate', { command: 'negotiate', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const aliceAfter = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice').hp

    expect(updated.mode).toBe('combat')
    expect(aliceAfter).toBeLessThan(aliceBefore)
  })

  it('flee succeeds: party escapes with no HP loss, 0 XP, and room remains unresolved', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_flee_success'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'combat', description: 'combat', enemies: [{ name: 'Orc', hp: 10, maxHp: 10, DEX: 10, attack: 100, dodge: 0 }] }],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const hpBefore = findCharacter(game, 'alice')!.hp
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.0) // d100 => 1 (success)
    try {
      await tool.execute('toolcall-flee', { command: 'flee', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const hpAfter = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice').hp

    expect(updated.mode).toBe('exploring')
    expect(updated.combat).toBeUndefined()
    expect(hpAfter).toBe(hpBefore)
    expect(updated.xpEarned ?? {}).toEqual({})
    // The dungeon room still has enemies; we didn't resolve it.
    expect(updated.dungeon[0].enemies[0].hp).toBe(10)
  })

  it('flee fails: enemies get a free attack round, then party escapes', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_flee_failure'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'combat', description: 'combat', enemies: [{ name: 'Orc', hp: 10, maxHp: 10, DEX: 10, attack: 100, dodge: 0 }] }],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'
    findCharacter(game, 'alice')!.skills.dodge = 1

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const hpBefore = findCharacter(game, 'alice')!.hp
    // flee roll (100 fail), then enemy attacks (target selection, atk roll, dodge roll, damage)
    const randoms = [0.99999, 0.0, 0.0, 0.99999, 0.0]
    let i = 0
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++] ?? 0.0)
    try {
      await tool.execute('toolcall-flee', { command: 'flee', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const hpAfter = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice').hp

    expect(updated.mode).toBe('exploring')
    expect(updated.combat).toBeUndefined()
    expect(hpAfter).toBeLessThan(hpBefore)
    expect(updated.xpEarned ?? {}).toEqual({})
  })

  it('flee cannot be used in boss rooms', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_flee_boss_rejected'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'boss', description: 'boss', enemies: [{ name: 'Dungeon Boss', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, tactics: { kind: 'boss' } }] }],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const res = await tool.execute('toolcall-flee', { command: 'flee', gameId })
    expect((res as any).ok).toBe(false)
    expect(String((res as any).error ?? '')).toContain('boss')
  })

  it('sneak succeeds: bypasses the next combat room entirely (0 XP, no damage)', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_sneak_success'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'rest' },
        { type: 'combat', description: 'combat', enemies: [{ name: 'Goblin', hp: 10, maxHp: 10, DEX: 10, attack: 100, dodge: 0 }] },
        { type: 'rest', description: 'after' },
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

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const hpBefore = findCharacter(game, 'alice')!.hp
    // roll 40 (<= warrior DEX 50)
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.39)
    try {
      await tool.execute('toolcall-sneak', { command: 'sneak', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const hpAfter = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice').hp

    expect(updated.roomIndex).toBe(2)
    expect(updated.mode).toBe('exploring')
    expect(updated.combat).toBeUndefined()
    expect(hpAfter).toBe(hpBefore)
    expect(updated.xpEarned ?? {}).toEqual({})
  })

  it('sneak failure: combat starts and enemies get a surprise round (free attacks)', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_sneak_failure_surprise_round'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'rest' },
        { type: 'combat', description: 'combat', enemies: [{ name: 'Goblin', hp: 10, maxHp: 10, DEX: 10, attack: 100, dodge: 0 }] },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    findCharacter(game, 'alice')!.skills.dodge = 1

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const hpBefore = findCharacter(game, 'alice')!.hp
    // sneak roll 90 (fail vs DEX 50), then enemy attacks (target selection, atk roll, dodge roll, damage)
    const randoms = [0.89, 0.0, 0.0, 0.99999, 0.0]
    let i = 0
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++] ?? 0.0)
    try {
      await tool.execute('toolcall-sneak', { command: 'sneak', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const hpAfter = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice').hp

    expect(updated.roomIndex).toBe(1)
    expect(updated.mode).toBe('combat')
    expect(updated.combat?.enemies?.length).toBe(1)
    expect(hpAfter).toBeLessThan(hpBefore)
  })

  it('sneak gives Scout a +20 bonus to bypass checks', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_sneak_scout_bonus'
    const scout = createCharacter({ name: 'alice', klass: 'Scout' })
    const game = createGame({
      id: gameId,
      players: [scout],
      dungeon: [
        { type: 'rest', description: 'rest' },
        { type: 'combat', description: 'combat', enemies: [{ name: 'Goblin', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0 }] },
        { type: 'rest', description: 'after' },
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

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    // roll 90 (would fail for DEX 75 without bonus, but succeeds with +20 => 95)
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.89)
    try {
      await tool.execute('toolcall-sneak', { command: 'sneak', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)

    expect(updated.roomIndex).toBe(2)
    expect(updated.mode).toBe('exploring')
    expect(updated.combat).toBeUndefined()
  })

  it('intimidate succeeds on low-morale wounded enemies and awards 75% XP for affected enemies', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_intimidate_success'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'combat',
          enemies: [
            { name: 'Goblin', hp: 4, maxHp: 10, DEX: 10, attack: 0, dodge: 0, morale: 6, negotiable: true },
            { name: 'Hobgoblin', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, morale: 10, negotiable: true },
          ],
        },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.0) // d100 => 1 (success)
    try {
      await tool.execute('toolcall-intimidate', { command: 'intimidate', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)

    const foes = updated.combat.enemies
    expect(foes[0].hp).toBe(0)
    expect(foes[1].hp).toBe(10)
    // floor(25 * 0.75) = 18
    expect(updated.xpEarned).toEqual({ alice: 18 })
    expect(updated.mode).toBe('combat')
  })

  it('intimidate failure enrages enemies (+10 attack) for the rest of combat', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_intimidate_failure_enrage'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'combat',
          enemies: [{ name: 'Goblin', hp: 4, maxHp: 10, DEX: 10, attack: 30, dodge: 0, morale: 6, negotiable: true }],
        },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.99999) // d100 => 100 (fail)
    try {
      await tool.execute('toolcall-intimidate', { command: 'intimidate', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)

    expect(updated.combat.enemies[0].attack).toBe(40)
    expect(updated.xpEarned ?? {}).toEqual({})
    expect(updated.mode).toBe('combat')
  })

  it('buildContext during combat shows all available actions and marks negotiability and morale', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_buildcontext_combat_actions'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'combat',
          enemies: [
            { name: 'Goblin', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, morale: 6, negotiable: true },
            { name: 'Skeleton', hp: 10, maxHp: 10, DEX: 10, attack: 0, dodge: 0, morale: 12, negotiable: false, tactics: { kind: 'skeleton' } },
          ],
        },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain('⚔️ COMBAT!')
    expect(text).toContain('Actions: attack, negotiate, flee, intimidate')
    expect(text.toLowerCase()).toContain('negotiable')
    expect(text.toLowerCase()).toContain('morale')
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

  it('buildContext includes persistent backstory and only the last 3 adventure log entries', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_build_context_persistent'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'A quiet room.' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter: vi.fn().mockResolvedValue({
        name: 'Thorin',
        klass: 'Warrior',
        level: 2,
        xp: 123,
        maxHp: 20,
        maxMp: 5,
        skills: { attack: 60, dodge: 50, cast_spell: 10, use_skill: 40 },
        backstory: 'Raised by wolves in the Ashwood.',
        motivation: '',
        appearance: '',
        personalityTraits: [],
        adventureLog: ['A1', 'A2', 'A3', 'A4', 'A5'],
        achievements: [],
        inventory: [],
        createdAt: 1,
        updatedAt: 2,
        gamesPlayed: 5,
        deaths: 0,
      }),
    }

    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain('Your backstory: Raised by wolves in the Ashwood.')
    expect(text).toContain('📜 CAMPAIGN HISTORY:')
    expect(text).toContain('Your previous adventures:')
    expect(text).toContain('- A3')
    expect(text).toContain('- A4')
    expect(text).toContain('- A5')
    expect(text).not.toContain('A1')
    expect(text).not.toContain('A2')

    // Campaign history should be injected after intro, before tactical skills.
    const introIdx = lines.findIndex((l) => l.includes('You are'))
    const historyIdx = lines.findIndex((l) => l.includes('📜 CAMPAIGN HISTORY:'))
    const tacticsIdx = lines.findIndex((l) => l.includes('Party Coordination & Action Economy'))
    expect(introIdx).toBeGreaterThanOrEqual(0)
    expect(historyIdx).toBeGreaterThan(introIdx)
    expect(tacticsIdx).toBeGreaterThan(historyIdx)
  })

  it('buildContext shows character level and XP progress toward the next level', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_build_context_xp_progress'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'A quiet room.' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter: vi.fn().mockResolvedValue({
        name: 'Thorin',
        klass: 'Warrior',
        level: 3,
        xp: 450,
        maxHp: 20,
        maxMp: 5,
        skills: { attack: 60, dodge: 50, cast_spell: 10, use_skill: 40 },
        backstory: '',
        motivation: '',
        appearance: '',
        personalityTraits: [],
        adventureLog: [],
        achievements: [],
        inventory: [],
        createdAt: 1,
        updatedAt: 2,
        gamesPlayed: 1,
        deaths: 0,
      }),
    }

    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain('Level 3 Warrior (450/600 XP to next level)')
  })

  it('buildContext finds the current party member by agent name even when their character has a fantasy name', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_build_context_agent_mapping'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'A quiet room.' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')

    expect(text).toContain('IT IS YOUR TURN')
    expect(text).toContain('You are')
    expect(text).toContain('HP:')
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
    expect(alice.name).toBe('Thorin')
    expect(alice.klass).toBe('Warrior')
    expect(alice.maxHp).toBe(25)
    expect(alice.hp).toBe(25)
    expect(alice.skills.attack).toBe(70)
  })

  it('join_game creates a fresh character when loadCharacter returns null', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter: vi.fn().mockResolvedValue(null),
      saveCharacter: vi.fn(),
    }

    const gameId = 'rpg_test_join_game_fresh_when_no_persist'
    const game = createGame({
      id: gameId,
      players: ['grimlock'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute!('call-1', { command: 'join_game', gameId, klass: 'Mage' })

    expect(ctx.loadCharacter).toHaveBeenCalled()

    const updatedRow = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updatedGame = JSON.parse(updatedRow!.state)
    const alice = updatedGame.party.find((p: any) => p.agent === 'alice')
    expect(alice).toBeDefined()
    expect(alice.klass).toBe('Mage')
    expect(typeof alice.name).toBe('string')
    expect(alice.name.length).toBeGreaterThan(0)
  })

  it('on game completion, saves the updated persistent character when saveCharacter is available', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const saveCharacter = vi.fn()
    const loadCharacter = vi.fn().mockResolvedValue(null)
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter,
      saveCharacter,
    }

    const gameId = 'rpg_test_game_completed_saves_character'
    const game = createGame({ id: gameId, players: ['alice'], dungeon: [{ type: 'rest', description: 'safe' }] })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = Math.max(0, game.dungeon.length - 1)
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-1', { command: 'explore', gameId })

    expect(loadCharacter).toHaveBeenCalled()
    expect(saveCharacter).toHaveBeenCalledTimes(1)
    expect(saveCharacter.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        klass: expect.any(String),
        name: expect.any(String),
        gamesPlayed: 1,
        adventureLog: expect.arrayContaining([expect.stringContaining('The party of')]),
      })
    )
  })

  it('on game completion, applies accumulated XP via awardXp() before saving the persistent character', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const saveCharacter = vi.fn()
    const loadCharacter = vi.fn().mockResolvedValue(null)

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter,
      saveCharacter,
    }

    // Make the random skill point deterministic (always the first skill key).
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const gameId = 'rpg_test_game_completed_awards_xp'
    const game = createGame({ id: gameId, players: ['alice'], dungeon: [{ type: 'rest', description: 'safe' }] })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = Math.max(0, game.dungeon.length - 1)
    game.currentPlayer = 'alice'
    ;(game as any).xpEarned = { alice: 450 }

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-1', { command: 'explore', gameId })

    expect(loadCharacter).toHaveBeenCalled()
    expect(saveCharacter).toHaveBeenCalledTimes(1)

    const saved = saveCharacter.mock.calls[0]![0]
    expect(saved.xp).toBe(450)
    expect(saved.level).toBe(3) // 0->100->300 thresholds
    expect(saved.maxHp).toBeGreaterThan(game.party[0]!.maxHp)
    expect(saved.maxMp).toBeGreaterThan(game.party[0]!.maxMp)
  })

  it('buildContext includes achievements when present', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_build_context_achievements'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'A quiet room.' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter: vi.fn().mockResolvedValue({
        name: 'Thorin',
        klass: 'Warrior',
        level: 2,
        xp: 123,
        maxHp: 20,
        maxMp: 5,
        skills: { attack: 60, dodge: 50, cast_spell: 10, use_skill: 40 },
        backstory: '',
        motivation: '',
        appearance: '',
        personalityTraits: [],
        adventureLog: [],
        achievements: ['Veteran Adventurer', 'Untouchable'],
        inventory: [],
        createdAt: 1,
        updatedAt: 2,
        gamesPlayed: 5,
        deaths: 0,
      }),
    }

    const lines = await rpgEnvironment.buildContext(ctx as any)
    const text = lines.join('\n')
    expect(text).toContain('🏆 Your achievements: Veteran Adventurer, Untouchable')
  })

  it('awards achievements on notable events at game completion', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const saveCharacter = vi.fn()
    const loadCharacter = vi.fn().mockResolvedValue({
      name: 'Thorin',
      klass: 'Warrior',
      level: 1,
      xp: 0,
      maxHp: 20,
      maxMp: 5,
      skills: { attack: 60, dodge: 50, cast_spell: 10, use_skill: 40 },
      backstory: '',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: [],
      achievements: [],
      inventory: [],
      createdAt: 1,
      updatedAt: 2,
      gamesPlayed: 4,
      deaths: 0,
    })

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter,
      saveCharacter,
    }

    const gameId = 'rpg_test_awards_achievements'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = Math.max(0, game.dungeon.length - 1)
    game.currentPlayer = 'alice'

    // Pre-seed notable events into the log; completion should compact + award.
    const pc = findCharacter(game, 'alice')!
    pc.hp = 1 // <10% HP
    pc.maxHp = 20
    game.log.push({ at: 1, who: 'alice', what: 'gained 50 XP (kill: Dungeon Boss)' })
    game.log.push({ at: 2, who: 'alice', what: 'gained 250 XP (boss kill)' })
    game.log.push({ at: 3, who: 'alice', what: 'barrier: auto_crumble (The ancient seal weakens and shatters)' })

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-1', { command: 'explore', gameId })

    expect(saveCharacter).toHaveBeenCalledTimes(1)
    const saved = saveCharacter.mock.calls[0]![0]
    expect(saved.achievements).toEqual(expect.arrayContaining(["Death's Doorstep", 'Veteran Adventurer']))
    expect(saved.achievements.join(' ')).toMatch(/slayer/i)
  })

  it('send_message adds to feedMessages (rolling buffer) with sender/to/type/timestamp', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'slag',
      agentDid: 'did:cf:slag',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_send_message_adds_feed'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'slag', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-send_message', {
      command: 'send_message',
      gameId,
      to: '@snarl',
      message: 'Hold the line. I am coming.',
      type: 'ic',
    })

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    expect(Array.isArray(updated.feedMessages)).toBe(true)
    expect(updated.feedMessages.length).toBe(1)
    expect(updated.feedMessages[0].sender).toBe('slag')
    expect(updated.feedMessages[0].to).toBe('@snarl')
    expect(updated.feedMessages[0].type).toBe('ic')
    expect(updated.feedMessages[0].message).toBe('Hold the line. I am coming.')
    expect(typeof updated.feedMessages[0].timestamp).toBe('number')
  })

  it('buildContext includes recent messages mentioning the agent (direct @to and @party)', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'slag',
      agentDid: 'did:cf:slag',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_context_includes_mentions'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'slag'
    ;(game as any).feedMessages = [
      { sender: 'snarl', to: '@slag', message: 'OOC: flank left?', type: 'ooc', timestamp: Date.now() - 50 },
      { sender: 'snarl', to: '@party', message: 'IC: The torchlight is dying.', type: 'ic', timestamp: Date.now() - 25 },
    ]

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'slag', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const lines = await rpgEnvironment.buildContext(ctx as any)
    const joined = lines.join('\n')
    expect(joined).toContain('Recent messages')
    expect(joined).toContain('@slag')
    expect(joined).toContain('@party')
    expect(joined).toContain('flank left?')
    expect(joined).toContain('torchlight')
  })

  it('send_message is rate limited to 2 per agent per round', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'slag',
      agentDid: 'did:cf:slag',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_send_message_rate_limit'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    ;(game as any).round = 1

    await db
      .prepare(
        "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'slag', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-send_message-1', {
      command: 'send_message',
      gameId,
      to: '@party',
      message: 'msg1',
      type: 'ooc',
    })
    await tool.execute('toolcall-send_message-2', {
      command: 'send_message',
      gameId,
      to: '@party',
      message: 'msg2',
      type: 'ooc',
    })
    const third = await tool.execute('toolcall-send_message-3', {
      command: 'send_message',
      gameId,
      to: '@party',
      message: 'msg3',
      type: 'ooc',
    })

    expect((third as any).ok).toBe(false)

    const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    expect(updated.feedMessages.length).toBe(2)
  })
})

describe('compactAdventureLog', () => {
  it('generates a narrative summary from the game state log', () => {
    const game = createGame({
      id: 'rpg_test_compact_summary',
      players: ['alice', 'bob'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'barrier', description: 'sealed', requiredClass: 'Mage' as any },
        { type: 'boss', description: 'boss', enemies: [{ name: 'Dungeon Boss', hp: 1, DEX: 1, attack: 1, dodge: 1, tactics: { kind: 'boss' } as any }] },
      ],
    })
    ;(game as any).theme = 'haunted crypt'
    game.roomIndex = 2
    game.phase = 'finished'
    game.log.push({ at: 1, who: 'alice', what: 'gained 50 XP (kill: Goblin)' })
    game.log.push({ at: 2, who: 'alice', what: 'gained 250 XP (boss kill)' })
    game.log.push({ at: 3, who: 'alice', what: 'barrier: brute_force (-4 HP)' })

    const summary = compactAdventureLog(game as any)
    expect(summary).toContain('The party of')
    expect(summary).toContain('ventured into')
    expect(summary.toLowerCase()).toContain('haunted')
    expect(summary.toLowerCase()).toContain('boss')
    expect(summary.length).toBeLessThanOrEqual(200)
  })

  it('caps the summary at 200 characters', () => {
    const game = createGame({
      id: 'rpg_test_compact_cap',
      players: ['alice', 'bob', 'carol'],
      dungeon: [{ type: 'rest', description: 'safe' }, { type: 'rest', description: 'safe2' }],
    })
    ;(game as any).theme = 'the unbelievably long and overwrought cathedral of endless echoes and sorrow'
    game.roomIndex = 1
    game.phase = 'finished'
    for (let i = 0; i < 20; i += 1) {
      game.log.push({ at: i + 1, who: 'alice', what: `gained 50 XP (kill: Goblin ${i})` })
    }

    const summary = compactAdventureLog(game as any)
    expect(summary.length).toBeLessThanOrEqual(200)
  })
})
