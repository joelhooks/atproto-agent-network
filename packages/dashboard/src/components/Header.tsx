import { StatusPill } from './ui/StatusPill'
import type { ConnectionStatus, WebSocketStatus } from '../lib/types'

export interface HeaderProps {
  connectionStatus: ConnectionStatus
  wsStatus: WebSocketStatus
}

export function Header({ connectionStatus, wsStatus }: HeaderProps) {
  return (
    <header className="bg-surface border-b border-border px-6 py-4 flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-3">
        <span className="text-2xl">🐝</span>
        <h1 className="font-display font-semibold text-xl tracking-wide">
          <span className="text-accent">HIGH</span>
          <span className="text-text">SWARM</span>
        </h1>
        <nav className="flex items-center gap-4 ml-4">
          <a href="https://github.com/joelhooks/atproto-agent-network" target="_blank" rel="noopener noreferrer" className="text-text-dim hover:text-accent text-[0.7rem] transition-colors">GitHub ↗</a>
          <a href="https://agent-network-production.joelhooks.workers.dev/health" target="_blank" rel="noopener noreferrer" className="text-text-dim hover:text-accent text-[0.7rem] transition-colors">API ↗</a>
        </nav>
      </div>
      <StatusPill status={connectionStatus} wsStatus={wsStatus} />
    </header>
  )
}
