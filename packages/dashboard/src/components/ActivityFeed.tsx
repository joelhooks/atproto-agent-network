import type { DashboardActivityEvent, AgentCardState } from '../lib/types'
import { ActivityEvent } from './ActivityEvent'
import { Badge } from './ui/Badge'

export interface ActivityFeedProps {
  events: DashboardActivityEvent[]
  agents: Map<string, AgentCardState>
}

export function ActivityFeed({ events, agents }: ActivityFeedProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4 lg:mb-5">
        <div className="flex items-center gap-2.5">
          <span className="text-text-dim text-xs uppercase tracking-widest">Activity</span>
          <Badge variant="dim" className="text-xs">{events.length}</Badge>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="text-center py-16 text-text-dim text-sm">
          Waiting for events...
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 lg:gap-3">
          {events.map((ev, i) => (
            <ActivityEvent key={`${ev.agent}:${ev.type}:${ev.timestamp}:${i}`} event={ev} agents={agents} />
          ))}
        </div>
      )}
    </div>
  )
}
