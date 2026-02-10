import type { AgentCardState } from '../lib/types'
import { truncateDid } from '../lib/formatters'
import { Card } from './ui/Card'
import { Badge } from './ui/Badge'
import { Heartbeat } from './ui/Heartbeat'
import { AgentDetail } from './AgentDetail'

export interface AgentCardProps {
  agent: AgentCardState
  expanded: boolean
  isAdmin: boolean
  onToggle: () => void
  onLoadEnvironments: () => void
}

export function AgentCard({ agent, expanded, isAdmin, onToggle, onLoadEnvironments }: AgentCardProps) {
  const handleToggle = () => {
    onToggle()
    if (!expanded && isAdmin) onLoadEnvironments()
  }

  const loopActive = agent.loop?.loopRunning ?? false
  const goalCount = agent.config?.goals?.length ?? 0
  const activeGoals = agent.config?.goals?.filter(g => g.status === 'active')?.length ?? 0

  return (
    <div className={expanded ? 'agent-card-expanded-wrap' : ''}>
      <Card expanded={expanded} onClick={handleToggle}>
        <div className="agent-card-header">
          <Heartbeat active={loopActive} />
          <span className="agent-card-name">{agent.displayName}</span>
          <div style={{ flex: 1 }} />
          {agent.config?.profile?.mood && (
            <Badge variant="dim">{agent.config.profile.mood}</Badge>
          )}
          {agent.config?.specialty && (
            <Badge variant="dim">{agent.config.specialty}</Badge>
          )}
        </div>
        {(agent.config?.profile?.status || agent.config?.profile?.currentFocus) && (
          <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--fg-dim)', padding: '0.125rem 0 0 1.5rem' }}>
            {agent.config.profile.status && <div>{agent.config.profile.status}</div>}
            {agent.config.profile.currentFocus && <div style={{ opacity: 0.7 }}>{agent.config.profile.currentFocus}</div>}
          </div>
        )}
        <div className="agent-card-meta">
          {agent.did && (
            <span
              className="agent-card-did"
              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(agent.did!) }}
              title={agent.did}
            >
              {truncateDid(agent.did)}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <div className="agent-card-stats">
            {goalCount > 0 && <span>{activeGoals}/{goalCount} goals</span>}
            {typeof agent.memories === 'number' && <span>{agent.memories} mem</span>}
          </div>
        </div>
      </Card>
      {expanded && (
        <div className="animate-fadeInUp">
          <AgentDetail agent={agent} isAdmin={isAdmin} />
        </div>
      )}
    </div>
  )
}
