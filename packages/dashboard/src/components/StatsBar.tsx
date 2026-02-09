import { useState, useEffect } from 'react'
import { formatUptime } from '../lib/formatters'

export interface StatsBarProps {
  agentCount: number
  activeCount: number
  memories: number
  messages: number
  networkBirthday: number | null
}

export function StatsBar({ agentCount, activeCount, memories, messages, networkBirthday }: StatsBarProps) {
  const [uptime, setUptime] = useState('')

  useEffect(() => {
    if (!networkBirthday) { setUptime('\u2014'); return }
    const tick = () => setUptime(formatUptime(Date.now() - networkBirthday))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [networkBirthday])

  const cells: { label: string; value: string | number }[] = [
    { label: 'Agents', value: `${activeCount}/${agentCount}` },
    { label: 'Memories', value: memories },
    { label: 'Messages', value: messages },
    { label: 'Network Age', value: uptime },
  ]

  return (
    <div className="stats-bar">
      {cells.map(cell => (
        <div key={cell.label} className="stat-cell">
          <div className="stat-value">{cell.value}</div>
          <div className="stat-label">{cell.label}</div>
        </div>
      ))}
    </div>
  )
}
