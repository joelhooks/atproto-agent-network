import { AuthProvider, useAuth } from './hooks/useAuth'
import { ActivityFeedProvider, useActivityFeed } from './hooks/useActivityFeed'
import { useAgents } from './hooks/useAgents'
import { useWebSocket } from './hooks/useWebSocket'
import { Header } from './components/Header'
import { StatsBar } from './components/StatsBar'
import { AgentCard } from './components/AgentCard'
import { ActivityFeed } from './components/ActivityFeed'
import type { AgentCardState } from './lib/types'

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
    <div className="app-shell">
      <Header connectionStatus={connectionStatus} wsStatus="disconnected" />
      <StatsBar
        agentCount={agentCount}
        activeCount={activeCount}
        memories={stats.memories}
        messages={stats.messages}
        networkBirthday={networkBirthday}
      />
      <main className="dashboard-grid">
        <aside className="agents-sidebar">
          <div className="sidebar-header">
            <span className="sidebar-title">Agents</span>
            <span className="sidebar-title">{agentCount}</span>
          </div>
          <div className="agents-list">
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
              <div className="feed-empty" style={{ padding: '2rem 0' }}>
                {connectionStatus === 'connecting' ? (
                  <span is-="spinner" variant-="dots" speed-="fast" />
                ) : 'No agents found'}
              </div>
            )}
          </div>
        </aside>
        <section className="feed-scroll">
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
