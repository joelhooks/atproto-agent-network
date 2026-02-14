import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('rpg.ts entrypoint shell', () => {
  it('stays thin and delegates orchestrator wiring to rpg/environment', () => {
    const source = readFileSync(new URL('./rpg.ts', import.meta.url), 'utf8')
    const lineCount = source.split('\n').length

    expect(lineCount).toBeLessThanOrEqual(500)
    expect(source).toContain("from './rpg/environment'")
    expect(source).not.toContain('getTool(ctx: EnvironmentContext)')
  })
})
