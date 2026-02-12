import type { PiAgentTool } from '@atproto-agent/agent'
import type { PhaseMachine } from './phase-machine'

export type ToolCall = {
  name: string
  arguments: Record<string, unknown>
}

export type EnvironmentContext = {
  agentName: string
  agentDid: string
  db: D1Database
  env?: {
    AI?: {
      run: (model: string, input: Record<string, unknown>) => Promise<unknown>
    }
  }
  relay?: DurableObjectStub
  broadcast: (event: Record<string, unknown>) => void | Promise<void>
  // Optional outbound webhook (used by Grimlock for inbox + consult_library bridge).
  webhookUrl?: string
  // Character persistence (closes over DO storage in agent.ts)
  loadCharacter?: () => Promise<unknown>
  saveCharacter?: (character: unknown) => Promise<void>
}

export type EnvironmentDebugInput = {
  id: string
  type: string
  hostAgent: string | null
  phase: string | null
  players: string[]
  winner: string | null
  state: unknown
}

export interface AgentEnvironment {
  type: string
  label: string
  getTool: (ctx: EnvironmentContext) => PiAgentTool
  // Called during observe() after inbox/events collection. Returned strings are
  // appended to observations for the model to consume.
  buildContext: (ctx: EnvironmentContext) => string[] | Promise<string[]>
  // Return true if the model already took a valid environment action this cycle
  // (so auto-play should not run).
  isActionTaken: (toolCalls: ToolCall[]) => boolean
  getAutoPlayActions: (ctx: EnvironmentContext) => ToolCall[] | Promise<ToolCall[]>
  // Optional: always-run setup override that bypasses isActionTaken during setup phase
  getSetupOverrideActions?: (ctx: EnvironmentContext) => Promise<ToolCall[]>
  notifyTurnChange?: (
    ctx: EnvironmentContext,
    next: string,
    detail: Record<string, unknown>
  ) => void | Promise<void>
  /** Return the current phase machine, if one is active */
  getPhaseMachine?: (ctx: EnvironmentContext) => PhaseMachine | null | Promise<PhaseMachine | null>
  /** Return allowed tools for an agent in the current phase, or null for no restriction */
  getPhaseTools?: (agentName: string, ctx: EnvironmentContext) => string[] | null | Promise<string[] | null>
  /** Optional environment-specific observability payload for `/environments/:id` debug dumps. */
  debugView?: (input: EnvironmentDebugInput) => Record<string, unknown> | Promise<Record<string, unknown>>
}
