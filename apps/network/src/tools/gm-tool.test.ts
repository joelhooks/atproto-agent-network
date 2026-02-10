import { afterEach, describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createCharacter, createGame, explore, createTestDice, type RpgGameState } from '../games/rpg-engine'
import { getToolsForAgent } from './index'

async function insertRpgGame(db: D1Database, game: RpgGameState, players: string[]): Promise<void> {
  await db
    .prepare(
      "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    )
    .bind(game.id, 'rpg', players[0] ?? 'unknown', JSON.stringify(game), game.phase, JSON.stringify(players))
    .run()
}

async function getStoredGame(db: D1Database, gameId: string): Promise<RpgGameState> {
  const row = await db.prepare('SELECT state FROM games WHERE id = ?').bind(gameId).first<{ state: string }>()
  if (!row?.state) throw new Error('missing game row')
  return JSON.parse(row.state) as RpgGameState
}

describe('gm tool (grimlock-only)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    ;(globalThis as any).fetch = originalFetch
  })

  it('narrate: appends a [GM] message to the game log', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const game = createGame({
      id: 'rpg_gm_narrate',
      players: ['grimlock', 'alice'],
      dungeon: [{ type: 'rest', description: 'start' }],
    })
    await insertRpgGame(db as any, game, ['grimlock', 'alice'])

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    expect(tool?.name).toBe('gm')
    await tool!.execute!('tc_narrate', { command: 'narrate', gameId: game.id, text: 'A cold wind snakes through the corridor.' })

    const stored = await getStoredGame(db as any, game.id)
    expect(stored.log.some((e) => e.who === 'GM' && e.what.startsWith('[GM]') && e.what.includes('cold wind'))).toBe(true)
  })

  it('adjust_difficulty: modifies room enemy stats and persists to D1', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const game = createGame({
      id: 'rpg_gm_adjust_enemies',
      players: ['grimlock'],
      dungeon: [
        {
          type: 'combat',
          description: 'Goblins!',
          enemies: [{ name: 'Goblin', hp: 10, DEX: 40, attack: 20, dodge: 10 }],
        },
      ],
    })
    await insertRpgGame(db as any, game, ['grimlock'])

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    await tool!.execute!('tc_adjust', {
      command: 'adjust_difficulty',
      gameId: game.id,
      roomIndex: 0,
      enemyHpDelta: 5,
      enemyAttackDelta: 7,
    })

    const stored = await getStoredGame(db as any, game.id)
    const room = stored.dungeon[0] as any
    expect(room.enemies[0].hp).toBe(15)
    expect(room.enemies[0].attack).toBe(27)
    expect(stored.log.some((e) => e.what.startsWith('[GM]') && e.what.includes('adjust_difficulty'))).toBe(true)
  })

  it('adjust_difficulty: can lower a barrier auto-crumble threshold (affects explore logic)', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const scout = createCharacter({ name: 'grimlock', klass: 'Scout' })
    scout.mp = 0 // force failed attempts to count toward auto-crumble

    const game = createGame({
      id: 'rpg_gm_adjust_barrier',
      players: [scout],
      dungeon: [
        { type: 'rest', description: 'start' },
        { type: 'barrier', description: 'A rune-locked door.', requiredClass: 'Mage' },
        { type: 'rest', description: 'after' },
      ],
    })
    game.currentPlayer = 'grimlock'
    await insertRpgGame(db as any, game, ['grimlock'])

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    await tool!.execute!('tc_adjust_barrier', {
      command: 'adjust_difficulty',
      gameId: game.id,
      roomIndex: 1,
      autoCrumbleAttempts: 2,
    })

    const updated = await getStoredGame(db as any, game.id)
    const dice = createTestDice({ d100: () => 99, d: () => 1 }) // always fail skill check
    // Attempt 1: should block and reset to previous room
    explore(updated, { dice })
    expect(updated.roomIndex).toBe(0)
    // Attempt 2: should crumble and allow entry to barrier room
    explore(updated, { dice })
    expect(updated.roomIndex).toBe(1)
    expect(updated.log.some((e) => e.what.includes('barrier: auto_crumble'))).toBe(true)
  })

  it('add_event: injects an emergent event into the current room', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const game = createGame({
      id: 'rpg_gm_event',
      players: ['grimlock'],
      dungeon: [{ type: 'rest', description: 'start' }],
    })
    await insertRpgGame(db as any, game, ['grimlock'])

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    await tool!.execute!('tc_event', {
      command: 'add_event',
      gameId: game.id,
      kind: 'npc',
      text: 'A hooded guide emerges from the shadows.',
    })

    const stored = await getStoredGame(db as any, game.id)
    const room = stored.dungeon[0] as any
    expect(Array.isArray(room.gmEvents)).toBe(true)
    expect(room.gmEvents.some((e: any) => e.kind === 'npc' && String(e.text).includes('hooded guide'))).toBe(true)
    expect(stored.log.some((e) => e.what.startsWith('[GM]') && e.what.includes('add_event'))).toBe(true)
  })

  it('review_party: returns a summary including HP/MP, loot, rooms cleared, deaths, and near-deaths', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const a = createCharacter({ name: 'grimlock', klass: 'Warrior' })
    const b = createCharacter({ name: 'alice', klass: 'Mage' })
    a.hp = Math.max(0, a.hp - 2)
    b.hp = 0

    const game = createGame({
      id: 'rpg_gm_review',
      players: [a, b],
      dungeon: [{ type: 'treasure', description: 'Coins.' }, { type: 'rest', description: 'after' }],
    })
    game.roomIndex = 1
    game.log.push({ at: Date.now(), who: 'grimlock', what: 'treasure: found soot-black opal' })
    game.log.push({ at: Date.now(), who: 'GM', what: 'near-death: grimlock' })

    await insertRpgGame(db as any, game, ['grimlock', 'alice'])

    const ctx = { agentName: 'grimlock', agentDid: 'did:cf:grimlock', db: db as any, broadcast }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    const result = await tool!.execute!('tc_review', { command: 'review_party', gameId: game.id })
    const text = Array.isArray((result as any)?.content) ? String((result as any).content[0]?.text ?? '') : ''

    expect(text).toContain('Party')
    expect(text).toContain('grimlock(Warrior)')
    expect(text).toContain('alice(Mage)')
    expect(text).toContain('Loot')
    expect(text).toContain('soot-black opal')
    expect(text).toContain('Rooms cleared')
    expect(text).toContain('Deaths')
    expect(text).toContain('Near-deaths')
  })

  it('access control: non-grimlock agents never receive the gm tool, even if configured', () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()
    const ctx = { agentName: 'slag', agentDid: 'did:cf:slag', db: db as any, broadcast }

    const tools = getToolsForAgent(ctx as any, ['gm'])
    expect(tools.length).toBe(0)
  })

  it('consult_library: POSTs to grimlock webhookUrl and caches results into game.libraryContext', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const game = createGame({
      id: 'rpg_gm_consult_library',
      players: ['grimlock'],
      dungeon: [{ type: 'rest', description: 'start' }],
    })
    await insertRpgGame(db as any, game, ['grimlock'])

    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'Encounter pacing: easy -> hard -> boss.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    vi.stubGlobal('fetch', fetchSpy as any)

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      webhookUrl: 'https://example.test/hooks/agent-network?token=hook-secret',
    }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    const result = await tool!.execute!('tc_consult', {
      command: 'consult_library',
      gameId: game.id,
      query: 'encounter design pacing and difficulty curve',
    })

    const text = Array.isArray((result as any)?.content) ? String((result as any).content[0]?.text ?? '') : ''
    expect(text).toContain('Encounter pacing')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [unknown, unknown]
    expect(String(url)).toBe('https://example.test/hooks/agent-network')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer hook-secret',
      },
    })

    const body = (init as { body?: unknown }).body
    expect(typeof body).toBe('string')
    expect(JSON.parse(String(body))).toEqual({
      type: 'consult_library',
      query: 'encounter design pacing and difficulty curve',
      limit: 3,
      expand: 2000,
    })

    const stored = await getStoredGame(db as any, game.id)
    expect(stored.libraryContext).toBeTruthy()
    expect((stored.libraryContext as any)['encounter design pacing and difficulty curve']).toContain('Encounter pacing')
  })
})
