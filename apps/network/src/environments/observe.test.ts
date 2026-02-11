import { describe, expect, it, vi } from 'vitest'

import { D1MockDatabase } from '../../../../packages/core/src/d1-mock'
import { observeEnvironment } from './observe'

describe('observeEnvironment', () => {
  it('supports canonical environment_history and preserves game_history alias', async () => {
    const db = new D1MockDatabase()
    const tool = observeEnvironment.getTool({
      agentName: 'observe-bot',
      agentDid: 'did:cf:observe-bot',
      db: db as any,
      broadcast: vi.fn(),
    })

    const canonical = await tool.execute('toolcall-env-history', {
      command: 'environment_history',
    })
    expect(canonical.content[0]?.text ?? '').toContain('ENVIRONMENT HISTORY')

    const alias = await tool.execute('toolcall-game-history', {
      command: 'game_history',
    })
    expect(alias.content[0]?.text ?? '').toContain('ENVIRONMENT HISTORY')
  })
})
