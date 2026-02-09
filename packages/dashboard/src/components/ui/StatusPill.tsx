import type { ConnectionStatus, WebSocketStatus } from '../../lib/types'

export function StatusPill({ status, wsStatus, className = '' }: {
  status: ConnectionStatus
  connectionStatus?: ConnectionStatus
  wsStatus?: WebSocketStatus
  className?: string
}) {
  const dotColor = status === 'online' ? 'bg-green' : status === 'connecting' ? 'bg-accent' : 'bg-red'
  const statusText = status === 'online' ? 'connected' : status === 'connecting' ? 'connecting...' : 'offline'

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-2 border border-border text-[0.75rem] ${className}`}>
      <div
        className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}
        style={status === 'online' ? { animation: 'pulse 2s ease-in-out infinite' } : undefined}
      />
      <span className="text-text-dim">{statusText}</span>
      {wsStatus === 'live' && <span className="text-green text-[0.6rem] ml-1">⚡ live</span>}
      {wsStatus === 'polling' && <span className="text-text-dim text-[0.6rem] ml-1">◯ polling</span>}
    </div>
  )
}
