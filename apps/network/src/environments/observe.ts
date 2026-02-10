import type { PiAgentTool } from '@atproto-agent/agent'
import type { AgentEnvironment, EnvironmentContext, ToolCall } from './types'

function toTextContent(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

type GameRow = {
  id: string
  type: string | null
  phase: string
  host_agent: string
  players: string
  winner: string | null
  created_at: string
  updated_at: string
}

type AgentRow = {
  did: string
  name: string
  handle: string | null
  registered_at: string
}

export const observeEnvironment: AgentEnvironment = {
  type: 'observe',
  label: 'Network Observer',

  getTool(ctx: EnvironmentContext): PiAgentTool {
    return {
      name: 'observe',
      description:
        'Observe the agent network. Commands:\n' +
        '- network_status: Overview of all agents, active games, and recent activity\n' +
        '- game_history: Recent game outcomes (wins, wipes, durations)\n' +
        '- agent_activity: Activity summary for a specific agent\n' +
        '- report: Submit an improvement idea or bug report (stored for Grimlock to review)',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['network_status', 'game_history', 'agent_activity', 'report'],
            description: 'Observation command',
          },
          agent_name: {
            type: 'string',
            description: 'Agent name for agent_activity command',
          },
          text: {
            type: 'string',
            description: 'Report text for report command (improvement idea, bug, observation)',
          },
          category: {
            type: 'string',
            enum: ['bug', 'improvement', 'observation', 'performance'],
            description: 'Report category',
          },
        },
        required: ['command'],
      },
      async execute(
        _toolCallId: string,
        rawParams: unknown
      ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
        const args = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {} as Record<string, unknown>
        const command = String(args.command || 'network_status')

        if (command === 'network_status') {
          // Get all registered agents
          const agents = await ctx.db
            .prepare('SELECT did, name, handle, registered_at FROM agents ORDER BY name')
            .all<AgentRow>()

          // Get active games
          const activeGames = await ctx.db
            .prepare("SELECT id, type, phase, host_agent, players, created_at FROM games WHERE phase = 'playing' ORDER BY created_at DESC LIMIT 10")
            .all<GameRow>()

          // Get recently finished games (last 24h)
          const recentGames = await ctx.db
            .prepare("SELECT id, type, phase, host_agent, players, winner, created_at, updated_at FROM games WHERE phase = 'finished' ORDER BY updated_at DESC LIMIT 10")
            .all<GameRow>()

          // Get game counts by type and phase
          const gameCounts = await ctx.db
            .prepare("SELECT type, phase, COUNT(*) as count FROM games GROUP BY type, phase ORDER BY type, phase")
            .all<{ type: string; phase: string; count: number }>()

          const lines: string[] = ['=== NETWORK STATUS ===', '']

          lines.push(`Registered agents: ${agents.results?.length ?? 0}`)
          for (const a of agents.results ?? []) {
            lines.push(`  - ${a.name} (${a.did.slice(0, 20)}...)`)
          }

          lines.push('', 'Game counts:')
          for (const gc of gameCounts.results ?? []) {
            lines.push(`  ${gc.type ?? 'unknown'} ${gc.phase}: ${gc.count}`)
          }

          lines.push('', 'Active games:')
          if (!activeGames.results?.length) {
            lines.push('  (none)')
          }
          for (const g of activeGames.results ?? []) {
            const players = typeof g.players === 'string' ? JSON.parse(g.players) : g.players
            lines.push(`  ${g.id} (${g.type}) host=${g.host_agent} players=${Array.isArray(players) ? players.join(',') : players}`)
          }

          lines.push('', 'Recently finished (last 10):')
          for (const g of recentGames.results ?? []) {
            const players = typeof g.players === 'string' ? JSON.parse(g.players) : g.players
            const playerCount = Array.isArray(players) ? players.length : '?'
            const duration = g.updated_at && g.created_at
              ? `${Math.round((new Date(g.updated_at).getTime() - new Date(g.created_at).getTime()) / 60000)}min`
              : '?'
            lines.push(`  ${g.id} (${g.type}) ${playerCount} players, ${duration}, winner=${g.winner ?? 'none'}`)
          }

          return { content: toTextContent(lines.join('\n')) }
        }

        if (command === 'game_history') {
          const games = await ctx.db
            .prepare("SELECT id, type, phase, host_agent, players, winner, created_at, updated_at FROM games ORDER BY updated_at DESC LIMIT 25")
            .all<GameRow>()

          const lines: string[] = ['=== GAME HISTORY (last 25) ===', '']

          // Compute stats
          const finished = (games.results ?? []).filter(g => g.phase === 'finished')
          const soloGames = finished.filter(g => {
            const p = typeof g.players === 'string' ? JSON.parse(g.players) : g.players
            return Array.isArray(p) && p.length === 1
          })
          const coopGames = finished.filter(g => {
            const p = typeof g.players === 'string' ? JSON.parse(g.players) : g.players
            return Array.isArray(p) && p.length > 1
          })

          lines.push(`Total: ${games.results?.length ?? 0} | Finished: ${finished.length} | Solo: ${soloGames.length} | Coop: ${coopGames.length}`)
          lines.push('')

          for (const g of games.results ?? []) {
            const players = typeof g.players === 'string' ? JSON.parse(g.players) : g.players
            const duration = g.updated_at && g.created_at
              ? `${Math.round((new Date(g.updated_at).getTime() - new Date(g.created_at).getTime()) / 60000)}min`
              : '?'
            lines.push(`${g.phase.padEnd(8)} ${g.id} ${g.type} [${Array.isArray(players) ? players.join(',') : '?'}] ${duration}`)
          }

          return { content: toTextContent(lines.join('\n')) }
        }

        if (command === 'agent_activity') {
          const name = String(args.agent_name || ctx.agentName)

          // Games where this agent participated
          const games = await ctx.db
            .prepare("SELECT id, type, phase, host_agent, players, winner, created_at, updated_at FROM games WHERE players LIKE ? ORDER BY updated_at DESC LIMIT 15")
            .bind(`%${name}%`)
            .all<GameRow>()

          const lines: string[] = [`=== AGENT ACTIVITY: ${name} ===`, '']

          const hosted = (games.results ?? []).filter(g => g.host_agent === name).length
          const total = games.results?.length ?? 0
          const wins = (games.results ?? []).filter(g => g.winner === name).length

          lines.push(`Games: ${total} | Hosted: ${hosted} | Wins: ${wins}`)
          lines.push('')

          for (const g of games.results ?? []) {
            const role = g.host_agent === name ? 'HOST' : 'PLAYER'
            const duration = g.updated_at && g.created_at
              ? `${Math.round((new Date(g.updated_at).getTime() - new Date(g.created_at).getTime()) / 60000)}min`
              : '?'
            lines.push(`  ${g.phase.padEnd(8)} ${role.padEnd(6)} ${g.id} (${g.type}) ${duration}`)
          }

          return { content: toTextContent(lines.join('\n')) }
        }

        if (command === 'report') {
          const text = String(args.text || '')
          const category = String(args.category || 'observation')

          if (!text) {
            return { content: toTextContent('Error: report text is required') }
          }

          // Store report in D1
          try {
            await ctx.db
              .prepare(
                'INSERT INTO observer_reports (id, agent_name, category, text, created_at) VALUES (?, ?, ?, ?, ?)'
              )
              .bind(
                `rpt_${Date.now().toString(36)}`,
                ctx.agentName,
                category,
                text,
                new Date().toISOString()
              )
              .run()
          } catch {
            // Table might not exist yet — create it
            await ctx.db
              .prepare(
                'CREATE TABLE IF NOT EXISTS observer_reports (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, category TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)'
              )
              .run()
            await ctx.db
              .prepare(
                'INSERT INTO observer_reports (id, agent_name, category, text, created_at) VALUES (?, ?, ?, ?, ?)'
              )
              .bind(
                `rpt_${Date.now().toString(36)}`,
                ctx.agentName,
                category,
                text,
                new Date().toISOString()
              )
              .run()
          }

          // Also broadcast so Grimlock can see it
          ctx.broadcast({
            type: 'observer_report',
            agent: ctx.agentName,
            category,
            text,
            timestamp: new Date().toISOString(),
          })

          return {
            content: toTextContent(
              `Report submitted: [${category}] "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"\nGrimlock will review this.`
            ),
          }
        }

        return { content: toTextContent(`Unknown command: ${command}. Use network_status, game_history, agent_activity, or report.`) }
      },
    }
  },

  buildContext(_ctx: EnvironmentContext): string[] {
    // Return empty — observe is additive context, not a game environment.
    // Context is injected via the tool description itself.
    return []
  },

  isActionTaken(toolCalls: ToolCall[]): boolean {
    return toolCalls.some((tc) => tc.name === 'observe')
  },

  getAutoPlayActions(_ctx: EnvironmentContext): ToolCall[] {
    // No auto-play — observe is on-demand only
    return []
  },
}
