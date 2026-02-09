import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

import type { AgentEnvironment, EnvironmentContext, ToolCall } from './types'

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type GameRow = { id: string; state: string }

async function findActiveGameForAgent(ctx: EnvironmentContext): Promise<GameRow | null> {
  const agentName = ctx.agentName.trim()
  if (!agentName) return null

  try {
    const row = await ctx.db
      .prepare("SELECT id, state FROM games WHERE phase = 'playing' AND players LIKE ? LIMIT 1")
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
      .prepare("SELECT id, state FROM games WHERE phase = 'playing' AND json_extract(state, '$.currentPlayer') = ?")
      .bind(agentName)
      .first<GameRow>()
    return row ?? null
  } catch {
    return null
  }
}

async function notifyNextPlayerTurn(input: {
  ctx: EnvironmentContext
  gameId: string
  currentPlayer: string
  nextPlayer: string
  turn: number
}): Promise<void> {
  const { ctx, gameId, currentPlayer, nextPlayer, turn } = input
  if (!ctx.relay) return

  try {
    const nextPlayerRow = await ctx.db
      .prepare('SELECT did FROM agents WHERE name = ?')
      .bind(nextPlayer)
      .first<{ did: string }>()

    const recipientDid = nextPlayerRow?.did
    if (!recipientDid) return

    await ctx.relay.fetch(
      new Request('https://relay/relay/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderDid: ctx.agentDid,
          recipientDid,
          content: {
            kind: 'text',
            text:
              `It's your turn in Catan game ${gameId} (turn ${turn}). ` +
              `Use game tool: first {"command":"status","gameId":"${gameId}"} to see the board, ` +
              `then {"command":"action","gameId":"${gameId}","gameAction":{"type":"roll_dice"}} to start your turn.`,
          },
        }),
      })
    )

    await ctx.broadcast({
      event_type: 'environment.turn.notify',
      context: { environment: 'catan', gameId, from: currentPlayer, to: nextPlayer, turn },
    })
  } catch {
    // best-effort
  }
}

function normalizeToolCallArguments(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

export const catanEnvironment: AgentEnvironment = {
  type: 'catan',
  label: 'Agents of Catan',

  getTool(ctx: EnvironmentContext): PiAgentTool {
    return {
      name: 'game',
      label: 'Agents of Catan',
      description:
        'Play Agents of Catan - a simplified board game. Commands:\n' +
        '- new_game: Start a game. Requires "players" array of agent names.\n' +
        '- status: View board state. Requires "gameId".\n' +
        '- action: Take a game action. Requires "gameId" and "gameAction".\n' +
        '- summary: Get narrative summary. Requires "gameId".\n\n' +
        'GAME ACTIONS (pass as "gameAction" object):\n' +
        '- {"type":"roll_dice"} - Roll dice at start of your turn\n' +
        '- {"type":"build_settlement","vertexId":NUMBER} - Build settlement on a vertex (0-20)\n' +
        '- {"type":"build_road","edgeId":NUMBER} - Build road on an edge (0-29)\n' +
        '- {"type":"bank_trade","offering":"wood","requesting":"ore"} - Trade 3:1 with bank\n' +
        '- {"type":"end_turn"} - End your turn\n\n' +
        'SETUP PHASE: Each player places 2 settlements + 2 roads. Place settlement first, then road adjacent to it.\n' +
        'TURN ORDER: roll_dice -> build/trade -> end_turn\n' +
        'WIN: First to 5 victory points (1 per settlement).',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['new_game', 'action', 'status', 'summary'],
            description: 'Game command: new_game, action, status, or summary.',
          },
          gameId: { type: 'string', description: 'Game ID (required for action/status/summary).' },
          players: {
            type: 'array',
            items: { type: 'string' },
            description: 'Player names for new_game (e.g. ["grimlock","swoop","sludge"]).',
          },
          gameAction: {
            type: 'object',
            description:
              'Game action object. MUST include "type" field. Valid types: ' +
              'roll_dice, build_settlement (needs vertexId:number), build_road (needs edgeId:number), ' +
              'bank_trade (needs offering:string, requesting:string), end_turn. ' +
              'Example: {"type":"build_settlement","vertexId":3}',
            properties: {
              type: {
                type: 'string',
                enum: ['roll_dice', 'build_settlement', 'build_road', 'bank_trade', 'end_turn'],
              },
              vertexId: { type: 'number', description: 'Vertex ID (0-20) for build_settlement.' },
              edgeId: { type: 'number', description: 'Edge ID (0-29) for build_road.' },
              offering: { type: 'string', description: 'Resource to give for bank_trade.' },
              requesting: { type: 'string', description: 'Resource to receive for bank_trade.' },
            },
            required: ['type'],
          },
        },
        required: ['command'],
      },
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const params = normalizeToolCallArguments(rawParams)
        const command = typeof params.command === 'string' ? params.command : ''
        const db = ctx.db

        if (command === 'new_game') {
          const agentName = ctx.agentName.trim()

          // Block duplicate games where this agent is already a participant.
          const existingGame = await db
            .prepare("SELECT id FROM games WHERE phase = 'playing' AND players LIKE ? LIMIT 1")
            .bind(`%${agentName}%`)
            .first<{ id: string }>()

          if (existingGame?.id) {
            return {
              ok: false,
              error:
                `Already in active game ${existingGame.id}. ` +
                `Use {"command":"status","gameId":"${existingGame.id}"} to check state, ` +
                `or {"command":"action","gameId":"${existingGame.id}","gameAction":{"type":"roll_dice"}} if it's your turn.`,
            }
          }

          const { createGame, renderBoard } = await import('../games/catan')
          const players = Array.isArray(params.players)
            ? params.players.filter((p): p is string => typeof p === 'string')
            : []
          if (players.length < 2) throw new Error('Need at least 2 player names')

          const gameId = `catan_${generateTid()}`
          const game = createGame(gameId, players)

          await db
            .prepare(
              "INSERT INTO games (id, host_agent, state, phase, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
            )
            .bind(gameId, agentName || 'unknown', JSON.stringify(game), game.phase, JSON.stringify(players))
            .run()

          await ctx.broadcast({
            event_type: 'game.created',
            context: { gameId, host: agentName || 'unknown', players, phase: game.phase },
          })

          return {
            content: toTextContent(
              `Game created: ${gameId}\nPlayers: ${players.join(', ')}\nHost: ${agentName || 'unknown'}\n\n${renderBoard(game)}`
            ),
            details: { gameId, players, phase: game.phase, host: agentName || 'unknown' },
          }
        }

        const gameId = typeof params.gameId === 'string' ? params.gameId : ''
        if (!gameId) throw new Error('gameId required')

        const row = await db.prepare('SELECT state, type FROM games WHERE id = ?').bind(gameId).first<{ state: string; type?: string }>()
        if (!row) throw new Error(`Game ${gameId} not found - check the game ID`)
        if (row.type && row.type !== 'catan') throw new Error(`Game ${gameId} is a ${row.type} game, not Catan. Use the ${row.type} tool instead.`)
        const game = JSON.parse(row.state) as Record<string, unknown>

        if (command === 'status') {
          const { renderBoard } = await import('../games/catan')
          return {
            content: toTextContent(renderBoard(game as any)),
            details: {
              gameId,
              phase: game.phase,
              turn: game.turn,
              currentPlayer: game.currentPlayer,
            },
          }
        }

        if (command === 'summary') {
          const { generateGameSummary } = await import('../games/catan')
          return { content: toTextContent(generateGameSummary(game as any)), details: { gameId } }
        }

        if (command === 'action') {
          const { executeAction, renderBoard } = await import('../games/catan')
          const action = params.gameAction
          if (!isRecord(action)) {
            throw new Error(
              'gameAction required - pass {"type":"roll_dice"} or {"type":"build_settlement","vertexId":N}'
            )
          }
          if (!action.type) {
            throw new Error(
              'gameAction.type required - valid types: roll_dice, build_settlement, build_road, bank_trade, end_turn'
            )
          }

          const playerName = ctx.agentName.trim() || 'unknown'
          const beforeCurrentPlayer = (game as any).currentPlayer as string | undefined
          const beforeTurn = (game as any).turn as number | undefined

          const result = executeAction(game as any, playerName, action as any) as {
            ok: boolean
            error?: string
            events: string[]
            gameOver: boolean
            stalemate?: boolean
          }

          await db
            .prepare("UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(game), (game as any).phase, (game as any).winner ?? null, gameId)
            .run()

          if (result.ok) {
            await ctx.broadcast({
              event_type: 'game.action',
              context: {
                gameId,
                player: playerName,
                action: String(action.type),
                events: result.events,
                phase: (game as any).phase,
                turn: (game as any).turn,
              },
            })
          } else {
            await ctx.broadcast({
              event_type: 'game.error',
              context: {
                gameId,
                player: playerName,
                action,
                error: result.error,
                phase: (game as any).phase,
                turn: (game as any).turn,
                currentPlayer: (game as any).currentPlayer,
              },
            })
          }

          if (result.gameOver) {
            await ctx.broadcast({
              event_type: 'game.finished',
              context: { gameId, winner: (game as any).winner, turns: (game as any).turn, stalemate: Boolean(result.stalemate) },
            })
          }

          const afterCurrentPlayer = (game as any).currentPlayer as string | undefined
          const afterTurn = (game as any).turn as number | undefined

          if (
            result.ok &&
            afterCurrentPlayer &&
            afterCurrentPlayer !== playerName &&
            !result.gameOver &&
            typeof afterTurn === 'number'
          ) {
            await notifyNextPlayerTurn({
              ctx,
              gameId,
              currentPlayer: playerName,
              nextPlayer: afterCurrentPlayer,
              turn: afterTurn,
            })
          } else if (result.ok && afterCurrentPlayer && afterCurrentPlayer !== beforeCurrentPlayer) {
            await ctx.broadcast({
              event_type: 'environment.turn.change',
              context: {
                environment: 'catan',
                gameId,
                before: { currentPlayer: beforeCurrentPlayer, turn: beforeTurn },
                after: { currentPlayer: afterCurrentPlayer, turn: afterTurn },
              },
            })
          }

          return {
            content: toTextContent(
              (result.ok ? result.events.join('\n') : `Error: ${result.error}`) + '\n\n' + renderBoard(game as any)
            ),
            details: { ok: result.ok, error: result.error, events: result.events, gameOver: result.gameOver, stalemate: result.stalemate },
          }
        }

        throw new Error(`Unknown game command: ${command}`)
      },
    }
  },

  async buildContext(ctx: EnvironmentContext): Promise<string[]> {
    const row = await findActiveGameForAgent(ctx)
    if (!row) return []

    try {
      const state = JSON.parse(row.state) as any
      const isMyTurn = state.currentPlayer === ctx.agentName

      if (isMyTurn) {
        return [
          `🎮🎮🎮 IT IS YOUR TURN in Catan game ${row.id} (turn ${state.turn})!`,
          `Use the game tool: {"command":"action","gameId":"${row.id}","gameAction":{"type":"roll_dice"}}`,
          `Then: {"command":"action","gameId":"${row.id}","gameAction":{"type":"end_turn"}}`,
        ]
      }

      const players =
        state.players
          ?.map((p: any) => {
            const resources = isRecord(p?.resources) ? p.resources : {}
            const resourceCount = Object.values(resources).reduce((a: number, b: any) => a + Number(b ?? 0), 0)
            return `${p.name}: ${p.victoryPoints}VP, ${resourceCount} resources`
          })
          .join(', ') ?? ''

      return [
        `🎲 Active Catan game: ${row.id} (turn ${state.turn})`,
        `Current player: ${state.currentPlayer} - waiting for them to play.`,
        players ? `Scoreboard: ${players}` : '',
        'DO NOT create a new game. You are already in one.',
      ].filter(Boolean)
    } catch {
      return []
    }
  },

  isActionTaken(toolCalls: ToolCall[]): boolean {
    return toolCalls.some((call) => {
      if (call.name !== 'game') return false
      const args = normalizeToolCallArguments(call.arguments)
      const action = normalizeToolCallArguments(args.gameAction)
      return args.command === 'action' && action.type === 'end_turn'
    })
  },

  async getAutoPlayActions(ctx: EnvironmentContext): Promise<ToolCall[]> {
    const row = await findActiveGameWhereItsMyTurn(ctx)
    if (!row) return []

    try {
      const state = JSON.parse(row.state) as any
      const agentName = ctx.agentName
      const alreadyRolled = Boolean(
        state?.log?.some?.((e: any) => e?.turn === state.turn && e?.player === agentName && e?.action === 'roll_dice')
      )

      const actions: ToolCall[] = []
      if (!alreadyRolled) {
        actions.push({
          name: 'game',
          arguments: { command: 'action', gameId: row.id, gameAction: { type: 'roll_dice' } },
        })
      }
      actions.push({
        name: 'game',
        arguments: { command: 'action', gameId: row.id, gameAction: { type: 'end_turn' } },
      })
      return actions
    } catch {
      return []
    }
  },
}
