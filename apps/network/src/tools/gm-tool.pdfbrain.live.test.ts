import { describe, expect, it } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { createGame, type RpgGameState } from '../games/rpg-engine'
import { getToolsForAgent } from './index'

async function insertRpgGame(db: D1Database, game: RpgGameState, players: string[]): Promise<void> {
  await db
    .prepare(
      "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    )
    .bind(game.id, 'rpg', players[0] ?? 'unknown', JSON.stringify(game), game.phase, JSON.stringify(players))
    .run()
}

describe.runIf(Boolean(process.env.GRIMLOCK_WEBHOOK_URL))('gm tool consult_library (live pdf-brain)', () => {
  it('queries pdf-brain via webhook and returns text', async () => {
    const webhookUrl = String(process.env.GRIMLOCK_WEBHOOK_URL)

    const db = new D1MockDatabase()
    const broadcast = async () => {}

    const game = createGame({
      id: 'rpg_gm_consult_library_live',
      players: ['grimlock'],
      dungeon: [{ type: 'rest', description: 'start' }],
    })
    await insertRpgGame(db as any, game, ['grimlock'])

    const ctx = {
      agentName: 'grimlock',
      agentDid: 'did:cf:grimlock',
      db: db as any,
      broadcast,
      webhookUrl,
    }

    const [tool] = getToolsForAgent(ctx as any, ['gm'])
    const result = await tool!.execute!('tc_consult_live', { command: 'consult_library', gameId: game.id, query: 'BRP opposed roll mechanics' })

    const text = Array.isArray((result as any)?.content) ? String((result as any).content[0]?.text ?? '') : ''
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)
})

