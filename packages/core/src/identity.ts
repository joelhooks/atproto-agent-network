/**
 * DID and identity utilities
 * 
 * did:cf:<durable-object-id> format
 */

export function createDid(doId: string): string {
  return `did:cf:${doId}`
}

export function parseDid(did: string): { method: string; id: string } | null {
  const match = did.match(/^did:(\w+):(.+)$/)
  if (!match) return null
  return { method: match[1], id: match[2] }
}

export function isLocalDid(did: string): boolean {
  return did.startsWith('did:cf:')
}

export function isFederatedDid(did: string): boolean {
  return did.includes('@')
}

export function parseFederatedDid(did: string): { did: string; network: string } | null {
  const match = did.match(/^(did:\w+:[^@]+)@(.+)$/)
  if (!match) return null
  return { did: match[1], network: match[2] }
}

/**
 * Generate timestamp-based ID (TID) for records
 * Compatible with AT Protocol
 */
export function generateTid(): string {
  const now = Date.now()
  const timestamp = now.toString(36).padStart(10, '0')
  const random = crypto.getRandomValues(new Uint8Array(4))
  const suffix = Array.from(random).map(b => b.toString(36)).join('').slice(0, 4)
  return `${timestamp}${suffix}`
}
