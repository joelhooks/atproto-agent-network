import { StatusPill } from './ui/StatusPill'
import type { ConnectionStatus, WebSocketStatus } from '../lib/types'

export interface HeaderProps {
  connectionStatus: ConnectionStatus
  wsStatus: WebSocketStatus
}

export function Header({ connectionStatus, wsStatus }: HeaderProps) {
  return (
    <header className="bg-surface border-b border-border px-3 py-3 sm:px-6 lg:px-8 sm:py-4 lg:py-5 flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3 lg:gap-4">
        <span className="text-2xl lg:text-3xl">🐝</span>
        <h1 className="font-display font-semibold text-xl lg:text-2xl tracking-wide">
          <span className="text-accent">HIGH</span>
          <span className="text-text">SWARM</span>
        </h1>
        <nav className="header-nav flex items-center gap-4 lg:gap-6 ml-4 lg:ml-6">
          <a href="https://github.com/joelhooks/atproto-agent-network" target="_blank" rel="noopener noreferrer" className="text-text-dim hover:text-accent text-xs transition-colors">GitHub ↗</a>
          <a href="https://agent-network-production.joelhooks.workers.dev/health" target="_blank" rel="noopener noreferrer" className="text-text-dim hover:text-accent text-xs transition-colors">API ↗</a>
        </nav>
      </div>
      <StatusPill status={connectionStatus} wsStatus={wsStatus} />
    </header>
  )
}
