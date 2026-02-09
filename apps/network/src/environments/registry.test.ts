import { describe, expect, it, vi } from 'vitest'

import type { AgentEnvironment } from './types'

async function loadRegistry() {
  vi.resetModules()
  return await import('./registry')
}

function createEnv(type: string, label = type): AgentEnvironment {
  return {
    type,
    label,
    getTool() {
      return {
        name: `tool_${type}`,
        description: `tool for ${type}`,
        parameters: {},
        async execute() {
          return { ok: true }
        },
      }
    },
    buildContext() {
      return [`context:${type}`]
    },
    isActionTaken() {
      return false
    },
    getAutoPlayActions() {
      return []
    },
  }
}

describe('environment registry', () => {
  it('registers and retrieves environments by type', async () => {
    const { registerEnvironment, getEnvironment, getAllEnvironments } = await loadRegistry()

    const env = createEnv('rpg', 'RPG')
    registerEnvironment(env)

    expect(getEnvironment('rpg')).toBe(env)
    expect(getAllEnvironments()).toEqual([env])
  })

  it('overwrites environments when registering the same type twice', async () => {
    const { registerEnvironment, getEnvironment, getAllEnvironments } = await loadRegistry()

    const first = createEnv('rpg', 'First')
    const second = createEnv('rpg', 'Second')

    registerEnvironment(first)
    registerEnvironment(second)

    expect(getEnvironment('rpg')).toBe(second)
    expect(getAllEnvironments()).toEqual([second])
  })

  it('returns undefined for unknown environment types', async () => {
    const { getEnvironment } = await loadRegistry()

    expect(getEnvironment('missing')).toBeUndefined()
  })
})
