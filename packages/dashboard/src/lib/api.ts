export const API_BASE =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:8787'
    : 'https://agent-network.joelhooks.workers.dev'

export const WS_BASE = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://')

export async function fetchJson(
  url: string,
  opts?: { token?: string | null }
): Promise<any> {
  const headers: Record<string, string> = {}
  if (opts?.token) {
    headers.Authorization = `Bearer ${opts.token}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

export function safeJsonParse(input: unknown): unknown {
  if (typeof input !== 'string') return null
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}
