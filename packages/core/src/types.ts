/**
 * Core types for the agent network
 */

export interface AgentIdentity {
  did: string                    // did:cf:<durable-object-id>
  signingKey: CryptoKeyPair      // Ed25519 for signatures
  encryptionKey: CryptoKeyPair   // X25519 for encryption
  createdAt: number
  rotatedAt?: number
}

export interface EncryptedRecord {
  id: string
  collection: string
  ciphertext: Uint8Array
  encryptedDek: Uint8Array
  nonce: Uint8Array
  public: boolean
  recipients?: string[]
  createdAt: string
}

export interface AgentEvent {
  id: string
  agent_did: string
  session_id: string
  event_type: string
  outcome: 'success' | 'error' | 'timeout' | 'skipped'
  timestamp: string
  duration_ms?: number
  trace_id?: string
  span_id: string
  parent_span_id?: string
  context: Record<string, unknown>
  reasoning?: DecisionReasoning
  error?: EventError
}

export interface DecisionReasoning {
  decision: string
  rationale: string
  alternatives?: string[]
  confidence?: number
}

export interface EventError {
  code: string
  message: string
  stack?: string
  retryable: boolean
}

export interface NetworkPeer {
  did: string
  relay: string
  publicKey: string
  trustLevel: 'open' | 'allowlist' | 'verified' | 'private'
  connectedAt?: number
}
