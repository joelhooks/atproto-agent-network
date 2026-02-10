import type { PiAgentTool } from '@atproto-agent/agent'

import type { EnvironmentContext } from '../environments/types'

import { createGmTool } from './gm-tool'
import { createProfileTool, type ProfileWriter } from './profile-tool'

function isGrimlock(name: string): boolean {
  return name.trim().toLowerCase() === 'grimlock'
}

export interface ToolRegistryOptions {
  profileWriter?: ProfileWriter
}

/**
 * Tool registry entrypoint.
 *
 * NOTE: We deliberately gate the GM tool twice:
 * - Only enabled when the agent config includes it (`enabledTools` allowlist).
 * - Only exposed to the Grimlock agent identity (hard authorization guard).
 *
 * The profile tool is available to ALL agents (no gating).
 */
export function getToolsForAgent(
  ctx: EnvironmentContext,
  enabledTools: string[],
  options?: ToolRegistryOptions,
): PiAgentTool[] {
  const allowlist = new Set(Array.isArray(enabledTools) ? enabledTools : [])

  const tools: PiAgentTool[] = []

  if (allowlist.has('gm') && isGrimlock(ctx.agentName)) {
    tools.push(createGmTool(ctx))
  }

  // Profile tool available to all agents
  if (options?.profileWriter) {
    tools.push(createProfileTool(options.profileWriter))
  }

  return tools
}

