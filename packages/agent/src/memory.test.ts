import { describe, expect, it } from 'vitest'

import { generateEd25519Keypair, generateX25519Keypair } from '../../core/src/crypto'
import { D1MockDatabase } from '../../core/src/d1-mock'
import type { AgentIdentity } from '../../core/src/types'

import { EncryptedMemory } from './memory'

async function createIdentity(): Promise<AgentIdentity> {
  return {
    did: 'did:cf:agent-test',
    signingKey: await generateEd25519Keypair(),
    encryptionKey: await generateX25519Keypair(),
    createdAt: Date.now(),
  }
}

describe('EncryptedMemory', () => {
  it('stores encrypted records and retrieves the decrypted content', async () => {
    const identity = await createIdentity()
    const db = new D1MockDatabase()
    const memory = new EncryptedMemory(db, null, identity)

    const record = {
      $type: 'agent.memory.note',
      summary: 'Encrypted note',
      text: 'Keep this secret',
      createdAt: new Date().toISOString(),
    }

    const id = await memory.store(record)
    const row = db.records.get(id)

    expect(id).toContain(`${identity.did}/${record.$type}/`)
    expect(row).toBeDefined()
    expect(row?.encrypted_dek).toBeInstanceOf(Uint8Array)
    expect(row?.public).toBe(0)

    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    expect(row?.ciphertext).not.toEqual(plaintext)
    expect(row?.rkey).toBe(id.split('/').pop())

    const loaded = await memory.retrieve(id)
    expect(loaded).toEqual(record)
  })

  it('returns null when a record is missing', async () => {
    const identity = await createIdentity()
    const db = new D1MockDatabase()
    const memory = new EncryptedMemory(db, null, identity)

    await expect(memory.retrieve('missing')).resolves.toBeNull()
  })

  it('lists decrypted records and supports collection filtering', async () => {
    const identity = await createIdentity()
    const db = new D1MockDatabase()
    const memory = new EncryptedMemory(db, null, identity)

    const note = {
      $type: 'agent.memory.note',
      summary: 'Encrypted note',
      text: 'Keep this secret',
      createdAt: new Date().toISOString(),
    }
    const message = {
      $type: 'agent.comms.message',
      sender: 'did:cf:sender',
      recipient: 'did:cf:recipient',
      content: { kind: 'text', text: 'hello' },
      createdAt: new Date().toISOString(),
    }

    const noteId = await memory.store(note)
    const messageId = await memory.store(message)

    const all = await memory.list()
    expect(all.map((entry) => entry.id)).toEqual(expect.arrayContaining([noteId, messageId]))

    const notesOnly = await memory.list({ collection: 'agent.memory.note' })
    expect(notesOnly).toEqual([{ id: noteId, record: note }])
  })

  it('updates records in place (re-encrypts, sets updated_at)', async () => {
    const identity = await createIdentity()
    const db = new D1MockDatabase()
    const memory = new EncryptedMemory(db, null, identity)

    const original = {
      $type: 'agent.memory.note',
      summary: 'Initial',
      text: 'v1',
      createdAt: new Date().toISOString(),
    }

    const id = await memory.store(original)
    const before = db.records.get(id)
    const beforeCiphertext = before ? new Uint8Array(before.ciphertext) : null
    expect(before?.updated_at ?? null).toBeNull()

    const updated = {
      ...original,
      summary: 'Updated',
      text: 'v2',
    }

    await expect(memory.update(id, updated)).resolves.toBe(true)

    const after = db.records.get(id)
    expect(after?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}t/i)
    expect(after?.ciphertext).not.toEqual(beforeCiphertext)

    const loaded = await memory.retrieve(id)
    expect(loaded).toEqual(updated)
  })

  it('soft-deletes records (excluded from list and retrieval)', async () => {
    const identity = await createIdentity()
    const db = new D1MockDatabase()
    const memory = new EncryptedMemory(db, null, identity)

    const record = {
      $type: 'agent.memory.note',
      summary: 'To delete',
      text: 'bye',
      createdAt: new Date().toISOString(),
    }

    const id = await memory.store(record)

    await expect(memory.softDelete(id)).resolves.toBe(true)
    const row = db.records.get(id)
    expect(row?.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}t/i)

    await expect(memory.retrieve(id)).resolves.toBeNull()
    await expect(memory.list({ collection: 'agent.memory.note' })).resolves.toEqual([])

    await expect(memory.softDelete(id)).resolves.toBe(false)
    await expect(memory.update(id, record)).resolves.toBe(false)
  })
})
