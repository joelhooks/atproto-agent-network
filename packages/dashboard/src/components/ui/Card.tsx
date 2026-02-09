import type { ReactNode } from 'react'

export function Card({ children, className = '', onClick, expanded = false }: {
  children: ReactNode
  className?: string
  onClick?: () => void
  expanded?: boolean
}) {
  return (
    <div
      className={`agent-card ${expanded ? 'agent-card-expanded' : ''} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  )
}
