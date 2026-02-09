import type { EnvironmentDetail } from '../environments'
export type { EnvironmentDetail }
export type { DashboardActivityEvent, ActivityKind } from '../activity'

export type AgentGoal = {
  id: string
  description: string
  priority: number
  status: string
  progress: number
  createdAt: number
  completedAt?: number
}

export type AgentConfig = {
  name: string
  personality: string
  specialty: string
  model: string
  fastModel: string
  loopIntervalMs: number
  goals: AgentGoal[]
  enabledTools: string[]
}

export type AgentLoop = {
  loopRunning?: boolean
  loopCount?: number
  nextAlarm?: number | null
  nextAlarmAt?: number | null
  lastLoopEventAt?: string
}

export type AgentEnvironments = {
  loading: boolean
  error?: string
  items: EnvironmentDetail[]
  fetchedAt?: number
}

export type AgentCardState = {
  name: string
  displayName: string
  did?: string
  createdAt?: number
  publicKeys?: Record<string, unknown>
  memories?: number
  config?: AgentConfig
  loop?: AgentLoop
  lastGoalsFingerprint?: string
  environments?: AgentEnvironments
}

export type ConnectionStatus = 'online' | 'connecting' | 'offline'
export type WebSocketStatus = 'live' | 'polling' | 'disconnected'
