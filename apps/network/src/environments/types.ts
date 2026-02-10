import type { PiAgentTool } from '@atproto-agent/agent'

export type ToolCall = {
  name: string
  arguments: Record<string, unknown>
}

export type EnvironmentContext = {
  agentName: string
  agentDid: string
  db: D1Database
  relay?: DurableObjectStub
  broadcast: (event: Record<string, unknown>) => void | Promise<void>
  // Optional outbound webhook (used by Grimlock for inbox + consult_library bridge).
  webhookUrl?: string
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
  notifyTurnChange?: (
    ctx: EnvironmentContext,
    next: string,
    detail: Record<string, unknown>
  ) => void | Promise<void>
}
