import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('dashboard index.html wiring', () => {
  it('loads the Vite entry module (src/main.ts) instead of legacy inline JS', () => {
    const htmlPath = resolve(__dirname, '..', 'index.html')
    const html = readFileSync(htmlPath, 'utf8')

    // This is the actual app logic (agent cards, activity feed, WS parsing).
    expect(html).toContain('type="module"')
    expect(html).toContain('src="/src/main.ts"')

    // The legacy inline implementation had hard-coded known agents and its own fetch loop.
    expect(html).not.toContain('KNOWN_AGENTS')
    expect(html).not.toContain('function connectWebSocket(')
  })
})

