import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { ralphEnvironment } from './ralph'

async function loadRegistryWithBuiltins() {
  vi.resetModules()
  await import('./builtins')
  return await import('./registry')
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
})

