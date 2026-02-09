import { useEffect, useRef, useState, useCallback } from 'react'
import type { AgentCardState, ConnectionStatus } from '../lib/types'
import type { EnvironmentDetail } from '../environments'
import { API_BASE, fetchJson } from '../lib/api'
import { useAuth } from './useAuth'
import { useActivityFeed } from './useActivityFeed'
import { summarizeLexiconRecord } from '../activity'

function normalizeEnvironmentDetail(value: any): EnvironmentDetail | null {
  if (!value || typeof value !== 'object') return null
  const id = typeof value.id === 'string' ? value.id : null
  const type = typeof value.type === 'string' ? value.type : null
  if (!id || !type) return null
  return {
    id, type,
    hostAgent: typeof value.hostAgent === 'string' ? value.hostAgent : 'unknown',
    phase: typeof value.phase === 'string' ? value.phase : 'unknown',
    players: Array.isArray(value.players) ? value.players.filter((p: any) => typeof p === 'string') : [],
    winner: typeof value.winner === 'string' ? value.winner : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    state: value.state,
  }
}

export function useAgents() {
  const { token } = useAuth()
  const { addEvent, setStats, setNetworkBirthday } = useActivityFeed()
  const [agents, setAgents] = useState<Map<string, AgentCardState>>(new Map())
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const networkBirthdayRef = useRef<number | null>(null)

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/health`)
      const data = await res.json().catch(() => null)
      if (data && typeof data === 'object' && 'status' in data && (data as any).status === 'ok') {
        setConnectionStatus('online')
      } else setConnectionStatus('connecting')
    } catch { setConnectionStatus('offline') }
  }, [])

  const fetchAgent = useCallback(async (name: string, prev: Map<string, AgentCardState>) => {
    const existing: AgentCardState = prev.get(name) ?? { name, displayName: name.charAt(0).toUpperCase() + name.slice(1) }

    try {
      const [identity, config] = await Promise.all([
        fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/identity`).catch(() => null),
        fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/config`).catch(() => null),
      ])

      if (identity && typeof identity === 'object') {
        existing.did = typeof identity.did === 'string' ? identity.did : existing.did
        existing.createdAt = typeof identity.createdAt === 'number' ? identity.createdAt : existing.createdAt
        if (typeof identity.createdAt === 'number') {
          if (!networkBirthdayRef.current || identity.createdAt < networkBirthdayRef.current) {
            networkBirthdayRef.current = identity.createdAt
            setNetworkBirthday(identity.createdAt)
          }
        }
      }

      if (config && typeof config === 'object') {
        existing.config = config as any
        const goals = Array.isArray(config.goals) ? config.goals : []
        const fp = JSON.stringify(goals.slice().sort((a: any, b: any) => String(a?.id ?? '').localeCompare(String(b?.id ?? ''))).map((g: any) => ({ id: g.id, status: g.status, progress: g.progress, description: g.description, priority: g.priority })))
        if (existing.lastGoalsFingerprint && existing.lastGoalsFingerprint !== fp) {
          addEvent({ type: 'agent.goals.updated', agent: name, kind: 'goal', summary: `Goals updated (${goals.length})`, timestamp: new Date().toISOString(), details: { context: { goals } } })
        }
        existing.lastGoalsFingerprint = fp
      }

      if (token) {
        const loop = await fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/loop/status`, { token }).catch(() => null)
        if (loop && typeof loop === 'object') {
          existing.loop = {
            ...(existing.loop ?? {}),
            loopRunning: Boolean(loop.loopRunning),
            loopCount: typeof loop.loopCount === 'number' ? loop.loopCount : existing.loop?.loopCount,
            nextAlarm: typeof loop.nextAlarm === 'number' ? loop.nextAlarm : null,
          }
        }
      }

      const memory = await fetchJson(`${API_BASE}/agents/${encodeURIComponent(name)}/memory?limit=50`).catch(() => ({ entries: [] }))
      const entries = Array.isArray(memory?.entries) ? memory.entries : []
      existing.memories = entries.length

      for (const entry of entries) {
        const record = entry?.record
        const s = summarizeLexiconRecord(record)
        if (s.kind === 'message') { /* counted later */ }
        addEvent({
          type: typeof record?.$type === 'string' ? record.$type : 'agent.record',
          agent: name, kind: s.kind, summary: s.summary, text: s.text, tags: s.tags,
          timestamp: (s.timestamp ?? record?.createdAt ?? new Date().toISOString()) as string,
          details: s.details,
        })
      }
    } catch (error) {
      addEvent({ type: 'dashboard.error', agent: name, kind: 'error', summary: `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`, timestamp: new Date().toISOString() })
    }

    return existing
  }, [token, addEvent, setNetworkBirthday])

  const pollAgents = useCallback(async () => {
    await fetchHealth()

    const updated = new Map(agents)

    if (token) {
      try {
        const list = await fetchJson(`${API_BASE}/agents`, { token })
        const agentsList = Array.isArray(list?.agents) ? list.agents : []
        for (const a of agentsList) {
          if (!a || typeof a !== 'object' || typeof a.name !== 'string') continue
          updated.set(a.name, {
            ...(updated.get(a.name) ?? { name: a.name, displayName: a.name.charAt(0).toUpperCase() + a.name.slice(1) }),
            did: typeof a.did === 'string' ? a.did : undefined,
            createdAt: typeof a.createdAt === 'number' ? a.createdAt : undefined,
            config: a.config ?? undefined,
          })
        }
      } catch { /* fall back */ }
    }

    const names = updated.size ? Array.from(updated.keys()) : ['grimlock', 'swoop', 'sludge']
    for (const name of names) {
      const agentState = await fetchAgent(name, updated)
      updated.set(name, agentState)
    }

    let totalMemories = 0, totalMessages = 0
    for (const a of updated.values()) totalMemories += a.memories ?? 0
    setStats({ memories: totalMemories, messages: totalMessages })

    setAgents(new Map(Array.from(updated.entries()).sort(([a], [b]) => a.localeCompare(b))))
  }, [fetchHealth, fetchAgent, token, agents, setStats])

  const loadAgentEnvironments = useCallback(async (agentName: string) => {
    if (!token) return
    setAgents(prev => {
      const agent = prev.get(agentName)
      if (!agent) return prev
      if (agent.environments?.loading) return prev
      if (agent.environments?.fetchedAt && Date.now() - agent.environments.fetchedAt < 10_000) return prev
      const next = new Map(prev)
      next.set(agentName, { ...agent, environments: { loading: true, items: agent.environments?.items ?? [] } })
      return next
    })

    try {
      const list = await fetchJson(`${API_BASE}/environments?player=${encodeURIComponent(agentName)}`, { token })
      const envs = Array.isArray(list?.environments) ? list.environments : []
      const active = envs.filter((e: any) => e && typeof e === 'object' && String(e.phase ?? '') !== 'finished')
      const details = await Promise.all(active.map(async (e: any) => {
        if (typeof e?.id !== 'string') return null
        try {
          return normalizeEnvironmentDetail(await fetchJson(`${API_BASE}/environments/${encodeURIComponent(e.id)}`, { token }))
        } catch { return normalizeEnvironmentDetail({ ...e, state: null }) }
      }))
      setAgents(prev => {
        const next = new Map(prev)
        const agent = next.get(agentName)
        if (agent) next.set(agentName, { ...agent, environments: { loading: false, items: details.filter(Boolean) as EnvironmentDetail[], fetchedAt: Date.now() } })
        return next
      })
    } catch (error) {
      setAgents(prev => {
        const next = new Map(prev)
        const agent = next.get(agentName)
        if (agent) next.set(agentName, { ...agent, environments: { loading: false, items: agent.environments?.items ?? [], fetchedAt: Date.now(), error: String(error) } })
        return next
      })
    }
  }, [token])

  useEffect(() => {
    pollAgents()
    const id = setInterval(pollAgents, 15_000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line -- run once

  return { agents, connectionStatus, expandedAgent, setExpandedAgent, loadAgentEnvironments }
}
