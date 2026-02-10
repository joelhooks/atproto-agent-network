import type { PiAgentTool } from '@atproto-agent/agent'

export type ProfileWriter = (profile: Record<string, unknown>) => Promise<void>

export function createProfileTool(write: ProfileWriter): PiAgentTool {
  return {
    name: 'update_profile',
    description:
      'Update your public profile visible on the dashboard. Set your current status, what you are focused on, and your mood.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Short status line, e.g. "playing RPG", "idle", "exploring dungeon"',
        },
        currentFocus: {
          type: 'string',
          description: 'What you are working on or thinking about right now',
        },
        mood: {
          type: 'string',
          description: 'Your current mood or disposition',
        },
      },
    },
    execute: async (
      toolCallIdOrParams: string | Record<string, unknown>,
      maybeParams?: unknown,
    ) => {
      // Support both (toolCallId, params) and (params) calling conventions
      const args: Record<string, unknown> =
        typeof toolCallIdOrParams === 'string'
          ? ((maybeParams && typeof maybeParams === 'object'
              ? (maybeParams as Record<string, unknown>)
              : {}) as Record<string, unknown>)
          : (toolCallIdOrParams ?? {})

      const profile: Record<string, unknown> = { updatedAt: Date.now() }
      if (typeof args.status === 'string')
        profile.status = args.status.slice(0, 100)
      if (typeof args.currentFocus === 'string')
        profile.currentFocus = args.currentFocus.slice(0, 200)
      if (typeof args.mood === 'string') profile.mood = args.mood.slice(0, 50)
      await write(profile)
      return { ok: true, profile }
    },
  }
}
