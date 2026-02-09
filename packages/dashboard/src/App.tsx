import { useEffect } from 'react'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { ActivityFeedProvider, useActivityFeed } from './hooks/useActivityFeed'
import { useAgents } from './hooks/useAgents'
import { useWebSocket } from './hooks/useWebSocket'
import { Header } from './components/Header'
import { StatsBar } from './components/StatsBar'
import { AgentCard } from './components/AgentCard'
import { ActivityFeed } from './components/ActivityFeed'
import { ActivityEvent } from './components/ActivityEvent'
import type { AgentCardState, WebSocketStatus } from './lib/types'

function AgentWebSocket({ name }: { name: string }) {
  const { wsStatus } = useWebSocket(name)
  return null
}

function WebSocketManager({ agents }: { agents: Map<string, AgentCardState> }) {
  return (
    <>
      {Array.from(agents.keys()).map(name => (
        <AgentWebSocket key={name} name={name} />
      ))}
    </>
  )
}

function AppContent() {
  const { isAdmin } = useAuth()
  const { agents, connectionStatus, expandedAgent, setExpandedAgent, loadAgentEnvironments } = useAgents()
  const { events, stats, networkBirthday } = useActivityFeed()

  const agentCount = agents.size
  const activeCount = Array.from(agents.values()).filter(a => a.loop?.loopRunning).length

  return (
    <div className="min-h-screen flex flex-col">
      <Header connectionStatus={connectionStatus} wsStatus="disconnected" />
      <StatsBar
        agentCount={agentCount}
        activeCount={activeCount}
        memories={stats.memories}
        messages={stats.messages}
        networkBirthday={networkBirthday}
      />
      <main className="dashboard-grid flex-1 grid grid-cols-[320px_1fr] min-h-0">
        <aside className="agents-sidebar border-r border-border overflow-y-auto p-3 flex flex-col gap-2" style={{ maxHeight: 'calc(100vh - 140px)' }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-text-dim text-[0.7rem] uppercase tracking-widest">Agents</span>
            <span className="text-text-dim text-[0.65rem]">{agentCount}</span>
          </div>
          <div className="agents-list-grid flex flex-col gap-2">
            {Array.from(agents.values()).map(agent => (
              <AgentCard
                key={agent.name}
                agent={agent}
                expanded={expandedAgent === agent.name}
                isAdmin={isAdmin}
                onToggle={() => setExpandedAgent(expandedAgent === agent.name ? null : agent.name)}
                onLoadEnvironments={() => loadAgentEnvironments(agent.name)}
              />
            ))}
            {agents.size === 0 && (
              <div className="text-text-dim text-[0.75rem] text-center py-6">
                {connectionStatus === 'connecting' ? 'Connecting...' : 'No agents found'}
              </div>
            )}
          </div>
        </aside>
        <section className="feed-scroll overflow-y-auto p-4" style={{ maxHeight: 'calc(100vh - 140px)' }}>
          <ActivityFeed events={events} agents={agents} />
        </section>
      </main>
      <WebSocketManager agents={agents} />
    </div>
  )
}

export function App() {
  return (
    <AuthProvider>
      <ActivityFeedProvider>
        <AppContent />
      </ActivityFeedProvider>
    </AuthProvider>
  )
}
