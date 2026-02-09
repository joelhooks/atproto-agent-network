import { useEffect, useRef, useState, useCallback } from 'react'
import type { WebSocketStatus } from '../lib/types'
import type { DashboardActivityEvent } from '../activity'
import { WS_BASE, safeJsonParse } from '../lib/api'
import { normalizeAgentEvent } from '../activity'
import { useActivityFeed } from './useActivityFeed'

export function useWebSocket(
  agentName: string,
  opts?: { onLoopEvent?: (normalized: DashboardActivityEvent, raw: unknown) => void }
) {
  const { addEvent } = useActivityFeed()
  const [wsStatus, setWsStatus] = useState<WebSocketStatus>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const connect = useCallback(() => {
    if (wsRef.current) return
    try {
      const ws = new WebSocket(`${WS_BASE}/agents/${encodeURIComponent(agentName)}/ws`)
      wsRef.current = ws

      ws.onopen = () => { if (mountedRef.current) setWsStatus('live') }

      ws.onmessage = (event) => {
        const data = safeJsonParse(event.data)
        const normalized = normalizeAgentEvent(data, { agentNameHint: agentName })
        if (!normalized) return
        addEvent(normalized)
        opts?.onLoopEvent?.(normalized, data)
      }

      ws.onclose = () => {
        wsRef.current = null
        if (mountedRef.current) {
          setWsStatus('polling')
          reconnectRef.current = setTimeout(connect, 5_000)
        }
      }

      ws.onerror = () => { try { ws.close() } catch {} }
    } catch { if (mountedRef.current) setWsStatus('disconnected') }
  }, [agentName, addEvent, opts])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) { try { wsRef.current.close() } catch {} wsRef.current = null }
    }
  }, [connect])

  return { wsStatus }
}
