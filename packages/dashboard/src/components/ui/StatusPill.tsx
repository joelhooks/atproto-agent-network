import type { ConnectionStatus, WebSocketStatus } from '../../lib/types'

export function StatusPill({ status, wsStatus, className = '' }: {
  status: ConnectionStatus
  connectionStatus?: ConnectionStatus
  wsStatus?: WebSocketStatus
  className?: string
}) {
  const dotClass = status === 'online' ? 'status-dot-online' : status === 'connecting' ? 'status-dot-connecting' : 'status-dot-offline'
  const statusText = status === 'online' ? 'connected' : status === 'connecting' ? 'connecting...' : 'offline'

  return (
    <div className={`status-pill ${className}`}>
      <span className={dotClass}>
        {status === 'online' ? '\u25CF' : status === 'connecting' ? '\u25D0' : '\u25CB'}
      </span>
      <span className="status-text">{statusText}</span>
      {wsStatus === 'live' && <span className="status-ws-live">{'\u26A1'} live</span>}
      {wsStatus === 'polling' && <span className="status-ws-polling">{'\u25CB'} polling</span>}
    </div>
  )
}
