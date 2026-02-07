import { describe, expect, it } from 'vitest'

import { D1MockDatabase, type RecordRow } from './d1-mock'

describe('D1MockDatabase', () => {
  it('inserts and retrieves records by id and did', async () => {
    const db = new D1MockDatabase()
    const id = 'did:cf:test/agent.memory.note/0001'
    const did = 'did:cf:test'
    const collection = 'agent.memory.note'
    const rkey = '0001'
    const ciphertext = new Uint8Array([1, 2, 3])
    const encryptedDek = new Uint8Array([4, 5, 6])
    const nonce = new Uint8Array([7, 8, 9])
    const createdAt = '2026-02-07T00:00:00.000Z'

    await db
      .prepare(
        'INSERT INTO records (id, did, collection, rkey, ciphertext, encrypted_dek, nonce, public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, did, collection, rkey, ciphertext, encryptedDek, nonce, 0, createdAt)
      .run()

    const row = await db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, did)
      .first<RecordRow>()

    expect(row).toEqual(
      expect.objectContaining({
        id,
        did,
        collection,
        rkey,
        public: 0,
        created_at: createdAt,
      })
    )
    expect(row?.ciphertext).toBeInstanceOf(Uint8Array)
    expect(row?.encrypted_dek).toBeInstanceOf(Uint8Array)
    expect(row?.nonce).toBeInstanceOf(Uint8Array)

    const missing = await db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, 'did:cf:other')
      .first()

    expect(missing).toBeNull()
  })
})
