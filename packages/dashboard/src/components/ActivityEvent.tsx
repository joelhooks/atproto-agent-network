import { useState } from 'react'
import type { DashboardActivityEvent, ActivityKind, AgentCardState } from '../lib/types'
import { formatTime, truncate, resolveDidToName } from '../lib/formatters'
import { Badge } from './ui/Badge'
import {
  Brain,
  MessageSquare,
  Fingerprint,
  FileText,
  Wrench,
  CloudLightning,
  Target,
  RefreshCw,
  Cog,
  AlertTriangle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const kindIcons: Record<ActivityKind, LucideIcon> = {
  memory: Brain,
  message: MessageSquare,
  identity: Fingerprint,
  prompt: FileText,
  tool: Wrench,
  think_aloud: CloudLightning,
  goal: Target,
  loop: RefreshCw,
  system: Cog,
  error: AlertTriangle,
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

// Skip keys that are already shown elsewhere or are noise
const HIDDEN_KEYS = new Set(['type', 'note', 'decision', '$type', 'createdAt', 'updatedAt'])

function MemoryDataDisplay({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([k]) => !HIDDEN_KEYS.has(k))
  if (entries.length === 0) return null

  return (
    <div className="mt-2 rounded bg-surface-2/60 border border-border/50 px-3 py-2">
      <div className="grid gap-y-1" style={{ gridTemplateColumns: 'auto 1fr' }}>
        {entries.map(([key, val]) => {
          const display = typeof val === 'string' ? val
            : typeof val === 'number' ? String(val)
            : typeof val === 'boolean' ? (val ? 'yes' : 'no')
            : JSON.stringify(val)
          return (
            <div key={key} className="contents">
              <span className="text-[0.58rem] text-text-dim pr-3 tabular-nums">{key.replace(/_/g, ' ')}</span>
              <span className="text-[0.62rem] text-text break-words">{display}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function linkifyDids(text: string, agents: Map<string, AgentCardState>): string {
  return text.replace(/did:[a-z]+:[a-zA-Z0-9._:%-]+/g, (did) => resolveDidToName(did, agents))
}

export function ActivityEvent({ event, agents }: { event: DashboardActivityEvent; agents: Map<string, AgentCardState> }) {
  const [showDetails, setShowDetails] = useState(false)
  const Icon = kindIcons[event.kind] ?? Cog
  const details = event.details
  const memoryData = details?.memoryData as Record<string, unknown> | undefined
  const hasDetails = Boolean(details && (details.context || details.error))
  const context = details?.context
  const rawError = details?.error
  const errorObj = rawError && typeof rawError === 'object' && !Array.isArray(rawError) ? rawError as Record<string, unknown> : null
  const errorMessage = errorObj && typeof errorObj.message === 'string' ? errorObj.message : null
  const errorCode = errorObj && typeof errorObj.code === 'string' ? errorObj.code : null

  const isError = event.kind === 'error'

  return (
    <div className={`event-card group ${isError ? 'event-card-error' : ''}`}>
      {/* Left accent stripe */}
      <div className={`event-stripe ${isError ? 'event-stripe-error' : `event-stripe-${event.kind}`}`} />

      <div className="flex items-start gap-3 p-3.5 sm:p-4">
        {/* Icon */}
        <div className={`event-icon flex-shrink-0 ${isError ? 'text-red' : 'text-text-dim'}`}>
          <Icon size={15} strokeWidth={1.8} />
        </div>

        {/* Content — single min-w-0 to enable text truncation */}
        <div className="min-w-0 flex-1">
          {/* Header row */}
          <div className="flex items-baseline gap-2 flex-wrap mb-1">
            <span className="text-accent text-[0.75rem] font-semibold">{event.agent}</span>
            <Badge variant={kindVariants[event.kind]} className="text-[0.5rem]">{event.kind}</Badge>
            <span className="text-text-dim text-[0.55rem] tabular-nums ml-auto">{formatTime(event.timestamp)}</span>
          </div>

          {/* Summary */}
          <p className="text-[0.72rem] text-text leading-relaxed break-words">
            {linkifyDids(truncate(event.summary, 200), agents)}
          </p>

          {/* Body text */}
          {event.text && (
            <p className="text-[0.65rem] text-text-dim mt-2 leading-relaxed break-words whitespace-pre-wrap">
              {linkifyDids(truncate(event.text, 500), agents)}
            </p>
          )}

          {/* Tags */}
          {event.tags && event.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2.5">
              {event.tags.map(tag => <Badge key={tag} variant="dim" className="text-[0.5rem]">{tag}</Badge>)}
            </div>
          )}

          {/* Structured memory data */}
          {memoryData && (
            <MemoryDataDisplay data={memoryData} />
          )}

          {/* Error */}
          {errorMessage && (
            <div className="mt-2.5 rounded bg-red/8 border border-red/15 px-3 py-2">
              <p className="text-red text-[0.65rem] break-words">
                {errorCode && <span className="opacity-60 mr-1.5">[{errorCode}]</span>}
                {truncate(errorMessage, 300)}
              </p>
            </div>
          )}

          {/* Details toggle */}
          {hasDetails ? (
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="event-details-toggle mt-2.5"
            >
              <span className="event-details-arrow" style={{ transform: showDetails ? 'rotate(90deg)' : undefined }}>›</span>
              {showDetails ? 'hide context' : 'show context'}
            </button>
          ) : null}

          {/* Details JSON */}
          {showDetails && context != null ? (
            <div className="mt-2 rounded-lg bg-bg border border-border">
              <pre className="event-json-pre">
                {JSON.stringify(context, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
