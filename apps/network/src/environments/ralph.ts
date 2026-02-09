import type { PiAgentTool } from '@atproto-agent/agent'

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

const HELP_TEXT =
  'ralph environment tool.\n' +
  'Commands:\n' +
  '- help: Show this message\n' +
  '- status: Show basic runtime status\n\n' +
  'Examples:\n' +
  '- {"command":"help"}\n' +
  '- {"command":"status"}\n'

export const ralphEnvironment: AgentEnvironment = {
  type: 'ralph',
  label: 'Ralph Loop',

  getTool(ctx: EnvironmentContext): PiAgentTool {
    return {
      name: 'ralph',
      label: 'Ralph Loop',
      description: 'Workspace coordination helper for Ralph loop. Commands: help, status.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['help', 'status'] },
        },
        required: ['command'],
      },
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const params = normalizeToolCallArguments(rawParams)
        const command = typeof params.command === 'string' ? params.command : ''

        if (command === 'help') {
          return { content: toTextContent(HELP_TEXT), details: { command } }
        }

        if (command === 'status') {
          const agentName = ctx.agentName.trim() || 'unknown'
          const agentDid = ctx.agentDid || 'unknown'
          return {
            content: toTextContent(`Ralph status\nAgent: ${agentName}\nDID: ${agentDid}`),
            details: { command, agentName, agentDid },
          }
        }

        throw new Error(`Unknown ralph command: ${command}`)
      },
    }
  },

  buildContext(_ctx: EnvironmentContext): string[] {
    return [
      'Ralph Loop: TDD is the law (RED -> GREEN -> REFACTOR).',
      'If you add runtime behavior, keep changes scoped and run: pnpm typecheck && pnpm test.',
      'Use the ralph tool for: {"command":"help"} or {"command":"status"}.',
    ]
  },

  isActionTaken(toolCalls: ToolCall[]): boolean {
    return toolCalls.some((call) => {
      if (call.name !== 'ralph') return false
      const args = normalizeToolCallArguments(call.arguments)
      return args.command === 'help' || args.command === 'status'
    })
  },

  getAutoPlayActions(): ToolCall[] {
    return []
  },
}
