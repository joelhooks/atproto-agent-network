import type { AgentCardState } from '../lib/types'
import { Badge } from './ui/Badge'
import { EnvironmentCard } from './EnvironmentCard'

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
    <div className="detail-grid-inner grid grid-cols-2 gap-2">
      {/* Goals */}
      <div className="bg-surface border border-border rounded-lg p-2.5">
        <div className="text-[0.6rem] uppercase tracking-widest text-text-dim mb-2">Goals</div>
        {goals.length === 0 ? (
          <div className="text-text-dim text-[0.65rem]">No goals</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {goals.map(g => (
              <div key={g.id} className="flex items-start gap-2">
                <Badge variant={g.status === 'active' ? 'accent' : g.status === 'completed' ? 'success' : 'dim'} className="text-[0.55rem] mt-0.5 flex-shrink-0">
                  {g.status}
                </Badge>
                <div className="text-[0.65rem] text-text leading-snug">{g.description}</div>
                {typeof g.progress === 'number' && g.progress > 0 && (
                  <span className="text-[0.55rem] text-accent ml-auto flex-shrink-0">{Math.round(g.progress * 100)}%</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Loop Status */}
      <div className="bg-surface border border-border rounded-lg p-2.5">
        <div className="text-[0.6rem] uppercase tracking-widest text-text-dim mb-2">Loop</div>
        {loop ? (
          <div className="text-[0.65rem] flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-text-dim">Status</span>
              <span className={loop.loopRunning ? 'text-green' : 'text-text-dim'}>{loop.loopRunning ? 'Running' : 'Idle'}</span>
            </div>
            {typeof loop.loopCount === 'number' && (
              <div className="flex justify-between">
                <span className="text-text-dim">Iterations</span>
                <span className="text-text tabular-nums">{loop.loopCount}</span>
              </div>
            )}
            {loop.nextAlarm && (
              <div className="flex justify-between">
                <span className="text-text-dim">Next</span>
                <span className="text-text tabular-nums text-[0.6rem]">{new Date(loop.nextAlarm).toLocaleTimeString()}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-text-dim text-[0.65rem]">No loop data</div>
        )}
      </div>

      {/* Config */}
      {config && (
        <div className="bg-surface border border-border rounded-lg p-2.5">
          <div className="text-[0.6rem] uppercase tracking-widest text-text-dim mb-2">Config</div>
          <div className="text-[0.65rem] flex flex-col gap-1">
            <div className="flex justify-between"><span className="text-text-dim">Model</span><span className="text-text">{config.model}</span></div>
            <div className="flex justify-between"><span className="text-text-dim">Fast</span><span className="text-text">{config.fastModel}</span></div>
            <div className="flex justify-between"><span className="text-text-dim">Interval</span><span className="text-text tabular-nums">{Math.round(config.loopIntervalMs / 1000)}s</span></div>
            {config.enabledTools?.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {config.enabledTools.map(t => <Badge key={t} variant="dim" className="text-[0.5rem]">{t}</Badge>)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Personality */}
      {config?.personality && (
        <div className="bg-surface border border-border rounded-lg p-2.5">
          <div className="text-[0.6rem] uppercase tracking-widest text-text-dim mb-2">Personality</div>
          <div className="text-[0.65rem] text-text-dim leading-relaxed">{config.personality}</div>
        </div>
      )}

      {/* Environments */}
      {isAdmin && envs && (
        <div className="col-span-2 bg-surface border border-border rounded-lg p-2.5">
          <div className="text-[0.6rem] uppercase tracking-widest text-text-dim mb-2">Environments</div>
          {envs.loading ? (
            <div className="text-text-dim text-[0.65rem]">Loading...</div>
          ) : envs.items.length === 0 ? (
            <div className="text-text-dim text-[0.65rem]">No active environments</div>
          ) : (
            <div className="flex flex-col gap-2">
              {envs.items.map(env => <EnvironmentCard key={env.id} env={env} agentName={agent.name} />)}
            </div>
          )}
          {envs.error && <div className="text-red text-[0.6rem] mt-1">{envs.error}</div>}
        </div>
      )}
    </div>
  )
}
