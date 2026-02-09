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
    <div className={expanded ? 'agent-card-expanded' : ''}>
      <Card expanded={expanded} onClick={handleToggle}>
        <div className="flex items-center gap-2">
          <Heartbeat active={loopActive} />
          <span className="font-semibold text-[0.8rem] text-text">{agent.displayName}</span>
          <div className="flex-1" />
          {agent.config?.specialty && (
            <Badge variant="dim" className="text-[0.55rem]">{agent.config.specialty}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1.5 text-[0.65rem] text-text-dim min-w-0 overflow-hidden">
          {agent.did && (
            <span
              className="hover:text-accent cursor-pointer transition-colors truncate flex-shrink min-w-0"
              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(agent.did!) }}
              title={agent.did}
            >
              {truncateDid(agent.did)}
            </span>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-shrink-0">
            {goalCount > 0 && <span>{activeGoals}/{goalCount} goals</span>}
            {typeof agent.memories === 'number' && <span>{agent.memories} mem</span>}
          </div>
        </div>
      </Card>
      {expanded && (
        <div className="mt-1 animate-fadeInUp">
          <AgentDetail agent={agent} isAdmin={isAdmin} />
        </div>
      )}
    </div>
  )
}
