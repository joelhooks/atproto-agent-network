import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

type MiniflareInstance = {
  dispatchFetch: (input: string) => Promise<Response>
  dispose: () => Promise<void>
}

type MiniflareConstructor = new (options: unknown) => MiniflareInstance

const scriptPath = fileURLToPath(new URL('./index.ts', import.meta.url))

let Miniflare: MiniflareConstructor | null = null
let miniflareUnavailable = false

try {
  const module = await import('miniflare')
  if (module.Miniflare) {
    Miniflare = module.Miniflare as MiniflareConstructor
  } else {
    miniflareUnavailable = true
  }
} catch {
  miniflareUnavailable = true
}

const describeE2E = miniflareUnavailable ? describe.skip : describe

let mf: MiniflareInstance | null = null

it('detects whether miniflare is available', () => {
  expect(miniflareUnavailable || Miniflare).toBeTruthy()
})

describeE2E('Agent network E2E', () => {
  beforeEach(() => {
    if (!Miniflare) {
      return
    }

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
    if (mf) {
      await mf.dispose()
      mf = null
    }
  })

  it('serves network metadata', async () => {
    if (!mf) {
      return
    }

    const response = await mf.dispatchFetch(
      'http://localhost/.well-known/agent-network.json'
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      version: '0.0.1',
      status: 'not-yet-implemented',
    })
  })

  it('resolves agent identity via durable object', async () => {
    if (!mf) {
      return
    }

    const response = await mf.dispatchFetch(
      'http://localhost/agents/alice/identity'
    )

    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body.did).toMatch(/^did:cf:/)
    expect(body.publicKeys.encryption).toMatch(/^z/)
    expect(body.publicKeys.signing).toMatch(/^z/)
  })
})
