import { describe, expect, it } from 'vitest'

import { generateEd25519Keypair, generateX25519Keypair } from '../../core/src/crypto'
import type { AgentIdentity } from '../../core/src/types'

import { EncryptedMemory } from './memory'

interface RecordRow {
  id: string
  did: string
  collection: string
  rkey: string
  ciphertext: Uint8Array
  encrypted_dek: Uint8Array | null
  nonce: Uint8Array
  public: number
  created_at: string
  updated_at?: string | null
}

class FakeD1Statement {
  private readonly params: unknown[]
  private readonly sql: string
  private readonly db: FakeD1Database

  constructor(db: FakeD1Database, sql: string, params: unknown[] = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }

  bind(...params: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.sql, params)
  }

  async run(): Promise<void> {
    await this.db.run(this.sql, this.params)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.params)
  }
}

class FakeD1Database {
  readonly records = new Map<string, RecordRow>()

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this, sql)
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = normalizeSql(sql)

    if (normalized.startsWith('insert into records')) {
      const [
        id,
        did,
        collection,
        rkey,
        ciphertext,
        encryptedDek,
        nonce,
        isPublic,
        createdAt,
      ] = params

      this.records.set(id as string, {
        id: id as string,
        did: did as string,
        collection: collection as string,
        rkey: rkey as string,
        ciphertext: asBytes(ciphertext, 'ciphertext'),
        encrypted_dek: encryptedDek ? asBytes(encryptedDek, 'encrypted_dek') : null,
        nonce: asBytes(nonce, 'nonce'),
        public: Number(isPublic),
        created_at: createdAt as string,
        updated_at: null,
      })
      return
    }

    throw new Error(`Unsupported SQL in FakeD1Database.run: ${normalized}`)
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const normalized = normalizeSql(sql)

    if (normalized.includes('from records') && normalized.includes('where id = ?')) {
      const [id, did] = params as [string, string]
      const row = this.records.get(id)
      if (!row) return null
      if (did && row.did !== did) return null
      return row as unknown as T
    }

    throw new Error(`Unsupported SQL in FakeD1Database.first: ${normalized}`)
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`${label} must be bytes`)
}

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
    const db = new FakeD1Database()
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
    const db = new FakeD1Database()
    const memory = new EncryptedMemory(db, null, identity)

    await expect(memory.retrieve('missing')).resolves.toBeNull()
  })
})
