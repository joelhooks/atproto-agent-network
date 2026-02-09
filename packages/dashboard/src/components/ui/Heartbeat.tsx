export function Heartbeat({ active, className = '' }: { active: boolean; className?: string }) {
  return (
    <span
      className={`${active ? 'heartbeat-active' : 'heartbeat-idle'} ${className}`}
      title={active ? 'loop active' : 'loop idle'}
      style={{ fontSize: '0.6rem', lineHeight: 1, flexShrink: 0 }}
    >
      {active ? '\u25CF' : '\u25CB'}
    </span>
  )
}
