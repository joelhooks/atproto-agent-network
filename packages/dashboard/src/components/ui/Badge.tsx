import type { ReactNode } from 'react'

const variantMap: Record<string, string> = {
  default: 'foreground2',
  accent: 'yellow',
  success: 'green',
  error: 'red',
  dim: 'background3',
}

export function Badge({ children, variant = 'default', className = '' }: {
  children: ReactNode
  variant?: 'default' | 'accent' | 'success' | 'error' | 'dim'
  className?: string
  size?: string
}) {
  return (
    <span is-="badge" variant-={variantMap[variant] ?? 'foreground2'} cap-="round" className={className}>
      {children}
    </span>
  )
}
