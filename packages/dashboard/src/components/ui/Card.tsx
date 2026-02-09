import type { ReactNode } from 'react'

export function Card({ children, className = '', onClick, expanded = false }: {
  children: ReactNode
  className?: string
  onClick?: () => void
  expanded?: boolean
}) {
  return (
    <div
      className={`bg-surface-2 border border-border rounded-lg p-3.5 lg:p-4 transition-all duration-150 ${expanded ? 'border-accent bg-accent-dim' : 'hover:border-accent/50'} ${onClick ? 'cursor-pointer' : ''} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  )
}
