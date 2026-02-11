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

export interface AgentProfile {
  status?: string        // "playing RPG", "idle", "thinking"
  currentFocus?: string  // "Exploring dungeon room 3"
  mood?: string          // "excited", "cautious"
  avatar?: string        // emoji or URL
  updatedAt?: number     // epoch ms
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
  webhookUrl?: string
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

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'legendary'
export type ItemSlot = 'weapon' | 'armor' | 'consumable' | 'trinket'

export interface LootItem {
  name: string
  rarity: ItemRarity
  slot: ItemSlot
  effects: Array<{ stat: string; bonus: number }>
  consumable?: { type: 'heal' | 'mp' | 'buff'; amount: number }
  gold?: number
  description: string
}

export interface PersistentCharacter {
  name: string
  klass: string
  level: number
  xp: number
  maxHp: number
  maxMp: number
  skills: Record<string, number>
  backstory: string
  motivation: string
  appearance: string
  personalityTraits: string[]
  adventureLog: string[]
  achievements: string[]
  inventory: LootItem[]
  createdAt: number
  updatedAt: number
  gamesPlayed: number
  deaths: number
  dead: boolean
  diedAt?: number
  causeOfDeath?: string
}

export interface NetworkPeer {
  did: string
  relay: string
  publicKey: string
  trustLevel: 'open' | 'allowlist' | 'verified' | 'private'
  connectedAt?: number
}
