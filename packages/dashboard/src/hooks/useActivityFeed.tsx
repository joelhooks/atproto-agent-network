import { createContext, useContext, useState, useRef, useCallback, useReducer, type ReactNode } from 'react'
import type { DashboardActivityEvent } from '../activity'

interface ActivityFeedContextType {
  events: DashboardActivityEvent[]
  addEvent: (ev: DashboardActivityEvent) => void
  stats: { memories: number; messages: number }
  setStats: (s: { memories: number; messages: number }) => void
  networkBirthday: number | null
  setNetworkBirthday: (ts: number) => void
}

const ActivityFeedContext = createContext<ActivityFeedContextType | null>(null)

export function ActivityFeedProvider({ children }: { children: ReactNode }) {
  const eventsRef = useRef<DashboardActivityEvent[]>([])
  const seenRef = useRef(new Set<string>())
  const rafRef = useRef<number | null>(null)
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const [stats, setStats] = useState({ memories: 0, messages: 0 })
  const [networkBirthday, setNetworkBirthday] = useState<number | null>(null)

  const addEvent = useCallback((ev: DashboardActivityEvent) => {
    const key = `${ev.agent}:${ev.type}:${ev.timestamp}:${ev.summary}`
    if (seenRef.current.has(key)) return
    seenRef.current.add(key)

    eventsRef.current.push(ev)
    eventsRef.current.sort((a, b) =>
      (new Date(b.timestamp).getTime() || 0) - (new Date(a.timestamp).getTime() || 0)
    )
    if (eventsRef.current.length > 250) {
      eventsRef.current = eventsRef.current.slice(0, 250)
    }

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      forceRender()
      rafRef.current = null
    })
  }, [])

  const visibleEvents = eventsRef.current.slice(0, 120)

  return (
    <ActivityFeedContext.Provider value={{ events: visibleEvents, addEvent, stats, setStats, networkBirthday, setNetworkBirthday }}>
      {children}
    </ActivityFeedContext.Provider>
  )
}

export function useActivityFeed(): ActivityFeedContextType {
  const ctx = useContext(ActivityFeedContext)
  if (!ctx) throw new Error('useActivityFeed must be used within ActivityFeedProvider')
  return ctx
}
