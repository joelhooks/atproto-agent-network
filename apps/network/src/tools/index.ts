import type { PiAgentTool } from '@atproto-agent/agent'

import type { EnvironmentContext } from '../environments/types'

import { createGmTool } from './gm-tool'

function isGrimlock(name: string): boolean {
  return name.trim().toLowerCase() === 'grimlock'
}

/**
 * Tool registry entrypoint.
 *
 * NOTE: We deliberately gate the GM tool twice:
 * - Only enabled when the agent config includes it (`enabledTools` allowlist).
 * - Only exposed to the Grimlock agent identity (hard authorization guard).
 */
export function getToolsForAgent(ctx: EnvironmentContext, enabledTools: string[]): PiAgentTool[] {
  const allowlist = new Set(Array.isArray(enabledTools) ? enabledTools : [])

  const tools: PiAgentTool[] = []

  if (allowlist.has('gm') && isGrimlock(ctx.agentName)) {
    tools.push(createGmTool(ctx))
  }

  return tools
}

