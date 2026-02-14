import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createCharacter, createGame, findCharacter } from '../games/rpg-engine'
import {
  applyDispositionForEncounterOutcome,
  buildCampaignDungeonThread,
  compactAdventureLog,
  createCampaign,
  getCampaign,
  resolveStoryArcsForAdventureOutcome,
  rpgEnvironment,
  updateCampaign,
} from './rpg'
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['swoop', 'alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-explore', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-status', { command: 'status', gameId })

    const row = await db.prepare('SELECT state, phase FROM environments WHERE id = ?').bind(gameId).first<any>()
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
          "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

      const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)

    // GM should NOT auto-resolve combat — instead provides graduated hints.
    // Party stays in the same room, still in combat mode.
    expect(updated.roomIndex).toBe(0)
    expect(updated.mode).toBe('combat')

    // GM should log a hint (whisper) instead of auto-resolving.
    expect(updated.log.some((e: any) => String(e.what).includes('GM whispers'))).toBe(true)

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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-join', { command: 'join_game', gameId, klass: 'Mage' })

    const row = await db.prepare('SELECT state, players FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const nonDmTool = rpgEnvironment.getTool({ agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast } as any)
    const rejected = await nonDmTool.execute('toolcall-setup-narrate', { command: 'setup_narrate', gameId, message: 'yo' })
    expect(rejected).toMatchObject({ ok: false })
    expect(String((rejected as any).error)).toContain('Only Grimlock')

    const dmTool = rpgEnvironment.getTool({ agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast } as any)
    await dmTool.execute('toolcall-setup-narrate', { command: 'setup_narrate', gameId, message: 'Tell me about your origin.' })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const slagTool = rpgEnvironment.getTool({ agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast } as any)
    await slagTool.execute('toolcall-setup-respond-1', { command: 'setup_respond', gameId, message: 'I was born under a broken moon.' })

    {
      const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
      const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const dmLines = await rpgEnvironment.buildContext({ agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast } as any)
    expect(dmLines.join('\n')).toContain('SETUP PHASE')
    expect(dmLines.join('\n')).toContain('slag')

    // Current player prompt
    game.currentPlayer = 'slag'
    await db
      .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
      .run()

    const slagLines = await rpgEnvironment.buildContext({ agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast } as any)
    expect(slagLines.join('\n')).toContain('backstory')
    expect(slagLines.join('\n')).toContain('setup_respond')

    const snarlLines = await rpgEnvironment.buildContext({ agentName: 'snarl', agentDid: 'did:cf:snarl', db: db as any, broadcast } as any)
    expect(snarlLines.join('\n')).toContain('Waiting')
    expect(snarlLines.join('\n')).toContain('slag')
    expect(snarlLines.join('\n')).toContain('environment_broadcast')
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
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ name: 'Final Chamber', description: 'The last room.', type: 'treasure', enemies: [] }],
    })

    // Force immediate completion: explore() finishes if roomIndex is already at last room.
    game.phase = 'playing'
    game.roomIndex = Math.max(0, game.dungeon.length - 1)
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
          "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.phase).toBe('finished')
    expect(updated.xpEarned).toEqual({ alice: 450 })
  })

  it('syncs awarded XP to the in-game character and levels up mid-dungeon with growth log', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const gameId = 'rpg_test_midgame_level_sync'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'combat',
          description: 'boss skirmish',
          enemies: [{ name: 'Wyrmling', hp: 1, DEX: 10, attack: 0, dodge: 0, tactics: { kind: 'boss' } }],
        },
        { type: 'rest', description: 'rest' },
      ],
    })
    game.phase = 'playing'
    game.currentPlayer = 'alice'
    game.party[0]!.skills.attack = 100
    const hpBefore = game.party[0]!.maxHp
    const mpBefore = game.party[0]!.maxMp
    const attackBefore = game.party[0]!.skills.attack

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const tool = rpgEnvironment.getTool(ctx as any)

    const randoms = [
      0.0, // attacker d100 = 1 (hit)
      0.99999, // enemy dodge d100 = 100 (fail)
      0.0, // damage d6 = 1 (kill)
      0.0, // level-up skill boost picks first sorted skill key
    ]
    let i = 0
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => randoms[i++] ?? 0.0)
    try {
      await tool.execute('toolcall-1', { command: 'attack', gameId })
    } finally {
      spy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const alice = findCharacter(updated, 'alice')!
    expect(updated.xpEarned).toEqual({ alice: 125 })
    expect(alice.xp).toBe(125)
    expect(alice.level).toBe(2)
    expect(alice.maxHp).toBe(hpBefore + 7)
    expect(alice.maxMp).toBe(mpBefore + 5)
    expect(alice.skills.attack).toBe(attackBefore + 5)
    expect(updated.log.some((e: any) => typeof e.what === 'string' && e.what.includes('reaches Level 2! (+7 HP, +5 MP)'))).toBe(
      true
    )
  })

  it('awards trap-disarm milestone XP to the acting scout', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const gameId = 'rpg_test_xp_trap_disarm'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'trap', description: 'A pressure plate snaps underfoot.' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    const alice = findCharacter(game, 'alice')!
    alice.klass = 'Scout'
    alice.skills.use_skill = 99

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool({ agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast } as any)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await tool.execute('toolcall-xp-trap', { command: 'explore', gameId })
    } finally {
      randomSpy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 75 })
  })

  it('awards class barrier-clear milestone XP when the required class resolves the barrier', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const gameId = 'rpg_test_xp_barrier_required_class'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'barrier', description: 'An arcane seal.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    const alice = findCharacter(game, 'alice')!
    alice.klass = 'Mage'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool({ agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast } as any)
    await tool.execute('toolcall-xp-barrier-class', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 75 })
  })

  it('awards reduced barrier-clear XP for brute-force clears', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const gameId = 'rpg_test_xp_barrier_bruteforce'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'barrier', description: 'A stone gate.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    findCharacter(game, 'alice')!.klass = 'Warrior'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool({ agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast } as any)
    await tool.execute('toolcall-xp-barrier-bruteforce', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 65 })
  })

  it('awards puzzle milestone XP to the full living party on a solved puzzle', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const gameId = 'rpg_test_xp_puzzle_party'
    const game = createGame({
      id: gameId,
      players: ['alice', 'bob'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'puzzle', description: 'A lock of rotating runes.' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    findCharacter(game, 'alice')!.skills.use_skill = 99

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const tool = rpgEnvironment.getTool({ agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast } as any)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await tool.execute('toolcall-xp-puzzle', { command: 'explore', gameId })
    } finally {
      randomSpy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 80, bob: 80 })
  })

  it('awards treasure-find XP per item found', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const gameId = 'rpg_test_xp_treasure_find'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'treasure', description: 'A chest full of curios.' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool({ agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast } as any)
    await tool.execute('toolcall-xp-treasure', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 60 })
  })

  it('awards 75% encounter XP for successful negotiation and 50% for successful intimidation', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const gameId = 'rpg_test_xp_negotiate_intimidate'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'combat', description: 'A tense stand-off.', enemies: [{ name: 'Bandit', hp: 10, DEX: 20, attack: 20, dodge: 20 }] }],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    game.combat = {
      enemies: [{ name: 'Bandit', hp: 10, maxHp: 10, DEX: 20, attack: 20, dodge: 20, morale: 9, negotiable: true, tactics: { kind: 'goblin' } }],
    }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await tool.execute('toolcall-xp-negotiate', { command: 'negotiate', gameId })
    } finally {
      randomSpy.mockRestore()
    }

    let row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    let updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 18 })

    updated.mode = 'combat'
    updated.currentPlayer = 'alice'
    updated.combat = {
      enemies: [{ name: 'Bruiser', hp: 4, maxHp: 10, DEX: 20, attack: 20, dodge: 20, morale: 6, negotiable: true, tactics: { kind: 'goblin' } }],
    }
    await db
      .prepare("UPDATE environments SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(updated), updated.phase, updated.winner ?? null, gameId)
      .run()

    const intimidateRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await tool.execute('toolcall-xp-intimidate', { command: 'intimidate', gameId })
    } finally {
      intimidateRandomSpy.mockRestore()
    }

    row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 30 })
  })

  it('awards flee consolation XP on successful retreat and grants no XP for resting', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = { agentName: 'alice', agentDid: 'did:cf:alice', db: db as any, broadcast }
    const gameId = 'rpg_test_xp_flee_and_rest'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'combat', description: 'An ambush', enemies: [{ name: 'Goblin', hp: 10, DEX: 20, attack: 20, dodge: 20 }] },
        { type: 'rest', description: 'A safe corner.' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.roomIndex = 0
    game.currentPlayer = 'alice'
    game.combat = { enemies: [{ name: 'Goblin', hp: 10, maxHp: 10, DEX: 20, attack: 20, dodge: 20, morale: 9, tactics: { kind: 'goblin' } }] }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await tool.execute('toolcall-xp-flee', { command: 'flee', gameId })
    } finally {
      randomSpy.mockRestore()
    }

    await tool.execute('toolcall-xp-rest', { command: 'rest', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    expect(updated.xpEarned).toEqual({ alice: 10 })
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
      inventory: [
        {
          name: 'Axe',
          rarity: 'common',
          slot: 'weapon',
          effects: [{ stat: 'attack', bonus: 2 }],
          description: 'A dependable chopping axe.',
        },
      ],
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
      "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).bind('rpg_persist_test', 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock'])).run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute!('call-1', { command: 'join_game', gameId: 'rpg_persist_test', klass: 'Warrior' })

    expect(ctx.loadCharacter).toHaveBeenCalled()

    // Verify the joined character has persistent stats
    const updatedRow = await db.prepare("SELECT state FROM environments WHERE id = 'rpg_persist_test'").first<{ state: string }>()
    const updatedGame = JSON.parse(updatedRow!.state)
    const alice = updatedGame.party.find((p: any) => p.agent === 'alice')
    expect(alice).toBeDefined()
    expect(alice.name).toBe('Thorin')
    expect(alice.klass).toBe('Warrior')
    expect(alice.maxHp).toBe(25)
    expect(alice.hp).toBe(25)
    expect(alice.skills.attack).toBe(70)
  })

  it('join_game rerolls a new level 1 character when persistent data is marked dead', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const saveCharacter = vi.fn()

    const persistentChar = {
      name: 'Fallen Hero',
      klass: 'Warrior',
      level: 7,
      xp: 2400,
      maxHp: 44,
      maxMp: 16,
      skills: { attack: 90, dodge: 70, cast_spell: 20, use_skill: 65 },
      backstory: 'A legend now gone.',
      motivation: '',
      appearance: '',
      personalityTraits: [],
      adventureLog: ['Defeated the Bone Regent'],
      achievements: ['Legend'],
      inventory: [
        {
          name: 'Relic Blade',
          rarity: 'rare',
          slot: 'weapon',
          effects: [{ stat: 'attack', bonus: 8 }],
          description: 'A blade carried by a fallen champion.',
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      gamesPlayed: 12,
      deaths: 4,
      dead: true,
      diedAt: 1700000000000,
      causeOfDeath: 'slain by Cave Troll in Ashen Reliquary',
    }

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      loadCharacter: vi.fn().mockResolvedValue(persistentChar),
      saveCharacter,
    }

    const gameId = 'rpg_test_join_reroll_dead_persist'
    const game = createGame({
      id: gameId,
      players: ['grimlock'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute!('call-reroll', { command: 'join_game', gameId, klass: 'Mage' })
    const text = String((result as any)?.content?.[0]?.text ?? '')

    const updatedRow = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updatedGame = JSON.parse(updatedRow!.state)
    const alice = updatedGame.party.find((p: any) => p.agent === 'alice')

    expect(alice).toBeDefined()
    expect(alice.name).not.toBe('Fallen Hero')
    expect(alice.klass).toBe('Mage')
    expect(alice.maxHp).toBeLessThan(44)
    expect(text).toContain('fell in battle')
    expect(text).toContain('A new hero rises')

    expect(saveCharacter).toHaveBeenCalledTimes(1)
    expect(saveCharacter.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        dead: false,
        deaths: 4,
        achievements: ['Legend'],
        adventureLog: ['Defeated the Bone Regent'],
      })
    )
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['grimlock']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute!('call-1', { command: 'join_game', gameId, klass: 'Mage' })

    expect(ctx.loadCharacter).toHaveBeenCalled()

    const updatedRow = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updatedGame = JSON.parse(updatedRow!.state)
    const alice = updatedGame.party.find((p: any) => p.agent === 'alice')
    expect(alice).toBeDefined()
    expect(alice.klass).toBe('Mage')
    expect(typeof alice.name).toBe('string')
    expect(alice.name.length).toBeGreaterThan(0)
  })

  it('resurrect succeeds for Healer, revives at 1 HP, halves adventure XP, and applies a skill debuff', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_resurrect_success'
    const game = createGame({
      id: gameId,
      players: ['alice', 'bob'],
      dungeon: [
        { type: 'combat', description: 'A crypt battle', enemies: [{ name: 'Skeleton', hp: 5, DEX: 30, attack: 30, dodge: 20 }] },
      ],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'alice'

    const healer = findCharacter(game, 'alice')!
    healer.klass = 'Healer'
    healer.mp = 6
    healer.skills.cast_spell = 85

    const target = findCharacter(game, 'bob')!
    const skillsBefore = { ...target.skills }
    target.hp = 0
    ;(target as any).diedThisAdventure = true
    ;(game as any).xpEarned = { bob: 101 }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.01)
    try {
      const tool = rpgEnvironment.getTool(ctx as any)
      const result = await tool.execute('toolcall-resurrect', { command: 'resurrect', gameId, target: 'bob' })
      const text = String((result as any)?.content?.[0]?.text ?? '')
      expect(text).toContain('returns to life')
    } finally {
      randomSpy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    const revived = updated.party.find((p: any) => (p.agent ?? p.name) === 'bob')
    const updatedHealer = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice')

    expect(revived.hp).toBe(1)
    expect(revived.skills.attack).toBe(Math.max(1, skillsBefore.attack - 10))
    expect(revived.skills.dodge).toBe(Math.max(1, skillsBefore.dodge - 10))
    expect(revived.skills.cast_spell).toBe(Math.max(1, skillsBefore.cast_spell - 10))
    expect(revived.skills.use_skill).toBe(Math.max(1, skillsBefore.use_skill - 10))
    expect(updated.xpEarned.bob).toBe(50)
    expect(updatedHealer.mp).toBe(2)
  })

  it('resurrect failure spends MP and blocks retry for the rest of the adventure', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_resurrect_failure'
    const game = createGame({
      id: gameId,
      players: ['alice', 'bob'],
      dungeon: [
        { type: 'combat', description: 'A crypt battle', enemies: [{ name: 'Skeleton', hp: 5, DEX: 30, attack: 30, dodge: 20 }] },
      ],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'alice'

    const healer = findCharacter(game, 'alice')!
    healer.klass = 'Healer'
    healer.mp = 8
    healer.skills.cast_spell = 35

    const target = findCharacter(game, 'bob')!
    target.hp = 0
    ;(target as any).diedThisAdventure = true

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    try {
      const tool = rpgEnvironment.getTool(ctx as any)
      await tool.execute('toolcall-resurrect-fail-1', { command: 'resurrect', gameId, target: 'bob' })
      const retry = await tool.execute('toolcall-resurrect-fail-2', { command: 'resurrect', gameId, target: 'bob' })
      expect(retry).toMatchObject({ ok: false })
      expect(String((retry as any).error)).toContain('no retry')
    } finally {
      randomSpy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    const stillDead = updated.party.find((p: any) => (p.agent ?? p.name) === 'bob')
    const updatedHealer = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice')

    expect(stillDead.hp).toBe(0)
    expect(updatedHealer.mp).toBe(4)
  })

  it('logs a death beat when a character falls and hints resurrection if a healer is alive', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const ctx = {
      agentName: 'healer',
      agentDid: 'did:cf:healer',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_death_narrative'
    const game = createGame({
      id: gameId,
      players: ['healer', 'victim'],
      dungeon: [{ type: 'combat', description: 'ambush', enemies: [{ name: 'Orc', hp: 20, DEX: 40, attack: 100, dodge: 1 }] }],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'healer'

    const healer = findCharacter(game, 'healer')!
    healer.klass = 'Healer'
    healer.skills.attack = 1

    const victim = findCharacter(game, 'victim')!
    victim.hp = 1
    victim.skills.dodge = 1

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'healer', JSON.stringify(game), game.phase, JSON.stringify(['healer', 'victim']))
      .run()

    const rolls = [
      0.99999, // attacker d100 -> miss
      0.0, // enemy dodge d100
      0.99999, // enemy target d2 -> victim
      0.0, // enemy attack d100 -> hit
      0.99999, // victim dodge d100 -> fail
      0.99999, // damage d6 -> 6
    ]
    let idx = 0
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => rolls[idx++] ?? 0.0)
    try {
      const tool = rpgEnvironment.getTool(ctx as any)
      await tool.execute('toolcall-death', { command: 'attack', gameId })
    } finally {
      randomSpy.mockRestore()
    }

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    const deadChar = updated.party.find((p: any) => (p.agent ?? p.name) === 'victim')
    const logText = updated.log.map((e: any) => String(e.what))

    expect(logText.some((line: string) => line.includes(`${deadChar.name} has fallen! Their adventure ends here.`))).toBe(true)
    expect(logText.some((line: string) => line.includes('A resurrection may yet be possible'))).toBe(true)
    expect(Array.isArray(updated.narrativeContext)).toBe(true)
    expect(updated.narrativeContext.some((b: any) => b.kind === 'death' && b.text === deadChar.name)).toBe(true)
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

  it('explore: treasure rooms grant loot items and gold to the acting character', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_treasure_loot_rewards'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        { type: 'rest', description: 'safe' },
        { type: 'treasure', description: 'A chest sits in the room center.' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.roomIndex = 0
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-loot-1', { command: 'explore', gameId })
    const text = String((result as any)?.content?.[0]?.text ?? '')

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const alice = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice')

    expect(Array.isArray(alice.inventory)).toBe(true)
    expect(alice.inventory.length).toBeGreaterThan(0)
    expect(alice.gold).toBeGreaterThan(0)
    expect(updated.log.some((e: any) => String(e.what).includes('Found:'))).toBe(true)
    expect(text).toContain('Found:')
  })

  it('use_item consumes a healing potion and restores HP', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_use_item_heal'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'
    const alice = findCharacter(game, 'alice')!
    alice.hp = Math.max(1, alice.maxHp - 8)
    ;(alice as any).inventory = [
      {
        name: 'Minor Healing Potion',
        rarity: 'common',
        slot: 'consumable',
        effects: [],
        consumable: { type: 'heal', amount: 6 },
        description: 'A basic restorative draught.',
      },
    ]

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-use-item', { command: 'use_item', gameId, item: 'potion' })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const updatedAlice = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice')

    expect(updatedAlice.hp).toBeGreaterThan(alice.hp)
    expect(updatedAlice.inventory).toHaveLength(0)
  })

  it('rest shop: can buy a potion with gold in rest rooms', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_rest_shop_buy_potion'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'
    const alice = findCharacter(game, 'alice')!
    ;(alice as any).gold = 30

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-rest-shop', {
      command: 'rest',
      gameId,
      shop: 'buy_potion',
    })
    const text = String((result as any)?.content?.[0]?.text ?? '')

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const updatedAlice = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice')
    const boughtPotion = updatedAlice.inventory.find((item: any) => item?.slot === 'consumable')

    expect(updatedAlice.gold).toBeLessThan(30)
    expect(boughtPotion).toBeTruthy()
    expect(text).toContain('Bought')
  })

  it('combat: boss kills always grant a rare-or-better loot drop', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_boss_guaranteed_drop'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [
        {
          type: 'boss',
          description: 'A final guardian appears.',
          enemies: [{ name: 'Dungeon Boss', hp: 1, DEX: 10, attack: 0, dodge: 0, tactics: { kind: 'boss' } }],
        },
      ],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'alice'
    const alice = findCharacter(game, 'alice')!
    alice.skills.attack = 100

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-boss-drop', { command: 'attack', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
    const updated = JSON.parse(row!.state)
    const updatedAlice = updated.party.find((p: any) => (p.agent ?? p.name) === 'alice')
    const rareDrops = (updatedAlice.inventory ?? []).filter((item: any) => item?.rarity === 'rare' || item?.rarity === 'legendary')

    expect(rareDrops.length).toBeGreaterThan(0)
    expect(updated.log.some((e: any) => String(e.what).includes('loot drop'))).toBe(true)
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
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

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    expect(updated.feedMessages.length).toBe(2)
  })

  it('get_reputation returns faction standings for campaign-linked adventures', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_get_reputation'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe room' }],
      campaignState: {
        id: 'campaign_rep_1',
        name: 'Ironlands',
        premise: 'Hold the border',
        worldState: {
          factions: [{ id: 'f_iron', name: 'Iron Brotherhood', disposition: 65, description: 'Steel-clad wardens.' }],
          locations: [],
          events: [],
        },
        storyArcs: [],
        adventureCount: 0,
      } as any,
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-get-reputation', { command: 'get_reputation', gameId })
    const text = (result as any)?.content?.[0]?.text ?? ''

    expect(text).toContain('The Iron Brotherhood considers you allies (+65)')
  })

  it('transitions campaign adventures into hub_town on completion', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_campaign_hub_transition'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe room' }],
      campaignState: {
        id: 'campaign_hub_1',
        name: 'Ironlands',
        premise: 'Hold the border against the shadow host.',
        worldState: {
          factions: [{ id: 'f_iron', name: 'Iron Brotherhood', disposition: 30, description: 'Steel-clad wardens.' }],
          locations: [],
          events: ['Adventure #1 ended in victory: The border held.'],
        },
        storyArcs: [
          {
            id: 'arc_border',
            name: 'War for the Border',
            status: 'active',
            plotPoints: [{ id: 'plot_1', description: 'Secure the ford', resolved: false }],
          },
        ],
        adventureCount: 1,
      } as any,
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'
    game.roomIndex = 0

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-campaign-hub', { command: 'explore', gameId })

    const row = await db.prepare('SELECT state, phase FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    const text = String((result as any)?.content?.[0]?.text ?? '')

    expect(row.phase).toBe('hub_town')
    expect(updated.phase).toBe('hub_town')
    expect(updated.hubTown).toMatchObject({ location: 'tavern', idleTurns: 0, autoEmbarkAfter: 5 })
    expect(text).toContain('Hub Town')
    expect(text).toContain('Ironlands')
  })

  it('supports hub town commands: visit_location, buy_item, sell_item, and full-heal rest', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_hub_commands'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe room' }],
      campaignState: {
        id: 'campaign_hub_2',
        name: 'Ironlands',
        premise: 'Hold the border.',
        worldState: { factions: [], locations: [], events: [] },
        storyArcs: [],
        adventureCount: 2,
      } as any,
    })
    game.phase = 'hub_town'
    game.mode = 'finished'
    game.currentPlayer = 'alice'
    ;(game as any).hubTown = { location: 'tavern', idleTurns: 0, autoEmbarkAfter: 5 }
    const alice = findCharacter(game, 'alice')!
    alice.hp = 1
    alice.mp = 0
    alice.gold = 120
    alice.inventory = []

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const visit = await tool.execute('toolcall-hub-visit', { command: 'visit_location', gameId, location: 'market' })
    const buy = await tool.execute('toolcall-hub-buy', { command: 'buy_item', gameId, itemId: 'iron_sword' })
    const sell = await tool.execute('toolcall-hub-sell', { command: 'sell_item', gameId, itemId: 'iron_sword' })
    const rest = await tool.execute('toolcall-hub-rest', { command: 'rest', gameId })

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    const updatedAlice = findCharacter(updated, 'alice')!

    expect(String((visit as any)?.content?.[0]?.text ?? '')).toContain('Ironlands')
    expect(String((buy as any)?.content?.[0]?.text ?? '')).toContain('iron_sword')
    expect(String((sell as any)?.content?.[0]?.text ?? '')).toContain('iron_sword')
    expect(String((rest as any)?.content?.[0]?.text ?? '')).toContain('fully recover')
    expect(updated.hubTown.location).toBe('market')
    expect(updatedAlice.hp).toBe(updatedAlice.maxHp)
    expect(updatedAlice.mp).toBe(updatedAlice.maxMp)
    expect(updatedAlice.inventory.some((item: any) => String(item?.name || '').toLowerCase().includes('iron'))).toBe(false)
  })

  it('auto-embarks from hub town after 5 idle turns via autoplay actions', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_hub_auto_embark'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe room' }],
      campaignState: {
        id: 'campaign_hub_3',
        name: 'Ironlands',
        premise: 'Hold the border.',
        worldState: { factions: [], locations: [], events: [] },
        storyArcs: [],
        adventureCount: 2,
      } as any,
    })
    game.phase = 'hub_town'
    game.mode = 'finished'
    game.currentPlayer = 'alice'
    ;(game as any).hubTown = { location: 'tavern', idleTurns: 5, autoEmbarkAfter: 5 }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)
    expect(calls).toEqual([{ name: 'rpg', arguments: { command: 'embark', gameId } }])
  })

  it('increments hub-town idle turns during autoplay checks before auto-embark', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    }

    const gameId = 'rpg_test_hub_auto_embark_progressive'
    const game = createGame({
      id: gameId,
      players: ['alice'],
      dungeon: [{ type: 'rest', description: 'safe room' }],
      campaignState: {
        id: 'campaign_hub_4',
        name: 'Ironlands',
        premise: 'Hold the border.',
        worldState: { factions: [], locations: [], events: [] },
        storyArcs: [],
        adventureCount: 2,
      } as any,
    })
    game.phase = 'hub_town'
    game.mode = 'finished'
    game.currentPlayer = 'alice'
    ;(game as any).hubTown = { location: 'tavern', idleTurns: 0, autoEmbarkAfter: 5 }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice']))
      .run()

    for (let i = 0; i < 4; i += 1) {
      const calls = await rpgEnvironment.getAutoPlayActions(ctx as any)
      expect(calls).toEqual([])
    }
    const finalCalls = await rpgEnvironment.getAutoPlayActions(ctx as any)
    expect(finalCalls).toEqual([{ name: 'rpg', arguments: { command: 'embark', gameId } }])

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    expect(updated.hubTown.idleTurns).toBe(5)
  })

  it('allows freeform exploration actions when mode is exploring (no turn gate)', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'snarl',
      agentDid: 'did:cf:snarl',
      db: db as any,
      broadcast,
      reactiveMode: true,
      wakeAgent: vi.fn(),
    }

    const gameId = 'rpg_test_exploration_freeform'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [
        { type: 'rest', description: 'safe room' },
        { type: 'rest', description: 'next room' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'slag'
    game.roomIndex = 0

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'slag', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-freeform-explore', { command: 'explore', gameId })
    expect((result as any)?.ok).not.toBe(false)

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    expect(updated.mode).toBe('exploring')
    expect(updated.roomIndex).toBeGreaterThan(0)
  })

  it('allows freeform exploration actions when mode is exploring even with reactive mode disabled', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'snarl',
      agentDid: 'did:cf:snarl',
      db: db as any,
      broadcast,
      reactiveMode: false,
      wakeAgent: vi.fn(),
    }

    const gameId = 'rpg_test_exploration_freeform_flag_off'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [
        { type: 'rest', description: 'safe room' },
        { type: 'rest', description: 'next room' },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'slag'
    game.roomIndex = 0

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'slag', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-freeform-explore-flag-off', { command: 'explore', gameId })
    expect((result as any)?.ok).not.toBe(false)

    const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<any>()
    const updated = JSON.parse(row.state)
    expect(updated.mode).toBe('exploring')
    expect(updated.roomIndex).toBeGreaterThan(0)
  })

  it('keeps initiative turn gating in combat mode', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = {
      agentName: 'snarl',
      agentDid: 'did:cf:snarl',
      db: db as any,
      broadcast,
      reactiveMode: true,
      wakeAgent: vi.fn(),
    }

    const gameId = 'rpg_test_combat_turn_gated'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl'],
      dungeon: [{ type: 'combat', description: 'ambush', enemies: [{ name: 'Goblin', hp: 6, DEX: 20, attack: 20, dodge: 20 }] }],
    })
    game.phase = 'playing'
    game.mode = 'combat'
    game.currentPlayer = 'slag'
    game.combat = {
      enemies: [{ name: 'Goblin', hp: 6, maxHp: 6, DEX: 20, attack: 20, dodge: 20, morale: 8, tactics: { kind: 'goblin' } }],
    }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'slag', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-combat-turn-gated', { command: 'attack', gameId })
    expect((result as any)?.ok).toBe(false)
    expect(String((result as any)?.error ?? '')).toContain('Not your turn')
  })

  it('reactive mode wakes next player on turn advance and notifies all party members on mode switch', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const wakeAgent = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      reactiveMode: true,
      wakeAgent,
    }

    const gameId = 'rpg_test_reactive_wake_signals'
    const game = createGame({
      id: gameId,
      players: ['alice', 'bob'],
      dungeon: [
        { type: 'rest', description: 'camp' },
        { type: 'combat', description: 'ambush', enemies: [{ name: 'Goblin', hp: 5, DEX: 20, attack: 20, dodge: 20 }] },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'
    game.roomIndex = 0
    const alice = findCharacter(game, 'alice')
    const bob = findCharacter(game, 'bob')
    if (alice && bob) {
      alice.stats.DEX = 90
      bob.stats.DEX = 10
      game.turnOrder = [alice, bob]
    }

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    const result = await tool.execute('toolcall-reactive-explore', { command: 'explore', gameId })
    expect((result as any)?.ok).not.toBe(false)

    const wakeTargets = wakeAgent.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(wakeTargets).toContain('alice')
    expect(wakeTargets).toContain('bob')
    expect(wakeTargets.filter((target) => target === 'bob').length).toBeGreaterThan(0)
  })

  it('reactive wake signals are disabled when reactiveMode feature flag is false', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const wakeAgent = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
      reactiveMode: false,
      wakeAgent,
    }

    const gameId = 'rpg_test_reactive_wake_signals_flag_off'
    const game = createGame({
      id: gameId,
      players: ['alice', 'bob'],
      dungeon: [
        { type: 'rest', description: 'camp' },
        { type: 'combat', description: 'ambush', enemies: [{ name: 'Goblin', hp: 5, DEX: 20, attack: 20, dodge: 20 }] },
      ],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'alice'
    game.roomIndex = 0

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'alice', JSON.stringify(game), game.phase, JSON.stringify(['alice', 'bob']))
      .run()

    const tool = rpgEnvironment.getTool(ctx as any)
    await tool.execute('toolcall-reactive-flag-off', { command: 'explore', gameId })

    expect(wakeAgent).not.toHaveBeenCalled()
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

type CampaignDbCampaignRow = {
  id: string
  name: string
  premise: string
  world_state: string
  story_arcs: string
  created_at: string
  updated_at: string
}

type CampaignDbEnvironmentRow = {
  id: string
  type: string
  host_agent: string
  state: string
  phase: string
  players: string
  winner: string | null
  created_at: string
  updated_at: string
  campaign_id: string | null
  adventure_number: number
}

class CampaignDbStatement {
  constructor(
    private readonly db: CampaignDbMock,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): CampaignDbStatement {
    return new CampaignDbStatement(this.db, this.sql, params)
  }

  async run(): Promise<{ success: true }> {
    await this.db.run(this.sql, this.params)
    return { success: true }
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.params)
  }
}

class CampaignDbMock {
  readonly campaigns = new Map<string, CampaignDbCampaignRow>()
  readonly environments = new Map<string, CampaignDbEnvironmentRow>()

  prepare(sql: string): CampaignDbStatement {
    return new CampaignDbStatement(this, sql)
  }

  seedEnvironment(row: Partial<CampaignDbEnvironmentRow> & Pick<CampaignDbEnvironmentRow, 'id'>): void {
    this.environments.set(row.id, {
      id: row.id,
      type: row.type ?? 'rpg',
      host_agent: row.host_agent ?? 'grimlock',
      state: row.state ?? JSON.stringify({ id: row.id, type: 'rpg' }),
      phase: row.phase ?? 'playing',
      players: row.players ?? '[]',
      winner: row.winner ?? null,
      created_at: row.created_at ?? new Date().toISOString(),
      updated_at: row.updated_at ?? new Date().toISOString(),
      campaign_id: row.campaign_id ?? null,
      adventure_number: row.adventure_number ?? 0,
    })
  }

  private normalizeSql(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim()
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = this.normalizeSql(sql)
    const now = new Date().toISOString()

    if (normalized.startsWith('create table if not exists campaigns')) return
    if (normalized.startsWith('alter table environments add column campaign_id')) return
    if (normalized.startsWith('alter table environments add column adventure_number')) return

    if (normalized.startsWith('insert into campaigns')) {
      const [id, name, premise, worldState, storyArcs] = params
      this.campaigns.set(String(id), {
        id: String(id),
        name: String(name),
        premise: String(premise ?? ''),
        world_state: String(worldState ?? '{}'),
        story_arcs: String(storyArcs ?? '[]'),
        created_at: now,
        updated_at: now,
      })
      return
    }

    if (normalized.startsWith('update campaigns set')) {
      const [name, premise, worldState, storyArcs, id] = params
      const existing = this.campaigns.get(String(id))
      if (!existing) return
      existing.name = String(name ?? existing.name)
      existing.premise = String(premise ?? existing.premise)
      existing.world_state = String(worldState ?? existing.world_state)
      existing.story_arcs = String(storyArcs ?? existing.story_arcs)
      existing.updated_at = now
      this.campaigns.set(existing.id, existing)
      return
    }

    if (normalized.startsWith('update environments set campaign_id = ?')) {
      const [campaignId, adventureNumber, state, id] = params
      const existing = this.environments.get(String(id))
      if (!existing) return
      existing.campaign_id = campaignId == null ? null : String(campaignId)
      existing.adventure_number = Number(adventureNumber ?? 0)
      existing.state = String(state ?? existing.state)
      existing.updated_at = now
      this.environments.set(existing.id, existing)
      return
    }

    throw new Error(`Unsupported SQL in CampaignDbMock.run: ${normalized}`)
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const normalized = this.normalizeSql(sql)

    if (normalized.startsWith('select id, name, premise, world_state, story_arcs, created_at, updated_at from campaigns where id = ?')) {
      const row = this.campaigns.get(String(params[0]))
      return (row ?? null) as T | null
    }

    if (normalized.startsWith('select id, state from environments where id = ? and type =')) {
      const row = this.environments.get(String(params[0]))
      if (!row || row.type !== 'rpg') return null
      return ({ id: row.id, state: row.state } as unknown) as T
    }

    if (normalized.startsWith('select campaign_id, adventure_number from environments where id = ?')) {
      const row = this.environments.get(String(params[0]))
      if (!row) return null
      return ({ campaign_id: row.campaign_id, adventure_number: row.adventure_number } as unknown) as T
    }

    throw new Error(`Unsupported SQL in CampaignDbMock.first: ${normalized}`)
  }
}

describe('campaign persistence helpers', () => {
  it('creates, reads, and updates a campaign in D1 with minimal defaults', async () => {
    const db = new CampaignDbMock()
    const created = await createCampaign(db as any, 'Ironlands Saga', 'The Shadow Court rises in the Ironlands')

    expect(created.name).toBe('Ironlands Saga')
    expect(created.worldState).toEqual({
      factions: [],
      locations: [],
      events: [],
    })
    expect(created.storyArcs).toEqual([])
    expect(created.adventureCount).toBe(0)

    const loaded = await getCampaign(db as any, created.id)
    expect(loaded?.premise).toContain('Shadow Court')
    expect(loaded?.worldState.events).toEqual([])

    const worldStatePatch = {
      factions: [{ id: 'f1', name: 'Iron Vanguard', disposition: 25, description: 'Local defenders' }],
      locations: [{ id: 'l1', name: 'Old Keep', description: 'A contested outpost' }],
      events: ['The keep walls cracked under siege.'],
    }
    const storyArcPatch = [
      {
        id: 'arc-1',
        name: 'Opening Siege',
        status: 'active' as const,
        plotPoints: [{ id: 'pp-1', description: 'Secure the eastern gate', resolved: false }],
      },
    ]
    const updated = await updateCampaign(db as any, created.id, {
      premise: 'The Shadow Court fractures as new claimants emerge',
      worldState: worldStatePatch,
      storyArcs: storyArcPatch,
      adventureCount: 2,
    })

    expect(updated).toBeUndefined()

    const reloaded = await getCampaign(db as any, created.id)
    expect(reloaded?.premise).toContain('fractures')
    expect(reloaded?.worldState).toEqual(worldStatePatch)
    expect(reloaded?.storyArcs).toEqual(storyArcPatch)
    expect(reloaded?.adventureCount).toBe(2)
  })

  it('returns null when campaign does not exist', async () => {
    const db = new CampaignDbMock()
    const campaign = await getCampaign(db as any, 'campaign_missing')
    expect(campaign).toBeNull()
  })

  it('does not auto-generate campaign premise data from theme + party composition when premise is blank', async () => {
    const db = new CampaignDbMock()
    const options = {
      theme: 'Crimson Crown',
      party: [
        { klass: 'Warrior' as const, level: 6 },
        { klass: 'Mage' as const, level: 6 },
        { klass: 'Healer' as const, level: 5 },
      ],
    }

    const first = await createCampaign(db as any, 'Crimson Crown Saga', '', options)
    const second = await createCampaign(db as any, 'Crimson Crown Saga', '', options)

    expect(first.premise).toBe('')
    expect(first.worldState).toEqual({
      factions: [],
      locations: [],
      events: [],
    })
    expect(first.storyArcs).toEqual([])

    expect(second.premise).toBe('')
    expect(second.worldState).toEqual({
      factions: [],
      locations: [],
      events: [],
    })
    expect(second.storyArcs).toEqual([])
  })

  it('treats a theme string as a no-op optional createCampaign parameter', async () => {
    const db = new CampaignDbMock()
    const generated = await createCampaign(db as any, 'Stormwatch Saga', '', 'Stormwatch')

    expect(generated.premise).toBe('')
    expect(generated.worldState).toEqual({
      factions: [],
      locations: [],
      events: [],
    })
    expect(generated.storyArcs).toEqual([])
  })

  it('persists rich campaign world details when createCampaign receives prebuilt worldState/storyArcs', async () => {
    const db = new CampaignDbMock()
    const worldState = {
      factions: [
        {
          id: 'f_lantern',
          name: 'Iron Lantern Compact',
          disposition: 25,
          description: 'Road wardens holding trade routes.',
          keyNpc: { name: 'Captain Mirel Voss', role: 'Marshal', description: 'Veteran tactician.' },
        },
      ],
      locations: [{ id: 'loc_cinderwatch', name: 'Cinderwatch', description: 'Hub city above siege tunnels.' }],
      events: ['Campaign setup: A fractured crown ignites a succession war.'],
      centralVillain: {
        name: 'Duke Malrec Thorne',
        description: 'A dispossessed warlord with a private army.',
        objective: 'Claim the ember crown and unify the marches by force.',
        lieutenants: [
          { name: 'Sergeant Bronn', role: 'Enforcer', description: 'Leads levy raids.' },
          { name: 'Magister Vale', role: 'Arcanist', description: 'Maintains blood wards.' },
        ],
      },
      alliedNpcs: [
        { name: 'Iri Dawnforge', role: 'Quartermaster', description: 'Supplies frontier expeditions.' },
        { name: 'Brother Tamsin', role: 'Healer', description: 'Treats cursed wounds.' },
      ],
      hubTown: {
        name: 'Cinderwatch',
        description: 'A soot-stained bastion where caravans regroup.',
        locations: [
          {
            name: 'The Brazen Cup',
            description: 'A packed inn with rotating mercenary contracts.',
            shopkeeper: 'Nella Quay',
            questGiver: 'Captain Mirel Voss',
          },
          {
            name: 'Warden Outfitters',
            description: 'Arms and expedition supplies.',
            shopkeeper: 'Dorrik Steel',
            questGiver: 'Iri Dawnforge',
          },
        ],
      },
      regionalMap: [
        { name: 'Cinderwatch', description: 'Hub city and market crossroads.' },
        { name: 'Ash Crypt', description: 'Collapsed royal tomb.' },
        { name: 'Silk Row', description: 'Canal district controlled by spies.' },
      ],
    }
    const storyArcs = [
      {
        id: 'arc_ember',
        name: 'Ember Succession',
        status: 'active' as const,
        plotPoints: [
          { id: 'pp_1', description: 'Recover the shattered signet from Ash Crypt.', resolved: false },
          { id: 'pp_2', description: 'Win over two neutral barons.', resolved: false },
        ],
      },
      {
        id: 'arc_spyglass',
        name: 'Spyglass War',
        status: 'seeded' as const,
        plotPoints: [{ id: 'pp_3', description: 'Unmask the Cabal handler in Cinderwatch.', resolved: false }],
      },
      {
        id: 'arc_pilgrimage',
        name: 'Relic Fire Pilgrimage',
        status: 'seeded' as const,
        plotPoints: [{ id: 'pp_4', description: 'Escort pilgrims through the high pass.', resolved: false }],
      },
    ]

    const created = await createCampaign(db as any, 'Ashen Crown Requiem', 'A fractured crown ignites war.', {
      worldState,
      storyArcs,
    } as any)

    expect(created.worldState.centralVillain?.name).toBe('Duke Malrec Thorne')
    expect(created.worldState.hubTown?.locations[0]?.shopkeeper).toBe('Nella Quay')
    expect(created.worldState.factions[0]?.keyNpc?.name).toBe('Captain Mirel Voss')
    expect(created.storyArcs).toEqual(storyArcs)

    const loaded = await getCampaign(db as any, created.id)
    expect(loaded?.worldState.centralVillain?.lieutenants).toHaveLength(2)
    expect(loaded?.worldState.hubTown?.locations[1]?.questGiver).toBe('Iri Dawnforge')
    expect(loaded?.worldState.regionalMap?.map((location: any) => location.name)).toEqual([
      'Cinderwatch',
      'Ash Crypt',
      'Silk Row',
    ])
    expect(loaded?.storyArcs).toEqual(storyArcs)
  })
})

describe('faction disposition encounter outcomes', () => {
  it('applies kill and negotiation outcomes to faction disposition', () => {
    const campaign = {
      id: 'campaign_faction_rep',
      name: 'Ironlands',
      premise: 'Faction war',
      worldState: {
        factions: [
          { id: 'iron', name: 'Iron Brotherhood', disposition: 15, description: 'Border wardens' },
          { id: 'court', name: 'Shadow Court', disposition: -30, description: 'Ruthless opportunists' },
        ],
        locations: [],
        events: [],
      },
      storyArcs: [],
      adventureCount: 2,
    } as any

    const afterKill = applyDispositionForEncounterOutcome({
      campaign,
      enemies: [{ name: 'Iron Scout', hp: 0, DEX: 30, attack: 30, dodge: 20, factionId: 'iron' }],
      resolution: 'kill',
      reason: 'Killed faction-aligned enemy in combat.',
    })

    expect(afterKill.worldState.factions.find((f: any) => f.id === 'iron')?.disposition).toBe(-5)
    expect(afterKill.worldState.events.at(-1)).toContain('Killed faction-aligned enemy')

    const afterNegotiation = applyDispositionForEncounterOutcome({
      campaign: afterKill,
      enemies: [{ name: 'Iron Envoy', hp: 10, DEX: 30, attack: 20, dodge: 20, factionId: 'iron' }],
      resolution: 'negotiate',
      reason: 'Negotiated truce with faction-aligned enemies.',
    })

    expect(afterNegotiation.worldState.factions.find((f: any) => f.id === 'iron')?.disposition).toBe(5)
    expect(afterNegotiation.worldState.events.at(-1)).toContain('Negotiated truce')
  })
})

describe('campaign adventure threading helpers', () => {
  it('picks the active arc with the next unresolved plot point and builds dungeon context + recaps', () => {
    const campaign = {
      id: 'campaign_threading',
      name: 'Ashfall Chronicles',
      premise: 'A crimson comet fractures the northern kingdoms',
      worldState: {
        factions: [],
        locations: [],
        events: [
          'Adventure #1 (rpg_1) ended in victory: The vanguard held the bridge.',
          'Adventure #2 (rpg_2) ended in victory: The scouts mapped the catacombs.',
          'Adventure #3 (rpg_3) ended in tpk: The ogre host overwhelmed the camp.',
          'Local festival resumed in the market district.',
          'Adventure #4 (rpg_4) ended in victory: The relic vault was breached.',
        ],
      },
      storyArcs: [
        {
          id: 'arc_resolved',
          name: 'Broken Sigils',
          status: 'active' as const,
          plotPoints: [{ id: 'pp_done', description: 'Repair the warding circle', resolved: true }],
        },
        {
          id: 'arc_active',
          name: 'Cometfall Conspiracy',
          status: 'active' as const,
          plotPoints: [
            { id: 'pp_open', description: 'Recover the sunstone from Ash Vault', resolved: false },
            { id: 'pp_later', description: 'Confront the court astrologer', resolved: false },
          ],
        },
      ],
      adventureCount: 4,
    }

    const thread = buildCampaignDungeonThread(campaign as any)

    expect(thread.objective?.arcId).toBe('arc_active')
    expect(thread.objective?.plotPointId).toBe('pp_open')
    expect(thread.themedCampaignState.storyArcs[0]?.id).toBe('arc_active')
    expect(thread.themedCampaignState.premise).toContain('Recover the sunstone from Ash Vault')

    const recapLines = thread.campaignLog.filter((line) => line.startsWith('Previously on: '))
    expect(recapLines.length).toBeGreaterThanOrEqual(3)
    expect(recapLines.some((line) => line.includes('Adventure #2'))).toBe(true)
    expect(recapLines.some((line) => line.includes('Adventure #4'))).toBe(true)
  })

  it('always adds a previously_on narrative line, even for a brand-new campaign history', () => {
    const campaign = {
      id: 'campaign_fresh',
      name: 'Fresh Banner',
      premise: 'A new alliance forms under a blood-red moon.',
      worldState: {
        factions: [],
        locations: [{ id: 'loc_1', name: 'Red Harbor', description: 'A storm-battered frontier port.' }],
        events: [],
      },
      storyArcs: [],
      adventureCount: 0,
    }

    const thread = buildCampaignDungeonThread(campaign as any)
    expect(thread.campaignLog.some((line) => line.startsWith('Previously on: '))).toBe(true)
  })

  it('marks the selected plot point as resolved after adventure completion', () => {
    const next = resolveStoryArcsForAdventureOutcome({
      storyArcs: [
        {
          id: 'arc_alpha',
          name: 'First Arc',
          status: 'active',
          plotPoints: [{ id: 'pp_alpha', description: 'Scout the pass', resolved: false }],
        },
        {
          id: 'arc_beta',
          name: 'Second Arc',
          status: 'active',
          plotPoints: [{ id: 'pp_beta', description: 'Recover the moon key', resolved: false }],
        },
      ],
      gameId: 'rpg_campaign_outcome',
      outcome: 'abandoned',
      objective: { arcId: 'arc_beta', plotPointId: 'pp_beta' },
    })

    const alphaPoint = next.find((arc) => arc.id === 'arc_alpha')?.plotPoints[0]
    const betaPoint = next.find((arc) => arc.id === 'arc_beta')?.plotPoints[0]

    expect(alphaPoint?.resolved).toBe(false)
    expect(betaPoint?.resolved).toBe(true)
    expect(betaPoint?.adventureId).toBe('rpg_campaign_outcome')
  })

  it('includes "Previously on..." recap lines for Grimlock context from campaignLog', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const gameId = 'rpg_test_campaign_previous_on'
    const game = createGame({
      id: gameId,
      players: ['slag', 'snarl', 'swoop'],
      dungeon: [{ type: 'rest', description: 'A briefing chamber.' }],
    })
    game.phase = 'playing'
    game.mode = 'exploring'
    game.currentPlayer = 'grimlock'
    game.campaignContext = {
      id: 'campaign_alpha',
      name: 'Ashfall Chronicles',
      premise: 'A crimson comet fractures the northern kingdoms',
      activeArcs: ['Cometfall Conspiracy'],
      factions: [],
      npcs: [],
    }
    game.campaignLog = [
      'Campaign: Ashfall Chronicles',
      'Previously on: Adventure #2 ended in victory at the catacombs.',
      'Previously on: Adventure #3 ended in tpk at the shattered camp.',
    ]

    await db
      .prepare(
        "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(gameId, 'rpg', 'grimlock', JSON.stringify(game), game.phase, JSON.stringify(['slag', 'snarl', 'swoop']))
      .run()

    const lines = await rpgEnvironment.buildContext({
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
    } as any)
    const text = lines.join('\n')

    expect(text).toContain('Previously on...')
    expect(text).toContain('Adventure #2 ended in victory at the catacombs.')
    expect(text).toContain('Adventure #3 ended in tpk at the shattered camp.')
  })
})
