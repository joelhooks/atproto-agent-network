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

export type AgentGoalStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled'

export interface AgentGoal {
  id: string
  description: string
  priority: number
  status: AgentGoalStatus
  progress: number
  createdAt: number
  completedAt?: number
}

export interface AgentConfig {
  name: string
  personality: string // System prompt
  specialty: string
  model: string
  fastModel: string
  loopIntervalMs: number
  // Keep only the most recent N completed goals in the active config (and thus prompts).
  // Older completed goals are archived in Durable Object storage to prevent prompt bloat.
  maxCompletedGoals?: number
  goals: AgentGoal[]
  enabledTools: string[]
  // If present, only these environments are loaded. If absent, the runtime
  // may load all registered environments (see apps/network agent wiring).
  enabledEnvironments?: string[]
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
