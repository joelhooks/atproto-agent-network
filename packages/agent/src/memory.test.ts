import { describe, expect, it } from 'vitest'

import {
  encryptDekForPublicKey,
  encryptWithDek,
  generateDek,
  generateEd25519Keypair,
  generateNonce,
  generateX25519Keypair,
} from '../../core/src/crypto'
import { D1MockDatabase } from '../../core/src/d1-mock'
import type { AgentIdentity } from '../../core/src/types'

import { EncryptedMemory } from './memory'

async function createIdentity(did = 'did:cf:agent-test'): Promise<AgentIdentity> {
  return {
    did,
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

  it('shares a record by re-encrypting the DEK for the recipient (shared_records)', async () => {
    const alice = await createIdentity('did:cf:alice')
    const bob = await createIdentity('did:cf:bob')
    const intruder = await createIdentity('did:cf:intruder')
    const db = new D1MockDatabase()

    const aliceMemory = new EncryptedMemory(db, null, alice)
    const bobMemory = new EncryptedMemory(db, null, bob)
    const intruderMemory = new EncryptedMemory(db, null, intruder)

    const record = {
      $type: 'agent.memory.note',
      summary: 'Shared note',
      text: 'only bob should read this',
      createdAt: new Date().toISOString(),
    }

    const id = await aliceMemory.store(record)

    await expect(bobMemory.retrieve(id)).resolves.toBeNull()
    await expect(bobMemory.retrieveShared(id)).resolves.toBeNull()

    await expect(aliceMemory.share(id, bob.did, bob.encryptionKey.publicKey)).resolves.toBe(true)

    // Idempotent share (unique(record_id, recipient_did))
    await expect(aliceMemory.share(id, bob.did, bob.encryptionKey.publicKey)).resolves.toBe(true)
    expect(db.sharedRecords.size).toBe(1)

    await expect(intruderMemory.retrieveShared(id)).resolves.toBeNull()
    await expect(bobMemory.retrieveShared(id)).resolves.toEqual(record)
    await expect(bobMemory.listShared()).resolves.toEqual([{ id, record }])
  })

  it('keeps shared access working after the owner updates a record', async () => {
    const alice = await createIdentity('did:cf:alice-update')
    const bob = await createIdentity('did:cf:bob-update')
    const db = new D1MockDatabase()

    const aliceMemory = new EncryptedMemory(db, null, alice)
    const bobMemory = new EncryptedMemory(db, null, bob)

    const record = {
      $type: 'agent.memory.note',
      summary: 'Shared note',
      text: 'v1',
      createdAt: new Date().toISOString(),
    }

    const id = await aliceMemory.store(record)
    await expect(aliceMemory.share(id, bob.did, bob.encryptionKey.publicKey)).resolves.toBe(true)

    const updated = { ...record, text: 'v2' }
    await expect(aliceMemory.update(id, updated)).resolves.toBe(true)
    await expect(bobMemory.retrieveShared(id)).resolves.toEqual(updated)
  })

  it('decodes base64-encoded blob fields returned by some D1 runtimes', async () => {
    const identity = await createIdentity('did:cf:base64')
    const record = {
      $type: 'agent.memory.note',
      summary: 'Base64 blobs',
      text: 'decode me',
      createdAt: new Date().toISOString(),
    }

    const collection = record.$type
    const id = `${identity.did}/${collection}/test`

    const dek = await generateDek()
    const nonce = await generateNonce()
    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    const ciphertext = await encryptWithDek(plaintext, dek, nonce)
    const encryptedDek = await encryptDekForPublicKey(dek, identity.encryptionKey.publicKey)

    const bytesToBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

    const row = {
      id,
      did: identity.did,
      collection,
      rkey: 'test',
      ciphertext: bytesToBase64(ciphertext),
      encrypted_dek: bytesToBase64(encryptedDek),
      nonce: bytesToBase64(nonce),
      public: 0,
      created_at: new Date().toISOString(),
      updated_at: null,
      deleted_at: null,
    }

    const db = {
      prepare: (_sql: string) => {
        const params: unknown[] = []
        const stmt = {
          bind: (...next: unknown[]) => {
            params.length = 0
            params.push(...next)
            return stmt as any
          },
          run: async () => ({}),
          first: async () => {
            const [queryId, queryDid] = params
            if (queryId === id && queryDid === identity.did) return row as any
            return null
          },
          all: async () => ({ results: [] }),
        }
        return stmt
      },
    }

    const memory = new EncryptedMemory(db as any, null, identity)
    await expect(memory.retrieve(id)).resolves.toEqual(record)
  })
})
