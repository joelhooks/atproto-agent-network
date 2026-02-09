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
      <div className="feed-header">
        <div className="feed-title">
          <span className="feed-title-text">Activity</span>
          <Badge variant="dim">{events.length}</Badge>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="feed-empty">
          <span is-="spinner" variant-="dots" speed-="fast" />
          <div style={{ marginTop: '0.75rem' }}>Waiting for events...</div>
        </div>
      ) : (
        <div className="feed-list">
          {events.map((ev, i) => (
            <ActivityEvent key={`${ev.agent}:${ev.type}:${ev.timestamp}:${i}`} event={ev} agents={agents} />
          ))}
        </div>
      )}
    </div>
  )
}
