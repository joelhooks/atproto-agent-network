import type {
  AgentEvent,
  AgentIdentity,
  EncryptedRecord,
  NetworkPeer,
} from './types'
import type {
  Handoff,
  MemoryDecision,
  MemoryNote,
  Message,
  TaskRequest,
  TaskResponse,
} from './lexicons'
import { createDid } from './identity'

const FIXTURE_TIME_MS = Date.parse('2026-02-07T00:00:00.000Z')
const TID_SUFFIX_BASE = 36 ** 4
let tidCounter = 0

export function resetFixtureState(): void {
  tidCounter = 0
}

export function createIsoTimestamp(offsetMs = 0): string {
  return new Date(FIXTURE_TIME_MS + offsetMs).toISOString()
}

export function createTidFixture(seed?: number): string {
  const counter = seed ?? tidCounter++
  const timestamp = (FIXTURE_TIME_MS + counter).toString(36).padStart(10, '0')
  const suffix = (counter % TID_SUFFIX_BASE).toString(36).padStart(4, '0')
  return `${timestamp}${suffix}`
}

export function createDidFixture(id = 'agent-1'): string {
  return createDid(id)
}

export function createFederatedDidFixture(id = 'agent-1', network = 'network.test'): string {
  return `${createDid(id)}@${network}`
}

export function createRecordIdFixture(options: {
  did?: string
  collection?: string
  rkey?: string | number
} = {}): string {
  const did = options.did ?? createDidFixture()
  const collection = options.collection ?? 'agent.memory.note'
  const rkeyInput = options.rkey ?? createTidFixture()
  const rkey = typeof rkeyInput === 'number' ? createTidFixture(rkeyInput) : rkeyInput
  return `${did}/${collection}/${rkey}`
}

export function createBytesFixture(length = 16, seed = 0): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (seed + i) % 256
  }
  return bytes
}

export function createAgentIdentityFixture(
  overrides: Partial<AgentIdentity> = {}
): AgentIdentity {
  const fakeKey = {} as CryptoKey
  const base: AgentIdentity = {
    did: createDidFixture(),
    signingKey: { publicKey: fakeKey, privateKey: fakeKey },
    encryptionKey: { publicKey: fakeKey, privateKey: fakeKey },
    createdAt: FIXTURE_TIME_MS,
  }
  return { ...base, ...overrides }
}

export function createEncryptedRecordFixture(
  overrides: Partial<EncryptedRecord> = {}
): EncryptedRecord {
  const base: EncryptedRecord = {
    id: createRecordIdFixture(),
    collection: 'agent.memory.note',
    ciphertext: createBytesFixture(24, 1),
    encryptedDek: createBytesFixture(32, 2),
    nonce: createBytesFixture(12, 3),
    public: false,
    createdAt: createIsoTimestamp(),
  }
  return { ...base, ...overrides }
}

export function createAgentEventFixture(
  overrides: Partial<AgentEvent> = {}
): AgentEvent {
  const base: AgentEvent = {
    id: createTidFixture(),
    agent_did: createDidFixture(),
    session_id: `session-${createTidFixture()}`,
    event_type: 'memory.store',
    outcome: 'success',
    timestamp: createIsoTimestamp(),
    duration_ms: 12,
    trace_id: `trace-${createTidFixture()}`,
    span_id: `span-${createTidFixture()}`,
    parent_span_id: undefined,
    context: { collection: 'agent.memory.note' },
  }
  return { ...base, ...overrides }
}

export function createNetworkPeerFixture(
  overrides: Partial<NetworkPeer> = {}
): NetworkPeer {
  const base: NetworkPeer = {
    did: createDidFixture(),
    relay: 'https://relay.test',
    publicKey: 'public-key-fixture',
    trustLevel: 'open',
    connectedAt: FIXTURE_TIME_MS,
  }
  return { ...base, ...overrides }
}

export function createMemoryNoteFixture(
  overrides: Partial<MemoryNote> = {}
): MemoryNote {
  const base: MemoryNote = {
    $type: 'agent.memory.note',
    summary: 'Fixture summary',
    text: 'Fixture text',
    tags: ['fixture', 'note'],
    source: 'test-utils',
    createdAt: createIsoTimestamp(),
  }
  return { ...base, ...overrides }
}

export function createMemoryDecisionFixture(
  overrides: Partial<MemoryDecision> = {}
): MemoryDecision {
  const base: MemoryDecision = {
    $type: 'agent.memory.decision',
    decision: 'Use envelope encryption',
    context: 'Fixture context',
    options: ['option-a', 'option-b'],
    rationale: 'Fixture rationale',
    status: 'accepted',
    createdAt: createIsoTimestamp(),
  }
  return { ...base, ...overrides }
}

export function createMessageFixture(
  overrides: Partial<Message> = {}
): Message {
  const base: Message = {
    $type: 'agent.comms.message',
    sender: createDidFixture('sender'),
    recipient: createDidFixture('recipient'),
    thread: `thread-${createTidFixture()}`,
    content: { kind: 'text', text: 'Hello from fixture' },
    priority: 3,
    createdAt: createIsoTimestamp(),
  }
  return {
    ...base,
    ...overrides,
    content: overrides.content ?? base.content,
  }
}

export function createTaskRequestFixture(
  overrides: Partial<TaskRequest> = {}
): TaskRequest {
  const base: TaskRequest = {
    $type: 'agent.comms.task',
    sender: createDidFixture('requester'),
    recipient: createDidFixture('worker'),
    task: 'Process fixture task',
    params: { urgency: 'low' },
    deadline: createIsoTimestamp(60_000),
    replyTo: createDidFixture('requester'),
    resultVisibility: 'private',
    createdAt: createIsoTimestamp(),
  }
  return { ...base, ...overrides }
}

export function createTaskResponseFixture(
  overrides: Partial<TaskResponse> = {}
): TaskResponse {
  const base: TaskResponse = {
    $type: 'agent.comms.response',
    sender: createDidFixture('worker'),
    recipient: createDidFixture('requester'),
    requestUri: `at://${createRecordIdFixture({
      did: createDidFixture('requester'),
      collection: 'agent.comms.task',
    })}`,
    status: 'completed',
    result: { ok: true },
    createdAt: createIsoTimestamp(),
  }
  return { ...base, ...overrides }
}

export function createHandoffFixture(
  overrides: Partial<Handoff> = {}
): Handoff {
  const base: Handoff = {
    $type: 'agent.comms.handoff',
    from: createDidFixture('from'),
    to: createDidFixture('to'),
    context: [
      {
        recordId: createRecordIdFixture({
          did: createDidFixture('from'),
          collection: 'agent.memory.note',
        }),
        encryptedDek: 'encrypted-dek-fixture',
      },
    ],
    reason: 'Fixture handoff',
    createdAt: createIsoTimestamp(),
  }
  return { ...base, ...overrides }
}
