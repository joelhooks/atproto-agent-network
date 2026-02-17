import { getSandbox, type Sandbox } from '@cloudflare/sandbox'

import type { Env } from '../index'

export function createAgentSandbox(env: Env, agentName: string, envType: string): Sandbox {
  const sandboxId = `agent-${agentName}-${envType}`.toLowerCase()
  return getSandbox(env.Sandbox, sandboxId, {
    sleepAfter: '5m',
    normalizeId: true,
  })
}

export async function ensureR2Mount(sandbox: Sandbox, agentName: string, env: Env) {
  await sandbox.mountBucket('agent-blobs', '/data', {
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    provider: 'r2',
    prefix: `/agents/${agentName}/`,
  })
}
