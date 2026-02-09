import type { AgentEnvironment } from './types'

const registry = new Map<string, AgentEnvironment>()

export function registerEnvironment(env: AgentEnvironment): void {
  registry.set(env.type, env)
}

export function getEnvironment(type: string): AgentEnvironment | undefined {
  return registry.get(type)
}

export function getAllEnvironments(): AgentEnvironment[] {
  return Array.from(registry.values())
}
