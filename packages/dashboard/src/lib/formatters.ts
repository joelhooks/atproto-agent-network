export function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function truncate(str: unknown, max = 140): string {
  const s = typeof str === 'string' ? str : str === null || str === undefined ? '' : String(str)
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '\u2026'
}

export function truncateDid(did: unknown): string {
  const s = typeof did === 'string' ? did : ''
  if (!s || s.length < 20) return s
  const parts = s.split(':')
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}:${parts[2].slice(0, 8)}\u2026`
  return s.slice(0, 12) + '\u2026'
}

export function resolveDidToName(
  did: string,
  agents: Map<string, { did?: string; name: string }>
): string {
  for (const [name, agent] of agents) {
    if (agent.did === did) return name
  }
  return truncateDid(did)
}
