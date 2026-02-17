import { describe, expect, it, vi } from 'vitest'

const { getSandboxMock } = vi.hoisted(() => ({
  getSandboxMock: vi.fn(),
}))

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: getSandboxMock,
}))

import type { Sandbox } from '@cloudflare/sandbox'

import { createAgentSandbox, ensureR2Mount } from './sandbox-factory'

describe('sandbox factory', () => {
  it('creates a sandbox using a deterministic normalized id and default options', () => {
    const sandbox = {} as Sandbox
    getSandboxMock.mockReturnValueOnce(sandbox)

    const env = {
      Sandbox: { idFromName: vi.fn(), get: vi.fn() },
      CF_ACCOUNT_ID: 'cf-account-id',
    } as any

    const result = createAgentSandbox(env, 'GrimLock', 'Prod')

    expect(getSandboxMock).toHaveBeenCalledWith(env.Sandbox, 'agent-grimlock-prod', {
      sleepAfter: '5m',
      normalizeId: true,
    })
    expect(result).toBe(sandbox)
  })

  it('re-mounts the agent R2 prefix on each interaction', async () => {
    const mountBucket = vi.fn().mockResolvedValue(undefined)
    const sandbox = { mountBucket } as unknown as Sandbox
    const env = {
      CF_ACCOUNT_ID: 'cf-account-id',
    } as any

    await ensureR2Mount(sandbox, 'grimlock', env)

    expect(mountBucket).toHaveBeenCalledWith('agent-blobs', '/data', {
      endpoint: 'https://cf-account-id.r2.cloudflarestorage.com',
      provider: 'r2',
      prefix: '/agents/grimlock/',
    })
  })
})
