import type { ReactNode } from 'react'

const variants: Record<string, string> = {
  default: 'bg-surface-2 text-text-dim border border-border',
  accent: 'bg-accent-dim text-accent border border-border',
  success: 'bg-green/10 text-green',
  error: 'bg-red/10 text-red',
  dim: 'bg-surface text-text-dim border border-border',
}

export function Badge({ children, variant = 'default', className = '' }: {
  children: ReactNode
  variant?: 'default' | 'accent' | 'success' | 'error' | 'dim'
  className?: string
  size?: string
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.65rem] inline-flex items-center ${variants[variant]} ${className}`}>
      {children}
    </span>
  )
}
