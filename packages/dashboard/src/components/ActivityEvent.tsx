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

const HIDDEN_KEYS = new Set([
  'type', 'note', 'decision', 'message', 'description', 'summary', 'reason',
  'text', 'rationale', 'detail', 'comment', 'observation',
  '$type', 'createdAt', 'updatedAt',
])

function formatValue(val: unknown): string {
  if (typeof val === 'string') return val
  if (typeof val === 'number') return String(val)
  if (typeof val === 'boolean') return val ? 'yes' : 'no'
  if (val === null || val === undefined) return '\u2014'
  if (Array.isArray(val)) return val.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(', ')
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    const flat = Object.entries(obj)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .map(([k, v]) => `${k}: ${v}`)
    if (flat.length > 0 && flat.length === Object.keys(obj).length) return flat.join(', ')
    return JSON.stringify(val)
  }
  return String(val)
}

function MemoryDataDisplay({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return null

  return (
    <div className="memory-data">
      <div className="memory-data-grid">
        {entries.map(([key, val]) => (
          <div key={key} style={{ display: 'contents' }}>
            <span className="memory-data-key">{key.replace(/_/g, ' ')}</span>
            <span className="memory-data-value">{formatValue(val)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function linkifyDids(text: string, agents: Map<string, AgentCardState>): string {
  return text.replace(/did:[a-z]+:[a-zA-Z0-9._:%-]+/g, (did) => resolveDidToName(did, agents))
}

function sanitizeDisplay(s: string | undefined): string | undefined {
  if (!s) return s
  const trimmed = s.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return undefined
  return s
}

export function ActivityEvent({ event, agents }: { event: DashboardActivityEvent; agents: Map<string, AgentCardState> }) {
  const [showDetails, setShowDetails] = useState(false)
  const Icon = kindIcons[event.kind] ?? Cog
  const details = event.details
  const memoryData = details?.memoryData as Record<string, unknown> | undefined
  const displaySummary = sanitizeDisplay(event.summary) ?? event.kind
  const displayText = sanitizeDisplay(event.text)
  const hasDetails = Boolean(details && (details.context || details.error))
  const context = details?.context
  const rawError = details?.error
  const errorObj = rawError && typeof rawError === 'object' && !Array.isArray(rawError) ? rawError as Record<string, unknown> : null
  const errorMessage = errorObj && typeof errorObj.message === 'string' ? errorObj.message : null
  const errorCode = errorObj && typeof errorObj.code === 'string' ? errorObj.code : null

  const isError = event.kind === 'error'

  return (
    <div className={`event-card ${isError ? 'event-card-error' : ''}`}>
      <div className={`event-stripe ${isError ? 'event-stripe-error' : `event-stripe-${event.kind}`}`} />

      <div className="event-content">
        <div className={`event-icon`} style={isError ? { color: 'var(--err)' } : { color: 'var(--dim)' }}>
          <Icon size={16} strokeWidth={1.8} />
        </div>

        <div className="event-body">
          <div className="event-header">
            <span className="event-agent">{event.agent}</span>
            <Badge variant={kindVariants[event.kind]}>{event.kind}</Badge>
            <span className="event-time">{formatTime(event.timestamp)}</span>
          </div>

          <p className="event-summary">
            {linkifyDids(truncate(displaySummary, 300), agents)}
          </p>

          {displayText && (
            <p className="event-text">
              {linkifyDids(truncate(displayText, 600), agents)}
            </p>
          )}

          {event.tags && event.tags.length > 0 && (
            <div className="event-tags">
              {event.tags.map(tag => <Badge key={tag} variant="dim">{tag}</Badge>)}
            </div>
          )}

          {memoryData && (
            <MemoryDataDisplay data={memoryData} />
          )}

          {errorMessage && (
            <div className="event-error-box">
              <p className="event-error-text">
                {errorCode && <span className="event-error-code">[{errorCode}]</span>}
                {truncate(errorMessage, 400)}
              </p>
            </div>
          )}

          {hasDetails ? (
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="event-details-toggle"
            >
              <span className="event-details-arrow" style={{ transform: showDetails ? 'rotate(90deg)' : undefined }}>{'\u203A'}</span>
              {showDetails ? 'hide context' : 'show context'}
            </button>
          ) : null}

          {showDetails && context != null ? (
            <div className="event-context-box">
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
