import { afterEach, describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createCharacter, createGame, explore, createTestDice, type RpgGameState } from '../games/rpg-engine'
import * as rpgCampaign from '../environments/rpg'
import { getToolsForAgent } from './index'

async function insertRpgGame(db: D1Database, game: RpgGameState, players: string[]): Promise<void> {
  await db
    .prepare(
      "INSERT INTO environments (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    )
    .bind(game.id, 'rpg', players[0] ?? 'unknown', JSON.stringify(game), game.phase, JSON.stringify(players))
    .run()
}

async function getStoredGame(db: D1Database, gameId: string): Promise<RpgGameState> {
  const row = await db.prepare('SELECT state FROM environments WHERE id = ?').bind(gameId).first<{ state: string }>()
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

  it('craft_dungeon: consults library, prompts the LLM with campaign + party context, and persists AI-generated rooms', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const grimlock = createCharacter({ name: 'grimlock', klass: 'Warrior' })
    grimlock.level = 4
    grimlock.backstory = 'Veteran siege breaker who distrusts court mages.'
    const alice = createCharacter({ name: 'alice', klass: 'Mage' })
    alice.level = 3
    alice.backstory = 'Runaway archivist obsessed with forbidden cartography.'

    const game = createGame({
      id: 'rpg_gm_craft_dungeon',
      players: [grimlock, alice],
      dungeon: [{ type: 'rest', description: 'staging' }],
    })
    game.campaignContext = {
      id: 'campaign_cinder',
      name: 'Ashen Crown Requiem',
      premise: 'Rival factions race to claim an ember crown.',
      activeArcs: ['Spyglass War', 'Ember Succession'],
      factions: ['Iron Lantern Compact', 'Velvet Knife Cabal'],
      npcs: ['Captain Mirel Voss', 'Orin Sable'],
    }
    game.campaignLog = [
      'Adventure #1: party secured the ember signet from the ash crypt.',
      'Adventure #2: cabal handler escaped through Silk Row canals.',
    ]
    await insertRpgGame(db as any, game, ['grimlock', 'alice'])

    const responses: Record<string, string> = {
      'encounter design pacing and difficulty curve (Game Angry)':
        'Game Angry pacing: easy -> medium -> hard -> deadly -> boss. Rest after hard fights.',
      'BRP opposed roll mechanics combat (BRP SRD)':
        'BRP combat: opposed rolls; crit at skill/5; fumble at 96-00.',
      "monster tactics for goblins and orcs (The Monsters Know What They're Doing)":
        'Goblins: hit-and-run, ambush, flee. Orcs: power attack, bully, press the advantage.',
      'dungeon exploration procedures (OSE)':
        'OSE procedures: turns, light, wandering monsters, listening, opening doors.',
    }

    const fetchSpy = vi.fn().mockImplementation(async (_url: unknown, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const query = String(body?.query ?? '')
      const text = responses[query] ?? `unknown query: ${query}`
      return new Response(JSON.stringify({ text }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchSpy as any)

    const aiRooms = [
      { type: 'rest', description: 'Salt-lacquered antechamber with whispering braziers.', difficultyTier: 'easy' },
      {
        type: 'combat',
        description: 'Archivist skeletons rise from collapsed shelves.',
        difficultyTier: 'easy',
        enemies: [{ name: 'Archivist Skeleton', hp: 14, DEX: 45, attack: 22, dodge: 16 }],
      },
      { type: 'puzzle', description: 'Clockwork index wheel must be aligned to old house sigils.', difficultyTier: 'medium' },
      { type: 'trap', description: 'Pressure seals vent numbing brine mist.', difficultyTier: 'medium' },
      { type: 'treasure', description: 'Vault of imperial warrants and silver tally rods.', difficultyTier: 'medium' },
      {
        type: 'combat',
        description: 'Cabal duelists test intruders with mirrored feints.',
        difficultyTier: 'hard',
        enemies: [
          { name: 'Velvet Duelist', hp: 22, DEX: 62, attack: 40, dodge: 38 },
          { name: 'Silk Row Hexer', hp: 18, DEX: 58, attack: 44, dodge: 30 },
        ],
      },
      { type: 'barrier', description: 'Runic gate keyed to arcane blood signatures.', difficultyTier: 'hard', requiredClass: 'Mage' },
      { type: 'rest', description: 'Hidden scriptorium used by rebel messengers.', difficultyTier: 'hard' },
      { type: 'trap', description: 'Pendulum blades sweep the map gallery.', difficultyTier: 'deadly' },
      {
        type: 'boss',
        description: 'Orin Sable\'s iron warden prototype guards the ember ledger.',
        difficultyTier: 'boss',
        enemies: [{ name: 'Iron Warden Prototype', hp: 70, DEX: 48, attack: 60, dodge: 28 }],
      },
    ]
    const aiRun = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        rooms: aiRooms,
        difficultyCurve: ['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'deadly', 'boss'],
      }),
    })

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      webhookUrl: 'https://example.test/hooks/agent-network?token=hook-secret',
      env: { AI: { run: aiRun } },
    }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    const result = await tool!.execute!('tc_craft', { command: 'craft_dungeon', gameId: game.id, theme: 'Saltworn Archives' })

    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(aiRun).toHaveBeenCalledTimes(1)
    const aiArgs = aiRun.mock.calls[0]?.[1]
    expect(JSON.stringify(aiArgs)).toContain('Spyglass War')
    expect(JSON.stringify(aiArgs)).toContain('Runaway archivist')
    expect(JSON.stringify(aiArgs)).toContain('Game Angry')

    const queries = fetchSpy.mock.calls.map((call) => {
      const init = call[1] as any
      const body = JSON.parse(String(init?.body ?? '{}'))
      return String(body?.query ?? '')
    })
    expect(new Set(queries)).toEqual(
      new Set([
        'encounter design pacing and difficulty curve (Game Angry)',
        'BRP opposed roll mechanics combat (BRP SRD)',
        "monster tactics for goblins and orcs (The Monsters Know What They're Doing)",
        'dungeon exploration procedures (OSE)',
      ])
    )

    const details = (result as any)?.details ?? {}
    expect(details.dungeon).toBeTruthy()
    expect(Array.isArray(details.dungeon)).toBe(true)
    expect(details.dungeon.length).toBe(aiRooms.length)
    expect(details.dungeon[0]).toMatchObject({ type: 'rest', description: expect.stringContaining('Salt-lacquered') })
    expect(details.dungeon[6]).toMatchObject({ type: 'barrier', requiredClass: 'Mage' })
    expect(details.dungeon[9]).toMatchObject({ type: 'boss' })
    expect(details.dungeon[9].enemies[0]).toMatchObject({ name: 'Iron Warden Prototype' })

    // Dungeon state should retain the library context for adjudication.
    expect(details.dungeonContext).toBeTruthy()
    expect(details.dungeonContext.libraryContext).toBeTruthy()
    expect(details.dungeonContext.difficultyCurve).toEqual([
      'easy',
      'easy',
      'medium',
      'medium',
      'medium',
      'hard',
      'hard',
      'hard',
      'deadly',
      'boss',
    ])
    for (const [k, v] of Object.entries(responses)) {
      expect(String(details.dungeonContext.libraryContext[k] ?? '')).toContain(v.slice(0, 10))
    }

    const stored = await getStoredGame(db as any, game.id)
    expect(stored.dungeonContext).toBeTruthy()
    for (const [k, v] of Object.entries(responses)) {
      expect(String((stored.dungeonContext as any).libraryContext?.[k] ?? '')).toContain(v.slice(0, 10))
    }
    expect(stored.dungeon[0]).toMatchObject({ type: 'rest', description: expect.stringContaining('Salt-lacquered') })
    expect(stored.dungeon[6]).toMatchObject({ type: 'barrier', requiredClass: 'Mage' })
  })

  it('craft_dungeon: falls back to library-crafted dungeon when AI output is invalid', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const game = createGame({
      id: 'rpg_gm_craft_dungeon_fallback',
      players: ['grimlock', 'alice'],
      dungeon: [{ type: 'rest', description: 'staging' }],
    })
    await insertRpgGame(db as any, game, ['grimlock', 'alice'])

    const fetchSpy = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ text: 'Use escalating stakes and tactical variety.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchSpy as any)

    const aiRun = vi.fn().mockResolvedValue({ response: '{"rooms":[{"type":"combat","description":"missing enemies"}]}' })

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      webhookUrl: 'https://example.test/hooks/agent-network?token=hook-secret',
      env: { AI: { run: aiRun } },
    }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    const result = await tool!.execute!('tc_craft_fallback', { command: 'craft_dungeon', gameId: game.id, theme: 'Sunken Vault' })
    const details = (result as any)?.details ?? {}

    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(aiRun).toHaveBeenCalledTimes(1)
    expect(Array.isArray(details.dungeon)).toBe(true)
    expect(details.dungeon.length).toBe(12)
    expect(details.theme?.name).toBe('Sunken Vault')
    expect(details.dungeonContext?.designNotes?.some((entry: string) => entry.includes('llm_fallback:'))).toBe(true)

    const stored = await getStoredGame(db as any, game.id)
    expect(stored.dungeon.length).toBe(12)
    expect(stored.theme.name).toBe('Sunken Vault')
  })

  it('plan_campaign: consults library, builds an LLM prompt with party context, and persists structured campaign data', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const game = createGame({
      id: 'rpg_gm_plan_campaign',
      players: [
        createCharacter({ name: 'grimlock', klass: 'Warrior' }),
        createCharacter({ name: 'alice', klass: 'Mage' }),
      ],
      dungeon: [{ type: 'rest', description: 'staging' }],
    })
    game.party[0]!.level = 5
    game.party[0]!.backstory = 'A former arena champion seeking redemption.'
    game.party[1]!.level = 4
    game.party[1]!.backstory = 'Exiled from the Sapphire College for forbidden rites.'
    await insertRpgGame(db as any, game, ['grimlock', 'alice'])

    const libraryResponses: Record<string, string> = {
      'campaign design patterns for party-driven arcs (Game Angry)':
        'Game Angry: campaign loops should alternate pressure and recovery while preserving clear stakes.',
      "faction design patterns and fronts for long campaigns (The Monsters Know What They're Doing, DM advice)":
        'Use factions with distinct doctrine, resources, and a signature NPC to keep conflicts legible.',
      'hub town and regional map design for sandbox campaigns':
        'A strong hub town has 3-5 actionable locations and quest NPCs tied to regional sites.',
    }

    const fetchSpy = vi.fn().mockImplementation(async (_url: unknown, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const query = String(body?.query ?? '')
      const text = libraryResponses[query] ?? `unknown query: ${query}`
      return new Response(JSON.stringify({ text }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchSpy as any)

    const llmJson = {
      campaignName: 'Ashen Crown Requiem',
      premise: 'An old imperial oath breaks, and rival claimants race to seize the ember crown.',
      factions: [
        {
          name: 'Iron Lantern Compact',
          description: 'Road wardens who keep trade lines alive at spearpoint.',
          disposition: 20,
          keyNpc: { name: 'Captain Mirel Voss', role: 'Marshal', description: 'Pragmatic officer who values decisive allies.' },
        },
        {
          name: 'Velvet Knife Cabal',
          description: 'Court spies and blackmail artists shaping succession from the shadows.',
          disposition: -35,
          keyNpc: { name: 'Orin Sable', role: 'Broker', description: 'Soft-spoken fixer with endless leverage.' },
        },
        {
          name: 'Ash Monastery',
          description: 'Pilgrims guarding relic fire shrines in the highlands.',
          disposition: 10,
          keyNpc: { name: 'Abbess Kaira', role: 'Seer', description: 'Interprets embers to predict omens.' },
        },
      ],
      centralVillain: {
        name: 'Duke Malrec Thorne',
        description: 'A dispossessed warlord determined to bind the realm through fear.',
        objective: 'Reforge the ember crown to claim unquestioned dominion.',
        lieutenants: [
          { name: 'Sergeant Bronn', role: 'Enforcer', description: 'Leads brutal levy raids.' },
          { name: 'Magister Vale', role: 'Arcanist', description: 'Maintains blood-bound siege wards.' },
        ],
      },
      alliedNpcs: [
        { name: 'Iri Dawnforge', role: 'Quartermaster', description: 'Supplies the party with forged gear.' },
        { name: 'Brother Tamsin', role: 'Healer', description: 'Treats cursed wounds and tracks relic lore.' },
      ],
      hubTown: {
        name: 'Cinderwatch',
        description: 'A soot-stained stronghold where caravans and spies trade rumors.',
        locations: [
          {
            name: 'The Brazen Cup',
            description: 'Crowded inn and rumor exchange.',
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
      storyArcs: [
        {
          name: 'Ember Succession',
          status: 'active',
          plotPoints: [
            'Secure the shattered signet from the ash crypt.',
            'Convince two neutral barons before Malrec does.',
          ],
        },
        {
          name: 'Spyglass War',
          status: 'seeded',
          plotPoints: [
            'Expose the Cabal handler embedded in Cinderwatch.',
            'Sabotage the blackmail archive beneath Silk Row.',
          ],
        },
        {
          name: 'Relic Fire Pilgrimage',
          status: 'seeded',
          plotPoints: [
            'Escort the Ash Monastery pilgrims through the high pass.',
            'Recover the ember script from drowned ruins.',
          ],
        },
      ],
      regionalMap: [
        { name: 'Cinderwatch', description: 'Hub town perched above old siege tunnels.' },
        { name: 'Ash Crypt', description: 'Collapsed royal tomb where the signet is hidden.' },
        { name: 'Silk Row', description: 'Canal district used by smugglers and informants.' },
      ],
    }

    const aiRun = vi.fn().mockResolvedValue({ response: JSON.stringify(llmJson) })
    const campaignCreateSpy = vi.spyOn(rpgCampaign, 'createCampaign').mockImplementation(async (_db, name, premise, options) => ({
      id: 'campaign_ashen',
      name,
      premise,
      worldState: (options as any)?.worldState ?? { factions: [], locations: [], events: [] },
      storyArcs: (options as any)?.storyArcs ?? [],
      adventureCount: 0,
    }))

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      webhookUrl: 'https://example.test/hooks/agent-network?token=hook-secret',
      env: { AI: { run: aiRun } },
    }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    const result = await tool!.execute!('tc_plan_campaign', {
      command: 'plan_campaign',
      gameId: game.id,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(aiRun).toHaveBeenCalledTimes(1)

    const aiArgs = aiRun.mock.calls[0]?.[1]
    expect(JSON.stringify(aiArgs)).toContain('Game Angry')
    expect(JSON.stringify(aiArgs)).toContain('former arena champion')
    expect(JSON.stringify(aiArgs)).toContain('Sapphire College')

    expect(campaignCreateSpy).toHaveBeenCalledTimes(1)
    const campaignCreateArgs = campaignCreateSpy.mock.calls[0]
    expect(campaignCreateArgs?.[1]).toBe('Ashen Crown Requiem')
    expect(campaignCreateArgs?.[2]).toContain('imperial oath breaks')
    expect(campaignCreateArgs?.[3]).toMatchObject({
      worldState: expect.objectContaining({
        factions: expect.arrayContaining([
          expect.objectContaining({
            name: 'Iron Lantern Compact',
            keyNpc: expect.objectContaining({ name: 'Captain Mirel Voss' }),
          }),
        ]),
        centralVillain: expect.objectContaining({
          name: 'Duke Malrec Thorne',
        }),
        hubTown: expect.objectContaining({
          name: 'Cinderwatch',
        }),
        regionalMap: expect.arrayContaining([expect.objectContaining({ name: 'Ash Crypt' })]),
      }),
      storyArcs: expect.arrayContaining([
        expect.objectContaining({ name: 'Ember Succession' }),
      ]),
    })

    const details = (result as any)?.details ?? {}
    expect(details.campaign).toBeTruthy()
    expect(details.campaign.name).toBe('Ashen Crown Requiem')
    expect(details.campaign.worldState.centralVillain.name).toBe('Duke Malrec Thorne')
    expect(details.campaign.worldState.hubTown.name).toBe('Cinderwatch')
  })

  it('advance_campaign: loads campaign state, asks AI for a patch, and persists world evolution via updateCampaign', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const campaign = {
      id: 'campaign_ashen',
      name: 'Ashen Crown Requiem',
      premise: 'Rival claimants seek the ember crown after a broken imperial oath.',
      worldState: {
        factions: [
          {
            id: 'faction_iron_lantern',
            name: 'Iron Lantern Compact',
            description: 'Road wardens holding key routes.',
            disposition: 20,
            keyNpc: { name: 'Captain Mirel Voss', role: 'Marshal', description: 'Keeps caravans alive.' },
          },
          {
            id: 'faction_velvet_knife',
            name: 'Velvet Knife Cabal',
            description: 'Spies trading in blackmail.',
            disposition: -35,
            keyNpc: { name: 'Orin Sable', role: 'Broker', description: 'A whisper in every court.' },
          },
        ],
        locations: [
          { id: 'location_cinderwatch', name: 'Cinderwatch', description: 'Hub town above old siege tunnels.' },
          { id: 'location_ash_crypt', name: 'Ash Crypt', description: 'Collapsed royal tomb.' },
        ],
        events: ['Adventure #1 complete: The party recovered the ember signet from the crypt.'],
        alliedNpcs: [
          { name: 'Iri Dawnforge', role: 'Quartermaster', description: 'Keeps the party supplied.' },
        ],
        centralVillain: {
          name: 'Duke Malrec Thorne',
          description: 'A dispossessed warlord chasing absolute rule.',
          objective: 'Reforge the ember crown.',
          lieutenants: [{ name: 'Magister Vale', role: 'Arcanist', description: 'Maintains siege wards.' }],
        },
        hubTown: {
          name: 'Cinderwatch',
          description: 'Soot-stained crossroads for caravans and spies.',
          locations: [
            { name: 'The Brazen Cup', description: 'Rumor-heavy tavern.', shopkeeper: 'Nella Quay' },
          ],
        },
        regionalMap: [
          { name: 'Cinderwatch', description: 'Hub town and fortress.' },
          { name: 'Ash Crypt', description: 'Ruined catacombs below old battlements.' },
        ],
      },
      storyArcs: [
        {
          id: 'arc_ember_succession',
          name: 'Ember Succession',
          status: 'active',
          plotPoints: [
            {
              id: 'plot_baron_support',
              description: 'Secure support from two neutral barons.',
              resolved: false,
            },
          ],
        },
      ],
      adventureCount: 1,
    }
    let persistedCampaign: any = JSON.parse(JSON.stringify(campaign))
    const getCampaignSpy = vi.spyOn(rpgCampaign, 'getCampaign').mockImplementation(async (_db, id) => {
      if (id !== campaign.id) return null
      return JSON.parse(JSON.stringify(persistedCampaign))
    })

    const aiRun = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        narrativeSummary:
          'Cinderwatch hardens its defenses while the Cabal fractures after the party exposed a handler. New warbands gather near the Blackwater road.',
        campaignPatch: {
          premise:
            'With the signet recovered, rival powers escalate into open conflict over succession and supply lines.',
          worldState: {
            factions: [
              {
                id: 'faction_iron_lantern',
                name: 'Iron Lantern Compact',
                description: 'Road wardens now emboldened by recent victories.',
                disposition: 35,
                keyNpc: { name: 'Captain Mirel Voss', role: 'Marshal', description: 'Publicly backs the party.' },
              },
              {
                id: 'faction_velvet_knife',
                name: 'Velvet Knife Cabal',
                description: 'Fractured cells trying to recover lost leverage.',
                disposition: -55,
                keyNpc: { name: 'Orin Sable', role: 'Broker', description: 'Retreating into covert operations.' },
              },
            ],
            events: [
              'Adventure #2 complete: The party broke the Cabal cipher ring and secured baronial support in Cinderwatch.',
              'New threat: Ashen warbands raid caravans on the Blackwater road.',
            ],
            alliedNpcs: [
              { name: 'Iri Dawnforge', role: 'Quartermaster', description: 'Expands supply caches for a coming siege.' },
              { name: 'Brother Tamsin', role: 'Healer', description: 'Treats survivors from frontier raids.' },
            ],
            centralVillain: {
              name: 'Duke Malrec Thorne',
              description: 'A warlord rallying desperate banner houses.',
              objective: 'Capture Cinderwatch before winter and force the crown vote.',
              lieutenants: [
                { name: 'Magister Vale', role: 'Arcanist', description: 'Strengthens fire wards around siege camps.' },
              ],
            },
            hubTown: {
              name: 'Cinderwatch',
              description: 'Now under curfew as refugees and scouts flood the gates.',
              locations: [
                {
                  name: 'The Brazen Cup',
                  description: 'Converted into a war council hall after dusk.',
                  shopkeeper: 'Nella Quay',
                  questGiver: 'Captain Mirel Voss',
                },
                {
                  name: 'Signal Tower',
                  description: 'New beacon watch tracking road raids.',
                  questGiver: 'Brother Tamsin',
                },
              ],
            },
            regionalMap: [
              { name: 'Cinderwatch', description: 'Fortified hub with new walls and checkpoints.' },
              { name: 'Blackwater Road', description: 'Ambush corridor patrolled by ashen warbands.' },
            ],
          },
          storyArcs: [
            {
              id: 'arc_ember_succession',
              name: 'Ember Succession',
              status: 'active',
              plotPoints: [
                {
                  id: 'plot_baron_support',
                  description: 'Secure support from two neutral barons.',
                  resolved: true,
                },
                {
                  id: 'plot_defend_cinderwatch',
                  description: 'Defend Cinderwatch from the first coordinated warband strike.',
                  resolved: false,
                },
              ],
            },
            {
              id: 'arc_blackwater_raids',
              name: 'Blackwater Raids',
              status: 'seeded',
              plotPoints: [
                {
                  id: 'plot_trace_raiders',
                  description: 'Trace the raiders to their new mustering camp.',
                  resolved: false,
                },
              ],
            },
          ],
          adventureCount: 2,
        },
      }),
    })
    const updateCampaignSpy = vi.spyOn(rpgCampaign, 'updateCampaign').mockImplementation(async (_db, id, patch) => {
      if (id !== campaign.id) return
      persistedCampaign = {
        ...persistedCampaign,
        ...(typeof (patch as any).premise === 'string' ? { premise: (patch as any).premise } : {}),
        ...((patch as any).worldState ? { worldState: JSON.parse(JSON.stringify((patch as any).worldState)) } : {}),
        ...((patch as any).storyArcs ? { storyArcs: JSON.parse(JSON.stringify((patch as any).storyArcs)) } : {}),
        ...(typeof (patch as any).adventureCount === 'number' ? { adventureCount: (patch as any).adventureCount } : {}),
      }
    })

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      env: { AI: { run: aiRun } },
    }
    const [tool] = getToolsForAgent(ctx as any, ['gm'])

    const result = await tool!.execute!('tc_advance_campaign', {
      command: 'advance_campaign',
      campaignId: campaign.id,
      adventureSummary:
        'Adventure #2: all heroes survived, the Ash Crypt was fully cleared, Cabal handlers were defeated, and the party chose to publicly ally with the Iron Lantern Compact.',
    })

    expect(aiRun).toHaveBeenCalledTimes(1)
    const aiArgs = aiRun.mock.calls[0]?.[1]
    expect(JSON.stringify(aiArgs)).toContain('Ashen Crown Requiem')
    expect(JSON.stringify(aiArgs)).toContain('Cabal handlers were defeated')

    expect(updateCampaignSpy).toHaveBeenCalledTimes(1)
    expect(updateCampaignSpy.mock.calls[0]?.[1]).toBe(campaign.id)
    expect(updateCampaignSpy.mock.calls[0]?.[2]).toMatchObject({
      premise: expect.stringContaining('rival powers escalate'),
      worldState: expect.objectContaining({
        factions: expect.arrayContaining([
          expect.objectContaining({ id: 'faction_iron_lantern', disposition: 35 }),
        ]),
      }),
      storyArcs: expect.arrayContaining([
        expect.objectContaining({ id: 'arc_blackwater_raids' }),
      ]),
      adventureCount: 2,
    })

    expect(getCampaignSpy).toHaveBeenCalledTimes(2)
    const updatedCampaign = await rpgCampaign.getCampaign(db as any, campaign.id)
    expect(updatedCampaign).toBeTruthy()
    expect(updatedCampaign!.worldState.factions.find((faction) => faction.id === 'faction_iron_lantern')?.disposition).toBe(35)
    expect(updatedCampaign!.worldState.hubTown?.description).toContain('curfew')
    expect(updatedCampaign!.worldState.events.at(-1)).toContain('Blackwater road')
    expect(updatedCampaign!.storyArcs.find((arc) => arc.id === 'arc_ember_succession')?.plotPoints[0]?.resolved).toBe(true)

    const text = Array.isArray((result as any)?.content) ? String((result as any).content[0]?.text ?? '') : ''
    expect(text).toContain('Cinderwatch hardens its defenses')

    const details = (result as any)?.details ?? {}
    expect(details.campaignId).toBe(campaign.id)
    expect(details.campaign).toBeTruthy()
    expect(details.campaign.worldState.hubTown.name).toBe('Cinderwatch')
  })
})
