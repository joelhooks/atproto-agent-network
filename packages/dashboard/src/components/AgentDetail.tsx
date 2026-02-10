import type { AgentCardState } from '../lib/types'
import { Badge } from './ui/Badge'
import { EnvironmentCard } from './EnvironmentCard'

function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export interface AgentDetailProps {
  agent: AgentCardState
  isAdmin: boolean
}

export function AgentDetail({ agent, isAdmin }: AgentDetailProps) {
  const goals = agent.config?.goals ?? []
  const loop = agent.loop
  const config = agent.config
  const envs = agent.environments

  return (
    <div className="agent-detail">
      {/* Profile */}
      {config?.profile && (config.profile.status || config.profile.currentFocus || config.profile.mood) && (
        <div className="agent-detail-section">
          <div className="agent-detail-title">Profile</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {config.profile.status && (
              <div className="agent-detail-row"><span className="label">Status</span><span className="value">{config.profile.status}</span></div>
            )}
            {config.profile.currentFocus && (
              <div className="agent-detail-row"><span className="label">Focus</span><span className="value">{config.profile.currentFocus}</span></div>
            )}
            {config.profile.mood && (
              <div className="agent-detail-row"><span className="label">Mood</span><span className="value">{config.profile.mood}</span></div>
            )}
            {config.profile.updatedAt && (
              <div className="agent-detail-row">
                <span className="label">Updated</span>
                <span className="value" style={{ opacity: 0.7 }}>{formatRelativeTime(config.profile.updatedAt)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Goals */}
      <div className="agent-detail-section">
        <div className="agent-detail-title">Goals</div>
        {goals.length === 0 ? (
          <div className="agent-detail-text">No goals</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {goals.map(g => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <Badge variant={g.status === 'active' ? 'accent' : g.status === 'completed' ? 'success' : 'dim'}>
                  {g.status}
                </Badge>
                <span className="agent-detail-text" style={{ flex: 1 }}>{g.description}</span>
                {typeof g.progress === 'number' && g.progress > 0 && (
                  <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--accent)', flexShrink: 0 }}>{Math.round(g.progress * 100)}%</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Loop Status */}
      <div className="agent-detail-section">
        <div className="agent-detail-title">Loop</div>
        {loop ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <div className="agent-detail-row">
              <span className="label">Status</span>
              <span className={loop.loopRunning ? 'value-active' : 'value-dim'}>{loop.loopRunning ? 'Running' : 'Idle'}</span>
            </div>
            {typeof loop.loopCount === 'number' && (
              <div className="agent-detail-row">
                <span className="label">Iterations</span>
                <span className="value">{loop.loopCount}</span>
              </div>
            )}
            {loop.nextAlarm && (
              <div className="agent-detail-row">
                <span className="label">Next</span>
                <span className="value">{new Date(loop.nextAlarm).toLocaleTimeString()}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="agent-detail-text">No loop data</div>
        )}
      </div>

      {/* Config */}
      {config && (
        <div className="agent-detail-section">
          <div className="agent-detail-title">Config</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <div className="agent-detail-row"><span className="label">Model</span><span className="value">{config.model}</span></div>
            <div className="agent-detail-row"><span className="label">Fast</span><span className="value">{config.fastModel}</span></div>
            <div className="agent-detail-row"><span className="label">Interval</span><span className="value">{Math.round(config.loopIntervalMs / 1000)}s</span></div>
            {config.enabledTools?.length > 0 && (
              <div className="agent-detail-tools">
                {config.enabledTools.map(t => <Badge key={t} variant="dim">{t}</Badge>)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Personality */}
      {config?.personality && (
        <div className="agent-detail-section">
          <div className="agent-detail-title">Personality</div>
          <div className="agent-detail-text">{config.personality}</div>
        </div>
      )}

      {/* Environments */}
      {isAdmin && envs && (
        <div className="agent-detail-section agent-detail-full">
          <div className="agent-detail-title">Environments</div>
          {envs.loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span is-="spinner" variant-="dots" speed-="fast" />
              <span className="loading-text">Loading...</span>
            </div>
          ) : envs.items.length === 0 ? (
            <div className="agent-detail-text">No active environments</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {envs.items.map(env => <EnvironmentCard key={env.id} env={env} agentName={agent.name} />)}
            </div>
          )}
          {envs.error && <div style={{ color: 'var(--err)', fontSize: 'var(--fs-2xs)', marginTop: '0.25rem' }}>{envs.error}</div>}
        </div>
      )}
    </div>
  )
}
