import { StatusPill } from './ui/StatusPill'
import type { ConnectionStatus, WebSocketStatus } from '../lib/types'

export interface HeaderProps {
  connectionStatus: ConnectionStatus
  wsStatus: WebSocketStatus
}

export function Header({ connectionStatus, wsStatus }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-brand">
        <span style={{ fontSize: '1.5rem' }}>{'\uD83D\uDC1D'}</span>
        <h1 className="header-logo">
          <span className="header-logo-accent">HIGH</span>
          <span className="header-logo-text">SWARM</span>
        </h1>
        <nav className="header-nav">
          <a href="https://github.com/joelhooks/atproto-agent-network" target="_blank" rel="noopener noreferrer">GitHub {'\u2197'}</a>
          <a href="https://agent-network-production.joelhooks.workers.dev/health" target="_blank" rel="noopener noreferrer">API {'\u2197'}</a>
        </nav>
      </div>
      <StatusPill status={connectionStatus} wsStatus={wsStatus} />
    </header>
  )
}
