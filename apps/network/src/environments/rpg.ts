import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

import {
  attack,
  createCharacter,
  createDice,
  createGame,
  explore,
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
            enum: ['new_game', 'create_character', 'explore', 'attack', 'cast_spell', 'use_skill', 'rest', 'status'],
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
            ? params.players.filter((p): p is string => typeof p === 'string' && p.trim())
            : []
          if (players.length < 1) throw new Error('Need at least 1 player')

          const gameId = `rpg_${generateTid()}`
          const game = createGame({ id: gameId, players })

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

              if (game.combat.enemies.every((e) => e.hp <= 0)) {
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
    if (!row) return []

    try {
      const game = JSON.parse(row.state) as RpgGameState
      const room = game.dungeon[game.roomIndex]
      const isMyTurn = game.currentPlayer === ctx.agentName

      const lines: string[] = []
      if (isMyTurn) {
        lines.push(`🏰 IT IS YOUR TURN in Dungeon Crawl ${row.id}!`)
        lines.push(`Mode: ${game.mode} | Room ${game.roomIndex + 1}/${game.dungeon.length}: ${room?.type ?? 'unknown'}`)
        if (room?.description) lines.push(room.description)
        lines.push(`Party: ${summarizeParty(game)}`)
        lines.push('Suggested actions:')
        if (game.mode === 'combat') {
          lines.push(`- {"command":"attack","gameId":"${row.id}"}`)
        } else {
          lines.push(`- {"command":"explore","gameId":"${row.id}"}`)
        }
      } else {
        lines.push(`🏰 Active Dungeon Crawl: ${row.id}`)
        lines.push(`Current player: ${game.currentPlayer} | Mode: ${game.mode}`)
        lines.push(`Party: ${summarizeParty(game)}`)
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
      return ['explore', 'attack', 'cast_spell', 'use_skill', 'rest', 'create_character'].includes(cmd)
    })
  },

  async getAutoPlayActions(ctx: EnvironmentContext): Promise<ToolCall[]> {
    const row = await findActiveGameWhereItsMyTurn(ctx)
    if (!row) return []

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
