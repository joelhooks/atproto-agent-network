import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./index.ts', import.meta.url))

let mf: Miniflare | null = null

// TODO: Migrate to @cloudflare/vitest-pool-workers — Miniflare can't parse
// TypeScript or cloudflare:workers imports without the pool plugin.
describe.skip('Agent network E2E', () => {
  beforeEach(() => {
    mf = new Miniflare({
      scriptPath,
      modules: true,
      compatibilityDate: '2024-01-01',
      durableObjects: {
        AGENTS: 'AgentDO',
        RELAY: 'RelayDO',
      },
      d1Databases: ['DB'],
      r2Buckets: ['BLOBS'],
    })
  })

  afterEach(async () => {
    await mf?.dispose()
    mf = null
  })

  it('serves network metadata', async () => {
    const response = await mf!.dispatchFetch(
      'http://localhost/.well-known/agent-network.json'
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      version: '0.0.1',
      status: 'not-yet-implemented',
    })
  })

  it('resolves agent identity via durable object', async () => {
    const response = await mf!.dispatchFetch(
      'http://localhost/agents/alice/identity'
    )

    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body.did).toMatch(/^did:cf:/)
    expect(body.publicKeys.encryption).toMatch(/^z/)
    expect(body.publicKeys.signing).toMatch(/^z/)
  })
})
