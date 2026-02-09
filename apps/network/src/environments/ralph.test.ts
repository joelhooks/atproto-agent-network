import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { ralphEnvironment } from './ralph'

async function loadRegistryWithBuiltins() {
  vi.resetModules()
  await import('./builtins')
  return await import('./registry')
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

describe('ralphEnvironment', () => {
  it('is registered as a built-in environment', async () => {
    const { getEnvironment } = await loadRegistryWithBuiltins()
    expect(getEnvironment('ralph')?.type).toBe('ralph')
  })

  it('tool: help describes available commands', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const tool = ralphEnvironment.getTool({
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    } as any)

    const result = await tool.execute?.('toolcall-help', { command: 'help' })
    expect(result).toMatchObject({
      details: { command: 'help' },
    })

    const text = JSON.stringify((result as any)?.content ?? '')
    expect(text).toContain('ralph')
    expect(text).toContain('help')
    expect(text).toContain('status')
  })

  it('tool: status includes agent identity context', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const tool = ralphEnvironment.getTool({
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    } as any)

    const result = await tool.execute?.('toolcall-status', { command: 'status' })
    expect(result).toMatchObject({
      details: { command: 'status', agentName: 'alice', agentDid: 'did:cf:alice' },
    })

    const text = JSON.stringify((result as any)?.content ?? '')
    expect(text).toContain('alice')
    expect(text).toContain('did:cf:alice')
  })

  it('buildContext returns ralph loop instructions', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const lines = await ralphEnvironment.buildContext({
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    } as any)

    expect(lines.join('\n')).toContain('Ralph')
    expect(lines.join('\n')).toContain('TDD')
  })

  it('isActionTaken recognizes ralph tool calls', () => {
    expect(ralphEnvironment.isActionTaken([])).toBe(false)
    expect(
      ralphEnvironment.isActionTaken([{ name: 'ralph', arguments: { command: 'status' } }])
    ).toBe(true)
    expect(
      ralphEnvironment.isActionTaken([{ name: 'ralph', arguments: { command: 'help' } }])
    ).toBe(true)
    expect(ralphEnvironment.isActionTaken([{ name: 'game', arguments: { command: 'status' } }])).toBe(
      false
    )
  })

  it('tool: propose_work -> claim_work -> submit_result updates work_items', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const tool = ralphEnvironment.getTool({
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    } as any)

    const proposed = await tool.execute?.('toolcall-propose', {
      command: 'propose_work',
      env_type: 'github',
      env_id: '113',
      title: 'Implement work queue',
      priority: 2,
      payload: { issue: 113, story: 'mlfo26t9' },
    })

    expect(proposed).toMatchObject({
      details: {
        command: 'propose_work',
        id: expect.any(String),
        status: 'open',
        priority: 2,
      },
    })

    const workItemId = (proposed as any).details.id as string
    const row = await db
      .prepare('SELECT * FROM work_items WHERE id = ?')
      .bind(workItemId)
      .first<WorkItemRow>()

    expect(row).toMatchObject({
      id: workItemId,
      env_type: 'github',
      env_id: '113',
      status: 'open',
      priority: 2,
      title: 'Implement work queue',
      claimed_by_did: null,
      claimed_at: null,
    })
    expect(row?.payload_json).toContain('"issue":113')

    const statusAfterPropose = await tool.execute?.('toolcall-status-propose', { command: 'status' })
    expect(statusAfterPropose).toMatchObject({
      details: { command: 'status', total: 1, open: 1, claimed: 0, done: 0 },
    })

    const claimed = await tool.execute?.('toolcall-claim', {
      command: 'claim_work',
      id: workItemId,
    })
    expect(claimed).toMatchObject({
      details: {
        command: 'claim_work',
        id: workItemId,
        status: 'claimed',
        claimed_by_did: 'did:cf:alice',
      },
    })

    const claimedRow = await db
      .prepare('SELECT * FROM work_items WHERE id = ?')
      .bind(workItemId)
      .first<WorkItemRow>()

    expect(claimedRow).toMatchObject({
      id: workItemId,
      status: 'claimed',
      claimed_by_did: 'did:cf:alice',
    })
    expect(claimedRow?.claimed_at).toMatch(/\d{4}-\d{2}-\d{2}t/i)

    const submitted = await tool.execute?.('toolcall-submit', {
      command: 'submit_result',
      id: workItemId,
      result: { ok: true, summary: 'implemented' },
    })
    expect(submitted).toMatchObject({
      details: { command: 'submit_result', id: workItemId, status: 'done' },
    })

    const doneRow = await db
      .prepare('SELECT * FROM work_items WHERE id = ?')
      .bind(workItemId)
      .first<WorkItemRow>()
    expect(doneRow).toMatchObject({
      id: workItemId,
      status: 'done',
    })
    expect(doneRow?.payload_json).toContain('"result"')

    const statusAfterDone = await tool.execute?.('toolcall-status-done', { command: 'status' })
    expect(statusAfterDone).toMatchObject({
      details: { command: 'status', total: 1, open: 0, claimed: 0, done: 1 },
    })
  })

  it('tool: claim_work without id claims highest priority open item', async () => {
    const db = new D1MockDatabase()
    const broadcast = vi.fn()

    const tool = ralphEnvironment.getTool({
      agentName: 'alice',
      agentDid: 'did:cf:alice',
      db: db as any,
      broadcast,
    } as any)

    const low = await tool.execute?.('toolcall-propose-low', {
      command: 'propose_work',
      env_type: 'github',
      env_id: '113',
      title: 'Low prio',
      priority: 1,
      payload: {},
    })
    const high = await tool.execute?.('toolcall-propose-high', {
      command: 'propose_work',
      env_type: 'github',
      env_id: '113',
      title: 'High prio',
      priority: 5,
      payload: {},
    })

    const lowId = (low as any).details.id as string
    const highId = (high as any).details.id as string
    expect(lowId).not.toBe(highId)

    const claimed = await tool.execute?.('toolcall-claim-next', { command: 'claim_work' })
    expect(claimed).toMatchObject({
      details: { command: 'claim_work', id: highId, status: 'claimed' },
    })
  })
})
