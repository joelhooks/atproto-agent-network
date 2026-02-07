import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAgentEventFixture,
  createAgentIdentityFixture,
  createBytesFixture,
  createDidFixture,
  createEncryptedRecordFixture,
  createFederatedDidFixture,
  createHandoffFixture,
  createMemoryDecisionFixture,
  createMemoryNoteFixture,
  createMessageFixture,
  createNetworkPeerFixture,
  createRecordIdFixture,
  createTaskRequestFixture,
  createTaskResponseFixture,
  createTidFixture,
  resetFixtureState,
} from './test-utils'

describe('test utilities', () => {
  beforeEach(() => resetFixtureState())

  it('creates deterministic TIDs when seeded', () => {
    const tidA = createTidFixture(42)
    const tidB = createTidFixture(42)

    expect(tidA).toBe(tidB)
    expect(tidA).toMatch(/^[0-9a-z]{14}$/)
  })

  it('creates distinct TIDs by default', () => {
    const first = createTidFixture()
    const second = createTidFixture()

    expect(first).not.toBe(second)
  })

  it('creates dids and record ids with defaults', () => {
    const did = createDidFixture('agent-x')
    const federated = createFederatedDidFixture('agent-x', 'net.test')
    const recordId = createRecordIdFixture({
      did,
      collection: 'agent.memory.note',
      rkey: 'rkey123',
    })

    expect(did).toBe('did:cf:agent-x')
    expect(federated).toBe('did:cf:agent-x@net.test')
    expect(recordId).toBe('did:cf:agent-x/agent.memory.note/rkey123')
  })

  it('creates lexicon fixtures with required fields', () => {
    const note = createMemoryNoteFixture()
    const decision = createMemoryDecisionFixture()
    const message = createMessageFixture()
    const taskRequest = createTaskRequestFixture()
    const taskResponse = createTaskResponseFixture()
    const handoff = createHandoffFixture()

    expect(note.$type).toBe('agent.memory.note')
    expect(note.summary).toBeTruthy()
    expect(note.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/)

    expect(decision.$type).toBe('agent.memory.decision')
    expect(decision.decision).toBeTruthy()
    expect(decision.status).toBe('accepted')

    expect(message.$type).toBe('agent.comms.message')
    expect(message.sender).toMatch(/^did:/)
    expect(message.content.kind).toBe('text')

    expect(taskRequest.$type).toBe('agent.comms.task')
    expect(taskRequest.task).toBeTruthy()

    expect(taskResponse.$type).toBe('agent.comms.response')
    expect(taskResponse.status).toBe('completed')

    expect(handoff.$type).toBe('agent.comms.handoff')
    expect(handoff.context.length).toBeGreaterThan(0)
  })

  it('creates encrypted record fixtures with deterministic bytes', () => {
    const record = createEncryptedRecordFixture()

    expect(record.public).toBe(false)
    expect(record.ciphertext).toBeInstanceOf(Uint8Array)
    expect(record.encryptedDek).toHaveLength(32)
    expect(record.nonce).toHaveLength(12)
  })

  it('creates core fixtures with overrides', () => {
    const identity = createAgentIdentityFixture({ did: 'did:cf:override' })
    const event = createAgentEventFixture({ outcome: 'error' })
    const peer = createNetworkPeerFixture({ trustLevel: 'verified' })

    expect(identity.did).toBe('did:cf:override')
    expect(event.outcome).toBe('error')
    expect(peer.trustLevel).toBe('verified')
  })

  it('creates deterministic byte fixtures', () => {
    const bytes = createBytesFixture(4, 10)

    expect(Array.from(bytes)).toEqual([10, 11, 12, 13])
  })
})
