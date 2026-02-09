import type { PiAgentTool } from '@atproto-agent/agent'

import { generateTid } from '../../../../packages/core/src/identity'

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

type WorkItemRow = {
  id: string
  env_type: string
  env_id: string | null
  status: string
  priority: number
  title: string
  payload_json: string
  claimed_by_did: string | null
  claimed_at: string | null
  created_at: string
  updated_at: string
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function safeJsonStringify(value: unknown): string {
  try {
    if (value == null) return '{}'
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const HELP_TEXT =
  'ralph environment tool.\n' +
  'Commands:\n' +
  '- help: Show this message\n' +
  '- status: Show work queue status summary (or pass id)\n' +
  '- propose_work: Add a work item to the queue\n' +
  '- claim_work: Claim a specific work item (or claim next)\n' +
  '- submit_result: Mark a claimed work item done with a result\n\n' +
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
      description:
        'Workspace coordination helper for Ralph loop. Commands: help, status, propose_work, claim_work, submit_result.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['help', 'status', 'propose_work', 'claim_work', 'submit_result'],
          },
          id: { type: 'string', description: 'Work item id (status/claim_work/submit_result)' },
          env_type: { type: 'string', description: 'Environment type for the work item' },
          env_id: { type: 'string', description: 'Environment id for the work item' },
          title: { type: 'string', description: 'Work item title (propose_work)' },
          priority: { type: 'integer', description: 'Work item priority (propose_work)' },
          payload: { type: 'object', description: 'Work item payload as JSON (propose_work)' },
          result: { type: 'object', description: 'Result payload as JSON (submit_result)' },
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

          const id = safeString(params.id)
          if (id) {
            const row = await ctx.db
              .prepare('SELECT * FROM work_items WHERE id = ?')
              .bind(id)
              .first<WorkItemRow>()
            if (!row) {
              return {
                content: toTextContent(
                  `Ralph status\nAgent: ${agentName}\nDID: ${agentDid}\nWork item not found: ${id}`
                ),
                details: { command, agentName, agentDid, id, found: false },
              }
            }
            return {
              content: toTextContent(
                `Ralph status\nAgent: ${agentName}\nDID: ${agentDid}\nWork item: ${row.id}\nStatus: ${row.status}\nPriority: ${row.priority}\nTitle: ${row.title}`
              ),
              details: { command, agentName, agentDid, id: row.id, found: true, item: row },
            }
          }

          const { results } = await ctx.db
            .prepare('SELECT * FROM work_items ORDER BY priority DESC, created_at ASC')
            .all<WorkItemRow>()

          const counts = { open: 0, claimed: 0, done: 0, other: 0 }
          for (const item of results) {
            if (item.status === 'open') counts.open += 1
            else if (item.status === 'claimed') counts.claimed += 1
            else if (item.status === 'done') counts.done += 1
            else counts.other += 1
          }

          const lines = [
            'Ralph status',
            `Agent: ${agentName}`,
            `DID: ${agentDid}`,
            `Total: ${results.length}`,
            `Open: ${counts.open}`,
            `Claimed: ${counts.claimed}`,
            `Done: ${counts.done}`,
          ]

          const open = results.filter((r) => r.status === 'open').slice(0, 5)
          if (open.length) {
            lines.push('', 'Open items:')
            for (const item of open) {
              lines.push(`- ${item.id} (p${item.priority}) ${item.title}`)
            }
          }

          return {
            content: toTextContent(lines.join('\n')),
            details: {
              command,
              agentName,
              agentDid,
              total: results.length,
              open: counts.open,
              claimed: counts.claimed,
              done: counts.done,
            },
          }
        }

        if (command === 'propose_work') {
          const envType = safeString(params.env_type) ?? 'ralph'
          const envId = safeString(params.env_id)
          const title = safeString(params.title)
          if (!title) throw new Error('propose_work requires title')

          const priority = Math.max(0, Math.floor(safeNumber(params.priority) ?? 0))
          const payloadJson = safeJsonStringify(params.payload ?? {})

          const now = new Date().toISOString()
          const id = safeString(params.id) ?? `work_${generateTid()}`

          await ctx.db
            .prepare(
              'INSERT INTO work_items (id, env_type, env_id, status, priority, title, payload_json, claimed_by_did, claimed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(
              id,
              envType,
              envId,
              'open',
              priority,
              title,
              payloadJson,
              null,
              null,
              now,
              now
            )
            .run()

          return {
            content: toTextContent(`Proposed work item: ${id}\nPriority: ${priority}\nTitle: ${title}`),
            details: { command, id, status: 'open', priority, title, env_type: envType, env_id: envId },
          }
        }

        if (command === 'claim_work') {
          const requestedId = safeString(params.id)

          let target: WorkItemRow | null = null
          if (requestedId) {
            target = await ctx.db
              .prepare('SELECT * FROM work_items WHERE id = ?')
              .bind(requestedId)
              .first<WorkItemRow>()
            if (!target) throw new Error(`work item not found: ${requestedId}`)
            if (target.status !== 'open') throw new Error(`work item not open: ${requestedId} (status=${target.status})`)
          } else {
            const { results } = await ctx.db
              .prepare("SELECT * FROM work_items WHERE status = 'open' ORDER BY priority DESC, created_at ASC LIMIT 1")
              .all<WorkItemRow>()
            target = results[0] ?? null
            if (!target) throw new Error('no open work items to claim')
          }

          const now = new Date().toISOString()
          await ctx.db
            .prepare(
              'UPDATE work_items SET status = ?, claimed_by_did = ?, claimed_at = ?, updated_at = ? WHERE id = ?'
            )
            .bind('claimed', ctx.agentDid, now, now, target.id)
            .run()

          return {
            content: toTextContent(`Claimed work item: ${target.id}\nTitle: ${target.title}`),
            details: {
              command,
              id: target.id,
              status: 'claimed',
              claimed_by_did: ctx.agentDid,
              claimed_at: now,
            },
          }
        }

        if (command === 'submit_result') {
          const id = safeString(params.id)
          if (!id) throw new Error('submit_result requires id')

          const row = await ctx.db
            .prepare('SELECT * FROM work_items WHERE id = ?')
            .bind(id)
            .first<WorkItemRow>()
          if (!row) throw new Error(`work item not found: ${id}`)
          if (row.claimed_by_did && row.claimed_by_did !== ctx.agentDid) {
            throw new Error(`work item claimed by another agent: ${row.claimed_by_did}`)
          }

          const now = new Date().toISOString()
          const existingPayload = safeJsonParseObject(row.payload_json)
          const nextPayload = {
            ...existingPayload,
            result: params.result ?? null,
            submitted_by_did: ctx.agentDid,
            submitted_at: now,
          }

          await ctx.db
            .prepare('UPDATE work_items SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?')
            .bind('done', safeJsonStringify(nextPayload), now, id)
            .run()

          return {
            content: toTextContent(`Submitted result for work item: ${id}\nStatus: done`),
            details: { command, id, status: 'done' },
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
      'Use the ralph tool for: {"command":"help"}, {"command":"status"}, propose/claim/submit work items.',
    ]
  },

  isActionTaken(toolCalls: ToolCall[]): boolean {
    return toolCalls.some((call) => {
      if (call.name !== 'ralph') return false
      const args = normalizeToolCallArguments(call.arguments)
      return (
        args.command === 'help' ||
        args.command === 'status' ||
        args.command === 'propose_work' ||
        args.command === 'claim_work' ||
        args.command === 'submit_result'
      )
    })
  },

  getAutoPlayActions(): ToolCall[] {
    return []
  },
}
