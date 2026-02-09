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
    if (!networkBirthday) { setUptime('—'); return }
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
    <div className="stats-bar grid grid-cols-4 border-b border-border">
      {cells.map(cell => (
        <div key={cell.label} className="px-4 py-2.5 text-center border-r border-border last:border-r-0">
          <div className="text-accent font-semibold text-sm tabular-nums">{cell.value}</div>
          <div className="text-text-dim text-[0.6rem] uppercase tracking-widest mt-0.5">{cell.label}</div>
        </div>
      ))}
    </div>
  )
}
