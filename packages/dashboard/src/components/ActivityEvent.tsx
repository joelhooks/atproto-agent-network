import { useState } from 'react'
import type { DashboardActivityEvent, ActivityKind, AgentCardState } from '../lib/types'
import { formatTime, truncate, resolveDidToName } from '../lib/formatters'
import { Badge } from './ui/Badge'

const kindIcons: Record<ActivityKind, string> = {
  memory: '🧠',
  message: '💬',
  identity: '🪪',
  prompt: '📝',
  tool: '🔧',
  think_aloud: '💭',
  goal: '🎯',
  loop: '🔄',
  system: '⚙️',
  error: '❌',
}

const kindVariants: Record<ActivityKind, 'default' | 'accent' | 'success' | 'error' | 'dim'> = {
  memory: 'accent',
  message: 'default',
  identity: 'dim',
  prompt: 'dim',
  tool: 'default',
  think_aloud: 'dim',
  goal: 'accent',
  loop: 'dim',
  system: 'dim',
  error: 'error',
}

function linkifyDids(text: string, agents: Map<string, AgentCardState>): string {
  return text.replace(/did:[a-z]+:[a-zA-Z0-9._:%-]+/g, (did) => resolveDidToName(did, agents))
}

export function ActivityEvent({ event, agents }: { event: DashboardActivityEvent; agents: Map<string, AgentCardState> }) {
  const [showDetails, setShowDetails] = useState(false)
  const icon = kindIcons[event.kind] ?? '⚙️'
  const details = event.details
  const hasDetails = Boolean(details && (details.context || details.error))
  const context = details?.context
  const rawError = details?.error
  const errorObj = rawError && typeof rawError === 'object' && !Array.isArray(rawError) ? rawError as Record<string, unknown> : null
  const errorMessage = errorObj && typeof errorObj.message === 'string' ? errorObj.message : null
  const errorCode = errorObj && typeof errorObj.code === 'string' ? errorObj.code : null

  return (
    <div className="bg-surface border border-border rounded-lg p-2.5 hover:border-border/80 transition-colors animate-fadeInUp">
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded bg-surface-2 flex items-center justify-center text-[0.7rem] flex-shrink-0 mt-0.5">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-accent text-[0.7rem] font-semibold">{event.agent}</span>
            <Badge variant={kindVariants[event.kind]} className="text-[0.5rem]">{event.kind}</Badge>
            <span className="text-text-dim text-[0.55rem] ml-auto flex-shrink-0 tabular-nums">{formatTime(event.timestamp)}</span>
          </div>
          <div className="text-[0.7rem] text-text mt-0.5 leading-snug">
            {linkifyDids(truncate(event.summary, 200), agents)}
          </div>
          {event.text && (
            <div className="text-[0.65rem] text-text-dim mt-1 leading-relaxed whitespace-pre-wrap break-words">
              {linkifyDids(truncate(event.text, 500), agents)}
            </div>
          )}
          {event.tags && event.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {event.tags.map(tag => <Badge key={tag} variant="dim" className="text-[0.5rem]">{tag}</Badge>)}
            </div>
          )}
          {errorMessage && (
            <div className="text-red text-[0.6rem] mt-1 bg-red/5 rounded px-2 py-1">
              {errorCode && <span className="text-red/70 mr-1">[{errorCode}]</span>}
              {truncate(errorMessage, 300)}
            </div>
          )}
          {hasDetails ? (
            <button onClick={() => setShowDetails(!showDetails)} className="text-[0.55rem] text-accent mt-1 hover:underline">
              {showDetails ? 'hide' : 'show'} details
            </button>
          ) : null}
          {showDetails && context != null ? (
            <pre className="text-[0.5rem] text-text-dim mt-1 bg-surface-2 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
              {JSON.stringify(context, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  )
}
