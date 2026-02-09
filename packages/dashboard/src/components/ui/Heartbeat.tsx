export function Heartbeat({ active, className = '' }: { active: boolean; className?: string }) {
  return (
    <div
      className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${active ? 'bg-green' : 'bg-border'} ${className}`}
      style={active ? {
        boxShadow: '0 0 0 1px oklch(0.75 0.18 155 / 0.3) inset, 0 0 14px oklch(0.75 0.18 155 / 0.2)',
        animation: 'heartbeat 1.2s ease-in-out infinite',
      } : undefined}
      title={active ? 'loop active' : 'loop idle'}
    />
  )
}
