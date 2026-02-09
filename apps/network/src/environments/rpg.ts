import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

import {
  attack,
  createCharacter,
  createDice,
  createGame,
  explore,
  partyWipe,
  resolveSkillCheck,
  soloMultiplier,
  type RpgClass,
  type RpgGameState,
} from '../games/rpg-engine'

import type { AgentEnvironment, EnvironmentContext, ToolCall } from './types'

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeToolCallArguments(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

type GameRow = { id: string; state: string; type?: string | null }

async function findActiveGameForAgent(ctx: EnvironmentContext): Promise<GameRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const row = await ctx.db
      .prepare("SELECT id, state, type FROM games WHERE type = 'rpg' AND phase = 'playing' AND players LIKE ? LIMIT 1")
      .bind(`%${agentName}%`)
      .first<GameRow>()
    return row ?? null
  } catch {
    return null
  }
}

async function findActiveGameWhereItsMyTurn(ctx: EnvironmentContext): Promise<GameRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const row = await ctx.db
      .prepare(
        "SELECT id, state, type FROM games WHERE type = 'rpg' AND phase = 'playing' AND json_extract(state, '$.currentPlayer') = ?"
      )
      .bind(agentName)
      .first<GameRow>()
    return row ?? null
  } catch {
    return null
  }
}

function summarizeParty(game: RpgGameState): string {
  return game.party
    .map((p) => `${p.name}(${p.klass}) HP ${p.hp}/${p.maxHp} MP ${p.mp}/${p.maxMp}`)
    .join(' | ')
}

function pickJoinClass(game: RpgGameState): RpgClass {
  const counts = new Map<RpgClass, number>([
    ['Warrior', 0],
    ['Scout', 0],
    ['Mage', 0],
    ['Healer', 0],
  ])
  for (const member of game.party) {
    counts.set(member.klass, (counts.get(member.klass) ?? 0) + 1)
  }

  let best: RpgClass = 'Warrior'
  let bestCount = Number.POSITIVE_INFINITY
  for (const klass of ['Warrior', 'Scout', 'Mage', 'Healer'] as const) {
    const count = counts.get(klass) ?? 0
    if (count < bestCount) {
      best = klass
      bestCount = count
    }
  }
  return best
}

async function findJoinableGamesForAgent(
  ctx: EnvironmentContext,
  input: { limit?: number }
): Promise<Array<{ id: string; game: RpgGameState }>> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return []

  try {
    const { results } = await ctx.db
      .prepare("SELECT id, state FROM games WHERE type = 'rpg' AND phase = 'playing' ORDER BY updated_at DESC")
      .all<GameRow>()

    const joinable: Array<{ id: string; game: RpgGameState }> = []
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)))

    for (const row of results) {
      if (!row?.id || typeof row.state !== 'string') continue
      try {
        const game = JSON.parse(row.state) as RpgGameState
        if (!game || game.type !== 'rpg') continue
        if (Array.isArray(game.party) && game.party.some((p) => p?.name === agentName)) continue
        if (!Array.isArray(game.party) || game.party.length >= 3) continue
        joinable.push({ id: row.id, game })
        if (joinable.length >= limit) break
      } catch {
        // ignore corrupt state rows
      }
    }

    return joinable
  } catch {
    return []
  }
}

function recomputeTurnOrder(game: RpgGameState): void {
  game.turnOrder = [...game.party].sort((a, b) => {
    const dex = b.stats.DEX - a.stats.DEX
    if (dex !== 0) return dex
    return a.name.localeCompare(b.name)
  })
  if (!game.currentPlayer || !game.party.some((p) => p.name === game.currentPlayer)) {
    game.currentPlayer = game.turnOrder[0]?.name ?? game.party[0]?.name ?? 'unknown'
  }
}

export const rpgEnvironment: AgentEnvironment = {
  type: 'rpg',
  label: 'Dungeon Crawl',

  getTool(ctx: EnvironmentContext): PiAgentTool {
    return {
      name: 'rpg',
      label: 'Dungeon Crawl',
      description:
        'BRP-inspired party dungeon crawl. Commands:\n' +
        '- new_game: Start an adventure (requires players array)\n' +
        '- join_game: Join an open adventure (requires gameId + klass)\n' +
        '- create_character: Create/update your character (requires klass)\n' +
        '- explore: Move to the next room\n' +
        '- attack: Attack (in combat attacks first enemy; otherwise attacks a party member if defender provided)\n' +
        '- cast_spell: Cast a spell (stub)\n' +
        '- use_skill: Attempt a generic skill check\n' +
        '- rest: Recover some HP/MP\n' +
        '- status: Show game state\n',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: [
              'new_game',
              'join_game',
              'create_character',
              'explore',
              'attack',
              'cast_spell',
              'use_skill',
              'rest',
              'status',
            ],
          },
          gameId: { type: 'string', description: 'Game ID (optional; defaults to your active adventure).' },
          players: { type: 'array', items: { type: 'string' }, description: 'Players for new_game.' },
          klass: { type: 'string', enum: ['Warrior', 'Scout', 'Mage', 'Healer'], description: 'Class for create_character.' },
          defender: { type: 'string', description: 'Party member to attack (out of combat only).' },
          spell: { type: 'string', description: 'Spell name for cast_spell.' },
          skill: { type: 'string', description: 'Skill name for use_skill (defaults to use_skill).' },
        },
        required: ['command'],
      },
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const params = normalizeToolCallArguments(rawParams)
        const command = typeof params.command === 'string' ? params.command : ''
        const db = ctx.db
        const dice = createDice()

        if (command === 'join_game') {
          const gameId = typeof params.gameId === 'string' ? params.gameId.trim() : ''
          if (!gameId) throw new Error('gameId required for join_game')

          const klass = typeof params.klass === 'string' ? (params.klass as RpgClass) : null
          if (!klass || !['Warrior', 'Scout', 'Mage', 'Healer'].includes(klass)) {
            throw new Error('klass required: Warrior | Scout | Mage | Healer')
          }

          const row = await db
            .prepare("SELECT state FROM games WHERE id = ? AND type = 'rpg'")
            .bind(gameId)
            .first<{ state: string }>()

          if (!row) throw new Error(`Adventure ${gameId} not found`)

          const game = JSON.parse(row.state) as RpgGameState
          if (game.phase !== 'playing') {
            return { ok: false, error: `Adventure ${gameId} is not joinable (phase: ${game.phase})` }
          }

          if (!Array.isArray(game.party) || game.party.length >= 3) {
            return { ok: false, error: `Adventure ${gameId} party is full` }
          }

          const agentName = ctx.agentName.trim() || 'unknown'
          if (game.party.some((p) => p.name === agentName)) {
            return { ok: false, error: `Already in active adventure ${gameId}.` }
          }

          const joined = createCharacter({ name: agentName, klass })
          game.party.push(joined)
          recomputeTurnOrder(game)

          const players = game.party.map((p) => p.name)

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, players = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, JSON.stringify(players), gameId)
            .run()

          await ctx.broadcast({
            event_type: 'environment.joined',
            context: { environment: 'rpg', gameId, agent: agentName, klass },
          })

          return {
            content: toTextContent(`Joined adventure: ${gameId} as ${agentName} the ${klass}\nParty: ${summarizeParty(game)}`),
            details: { gameId, joined },
          }
        }

        if (command === 'new_game') {
          const agentName = ctx.agentName.trim()

          const existing = await db
            .prepare("SELECT id FROM games WHERE type = 'rpg' AND phase = 'playing' AND players LIKE ? LIMIT 1")
            .bind(`%${agentName}%`)
            .first<{ id: string }>()
            .catch(() => null)

          if (existing?.id) {
            return {
              ok: false,
              error:
                `Already in active adventure ${existing.id}. ` +
                `Use {"command":"status","gameId":"${existing.id}"} to check state.`,
            }
          }

          const players = Array.isArray(params.players)
            ? params.players.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : []
          if (players.length < 1) throw new Error('Need at least 1 player')

          // Prefer joining an open adventure when a solo new_game is requested.
          if (players.length <= 1) {
            const joinable = await findJoinableGamesForAgent(ctx, { limit: 5 })
            if (joinable.length > 0) {
              const lines: string[] = []
              lines.push('Open adventures are looking for party members:')
              for (const candidate of joinable) {
                const recommended = pickJoinClass(candidate.game)
                lines.push(
                  `- ${candidate.id}: Party: ${summarizeParty(candidate.game)} | Join with {"command":"join_game","gameId":"${candidate.id}","klass":"${recommended}"}`
                )
              }
              return { ok: false, error: lines.join('\n') }
            }
          }

          const gameId = `rpg_${generateTid()}`
          const game = createGame({ id: gameId, players })

          // Ensure type column exists (migration from catan-only schema)
          await db.prepare("ALTER TABLE games ADD COLUMN type TEXT DEFAULT 'catan'").run().catch(() => {/* already exists */})

          await db
            .prepare(
              "INSERT INTO games (id, type, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
            )
            .bind(gameId, 'rpg', ctx.agentName.trim() || 'unknown', JSON.stringify(game), game.phase, JSON.stringify(players))
            .run()

          await ctx.broadcast({
            event_type: 'environment.created',
            context: { environment: 'rpg', gameId, host: ctx.agentName.trim() || 'unknown', players },
          })

          return {
            content: toTextContent(
              `Adventure created: ${gameId}\nPlayers: ${players.join(', ')}\n\n` +
                `Room 1/${game.dungeon.length}: ${game.dungeon[0]?.description ?? ''}`
            ),
            details: { gameId, type: 'rpg', players, phase: game.phase },
          }
        }

        // Resolve gameId (explicit or active)
        let gameId = typeof params.gameId === 'string' ? params.gameId : ''
        if (!gameId) {
          const row = await findActiveGameForAgent(ctx)
          if (!row) throw new Error('No active adventure. Use command new_game first.')
          gameId = row.id
        }

        const row = await db
          .prepare("SELECT state FROM games WHERE id = ? AND type = 'rpg'")
          .bind(gameId)
          .first<{ state: string }>()

        if (!row) throw new Error(`Adventure ${gameId} not found`)

        const game = JSON.parse(row.state) as RpgGameState

        if (command === 'status') {
          const room = game.dungeon[game.roomIndex]
          return {
            content: toTextContent(
              `Adventure: ${gameId}\n` +
                `Mode: ${game.mode} | Phase: ${game.phase}\n` +
                `Room ${game.roomIndex + 1}/${game.dungeon.length}: ${room?.type ?? 'unknown'}\n` +
                `${room?.description ?? ''}\n\n` +
                `Current player: ${game.currentPlayer}\n` +
                `Party: ${summarizeParty(game)}`
            ),
            details: {
              gameId,
              mode: game.mode,
              phase: game.phase,
              roomIndex: game.roomIndex,
              currentPlayer: game.currentPlayer,
            },
          }
        }

        if (command === 'create_character') {
          const klass = typeof params.klass === 'string' ? (params.klass as RpgClass) : null
          if (!klass || !['Warrior', 'Scout', 'Mage', 'Healer'].includes(klass)) {
            throw new Error('klass required: Warrior | Scout | Mage | Healer')
          }

          const agentName = ctx.agentName.trim() || 'unknown'
          const existing = game.party.find((p) => p.name === agentName)
          const updated = createCharacter({ name: agentName, klass })
          if (existing) {
            Object.assign(existing, updated)
          } else {
            game.party.push(updated)
          }
          recomputeTurnOrder(game)

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`Character ready: ${agentName} the ${klass}\nParty: ${summarizeParty(game)}`),
            details: { gameId, character: updated },
          }
        }

        if (command === 'explore') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          const beforePhase = game.phase
          const result = explore(game, { dice })

          // advance turn
          recomputeTurnOrder(game)
          const idx = Math.max(0, game.turnOrder.findIndex((p) => p.name === game.currentPlayer))
          const next = game.turnOrder[(idx + 1) % Math.max(1, game.turnOrder.length)]
          game.currentPlayer = next?.name ?? game.currentPlayer

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          if (beforePhase !== 'finished' && game.phase === 'finished') {
            const turns = typeof (game as any).turn === 'number' ? (game as any).turn : game.roomIndex + 1
            const summary = {
              gameId,
              type: 'rpg' as const,
              winner: (game as any).winner ?? null,
              turns,
              players: Array.isArray(game.party) ? game.party.map((p) => ({ name: p.name, vp: p.hp })) : [],
            }
            console.log(JSON.stringify({ event_type: 'game.completed', level: 'info', ...summary }))
          }

          return {
            content: toTextContent(
              result.room
                ? `You enter: ${result.room.type}\n${result.room.description}\n\nParty: ${summarizeParty(game)}`
                : 'The adventure is complete.'
            ),
            details: { gameId, room: result.room, mode: game.mode },
          }
        }

        if (command === 'attack') {
          if (game.currentPlayer !== ctx.agentName.trim()) {
            return { ok: false, error: `Not your turn. Current player: ${game.currentPlayer}` }
          }

          // In combat, attack the first enemy.
          if (game.mode === 'combat' && game.combat?.enemies?.length) {
            const enemy = game.combat.enemies.find((e) => e.hp > 0)
            if (!enemy) {
              game.mode = 'exploring'
              game.combat = undefined
            } else {
              // Inline enemy resolution to avoid bloating the engine API.
              const attackerName = ctx.agentName.trim() || 'unknown'
              const attacker = game.party.find((p) => p.name === attackerName)
              if (!attacker) throw new Error('Create your character before attacking')

              const atk = resolveSkillCheck({ skill: attacker.skills.attack, dice })
              const dod = resolveSkillCheck({ skill: enemy.dodge, dice })
              const atkMargin = atk.success ? attacker.skills.attack - atk.roll : -Infinity
              const dodMargin = dod.success ? enemy.dodge - dod.roll : -Infinity
              const hit = atk.success && (!dod.success || atkMargin > dodMargin)

              let text = ''
              if (hit) {
                const dmg = dice.d(6) + Math.floor(attacker.stats.STR / 25)
                enemy.hp = Math.max(0, enemy.hp - dmg)
                attacker.skills.attack = atk.nextSkill
                text = `You strike the ${enemy.name} for ${dmg}. (${enemy.hp} HP left)`
              } else {
                text = `The ${enemy.name} avoids your attack.`
              }

              if (enemy.hp > 0 && game.phase === 'playing') {
                const counterAtk = resolveSkillCheck({ skill: enemy.attack, dice })
                const counterDod = resolveSkillCheck({ skill: attacker.skills.dodge, dice })
                const atkMargin = counterAtk.success ? enemy.attack - counterAtk.roll : -Infinity
                const dodMargin = counterDod.success ? attacker.skills.dodge - counterDod.roll : -Infinity
                const counterHit = counterAtk.success && (!counterDod.success || atkMargin > dodMargin)

                if (counterHit) {
                  const raw = dice.d(6)
                  const dmg = Math.max(0, Math.floor(raw * soloMultiplier(game.party.length)))
                  attacker.hp = Math.max(0, attacker.hp - dmg)
                  text += `\nThe ${enemy.name} counter-attacks for ${dmg}. (HP ${attacker.hp}/${attacker.maxHp})`
                  partyWipe(game)
                } else {
                  text += `\nThe ${enemy.name} counter-attacks but misses.`
                }
              }

              if (game.phase === 'playing' && game.combat?.enemies?.every((e) => e.hp <= 0)) {
                game.mode = 'exploring'
                game.combat = undefined
                text += '\nCombat ends.'
              }

              await db
                .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
                .run()

              // advance turn
              recomputeTurnOrder(game)
              const idx = Math.max(0, game.turnOrder.findIndex((p) => p.name === game.currentPlayer))
              const next = game.turnOrder[(idx + 1) % Math.max(1, game.turnOrder.length)]
              game.currentPlayer = next?.name ?? game.currentPlayer

              return { content: toTextContent(`${text}\n\nParty: ${summarizeParty(game)}`), details: { gameId } }
            }
          }

          const defender = typeof params.defender === 'string' ? params.defender.trim() : ''
          if (!defender) throw new Error('defender required when not in combat')

          const result = attack(game, { attacker: ctx.agentName.trim() || 'unknown', defender, dice })

          // advance turn
          recomputeTurnOrder(game)
          const idx = Math.max(0, game.turnOrder.findIndex((p) => p.name === game.currentPlayer))
          const next = game.turnOrder[(idx + 1) % Math.max(1, game.turnOrder.length)]
          game.currentPlayer = next?.name ?? game.currentPlayer

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`${result.detail}.\nParty: ${summarizeParty(game)}`),
            details: { gameId, hit: result.hit },
          }
        }

        if (command === 'rest') {
          const actor = game.party.find((p) => p.name === (ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before resting')

          actor.hp = Math.min(actor.maxHp, actor.hp + 2)
          actor.mp = Math.min(actor.maxMp, actor.mp + 1)

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`You rest. HP ${actor.hp}/${actor.maxHp} MP ${actor.mp}/${actor.maxMp}`),
            details: { gameId },
          }
        }

        if (command === 'use_skill') {
          const actor = game.party.find((p) => p.name === (ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before using skills')

          const skillName = typeof params.skill === 'string' ? params.skill : 'use_skill'
          if (!isRecord(actor.skills) || typeof (actor.skills as any)[skillName] !== 'number') {
            return { ok: false, error: `Unknown skill: ${skillName}` }
          }

          const current = Number((actor.skills as any)[skillName])
          const check = resolveSkillCheck({ skill: current, dice })
          if (check.success) {
            ;(actor.skills as any)[skillName] = check.nextSkill
          }

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(
              `${check.success ? 'Success' : 'Fail'} (rolled ${check.roll} vs ${current}).` +
                (check.success ? ` Skill improves to ${check.nextSkill}.` : '')
            ),
            details: { gameId, skill: skillName, roll: check.roll, success: check.success, nextSkill: check.nextSkill },
          }
        }

        if (command === 'cast_spell') {
          const actor = game.party.find((p) => p.name === (ctx.agentName.trim() || 'unknown'))
          if (!actor) throw new Error('Create your character before casting')

          const spell = typeof params.spell === 'string' ? params.spell.trim() : 'spell'
          if (actor.mp <= 0) return { ok: false, error: 'Out of MP' }
          actor.mp -= 1

          const check = resolveSkillCheck({ skill: actor.skills.cast_spell, dice })
          if (check.success) actor.skills.cast_spell = check.nextSkill

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), game.phase, (game as any).winner ?? null, gameId)
            .run()

          return {
            content: toTextContent(`${check.success ? 'Spell succeeds' : 'Spell fizzles'}: ${spell}`),
            details: { gameId, spell, success: check.success, roll: check.roll },
          }
        }

        throw new Error(`Unknown rpg command: ${command}`)
      },
    }
  },

  async buildContext(ctx: EnvironmentContext): Promise<string[]> {
    const row = await findActiveGameForAgent(ctx)
    if (!row) {
      const joinable = await findJoinableGamesForAgent(ctx, { limit: 5 })
      if (joinable.length === 0) return []

      const lines: string[] = []
      lines.push('🏰 Joinable Dungeon Crawls:')
      for (const candidate of joinable) {
        const recommended = pickJoinClass(candidate.game)
        lines.push(`- ${candidate.id}: Party: ${summarizeParty(candidate.game)} | Current: ${candidate.game.currentPlayer}`)
        lines.push(`  Join: {"command":"join_game","gameId":"${candidate.id}","klass":"${recommended}"}`)
      }
      return lines.filter(Boolean)
    }

    try {
      const game = JSON.parse(row.state) as RpgGameState
      const room = game.dungeon[game.roomIndex]
      const isMyTurn = game.currentPlayer === ctx.agentName
      const partyMember = game.party?.find((p: any) => p.name === ctx.agentName)

      // Barrier detection: if room requires a class nobody has, prompt recruitment
      const blockedRecruitment = (() => {
        if (!room || typeof room !== 'object') return ''
        const r = room as { type?: unknown; requiredClass?: unknown }
        if (r.type !== 'barrier') return ''
        const requiredClass = typeof r.requiredClass === 'string' ? r.requiredClass : ''
        if (!requiredClass) return ''
        const party = Array.isArray(game.party) ? game.party : []
        const hasClass = party.some((p: any) => p?.klass === requiredClass)
        if (hasClass) return ''
        return `URGENT: Recruit ${requiredClass} via message tool`
      })()

      const cooperationRules = [
        'COOPERATION RULES:',
        '- never solo: join parties',
        '- healers heal',
        '- warriors taunt',
        '- scouts disarm',
        '- mages AoE',
      ].join('\n')

      const lines: string[] = []
      if (isMyTurn) {
        lines.push(`🎮🎮🎮 IT IS YOUR TURN in RPG adventure ${row.id}!`)
        if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(cooperationRules)
        lines.push('')
        lines.push(`Use the rpg tool to act: rpg({"command":"explore","gameId":"${row.id}"}) or rpg({"command":"status","gameId":"${row.id}"})`)
        lines.push(`DO NOT create a new game.`)
      } else {
        lines.push(`🎲 Active RPG adventure: ${row.id} — waiting for ${game.currentPlayer}.`)
        if (partyMember) lines.push(`You are ${partyMember.name} the ${partyMember.klass} (HP: ${partyMember.hp}/${partyMember.maxHp})`)
        if (room) lines.push(`Current room: ${room.description ?? ''} (type: ${room.type})`)
        if (blockedRecruitment) lines.push(blockedRecruitment)
        lines.push(cooperationRules)
        lines.push('Wait for your turn.')
        lines.push(`DO NOT create a new game.`)
      }

      return lines.filter(Boolean)
    } catch {
      return []
    }
  },

  isActionTaken(toolCalls: ToolCall[]): boolean {
    return toolCalls.some((call) => {
      if (call.name !== 'rpg') return false
      const args = normalizeToolCallArguments(call.arguments)
      const cmd = typeof args.command === 'string' ? args.command : ''
      return ['join_game', 'explore', 'attack', 'cast_spell', 'use_skill', 'rest', 'create_character'].includes(cmd)
    })
  },

  async getAutoPlayActions(ctx: EnvironmentContext): Promise<ToolCall[]> {
    const row = await findActiveGameWhereItsMyTurn(ctx)
    if (!row) {
      const active = await findActiveGameForAgent(ctx)
      if (active) return []

      const joinable = await findJoinableGamesForAgent(ctx, { limit: 1 })
      if (joinable.length === 0) return []

      const candidate = joinable[0]!
      const klass = pickJoinClass(candidate.game)
      return [{ name: 'rpg', arguments: { command: 'join_game', gameId: candidate.id, klass } }]
    }

    try {
      const state = JSON.parse(row.state) as RpgGameState
      if (state.mode === 'combat') {
        return [{ name: 'rpg', arguments: { command: 'attack', gameId: row.id } }]
      }
      if (state.mode === 'exploring') {
        return [{ name: 'rpg', arguments: { command: 'explore', gameId: row.id } }]
      }
      return []
    } catch {
      return []
    }
  },
}
