import {
  decryptDekWithPrivateKey,
  decryptWithDek,
  encryptDekForPublicKey,
  encryptWithDek,
  generateDek,
  generateNonce,
} from '../../core/src/crypto'
import { generateTid } from '../../core/src/identity'
import type { AgentIdentity } from '../../core/src/types'

export interface D1PreparedStatementLike {
  bind(...params: unknown[]): D1PreparedStatementLike
  run(): Promise<unknown>
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
}

export interface EncryptedMemoryRecord {
  $type: string
  [key: string]: unknown
}

export interface EncryptedMemoryListOptions {
  collection?: string
  limit?: number
}

export interface EncryptedMemoryListEntry<T = EncryptedMemoryRecord> {
  id: string
  record: T
}

interface RecordsRow {
  id: string
  did: string
  collection: string
  rkey: string
  ciphertext: Uint8Array | ArrayBuffer | ArrayBufferView
  encrypted_dek: Uint8Array | ArrayBuffer | ArrayBufferView | null
  nonce: Uint8Array | ArrayBuffer | ArrayBufferView
  public: number | boolean
  created_at: string
  updated_at?: string | null
  deleted_at?: string | null
}

function toUint8Array(value: Uint8Array | ArrayBuffer | ArrayBufferView, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`${label} must be bytes`)
}

export class EncryptedMemory {
  private readonly db: D1DatabaseLike
  private readonly identity: AgentIdentity
  private readonly blobs: unknown

  constructor(db: D1DatabaseLike, blobs: unknown, identity: AgentIdentity) {
    this.db = db
    this.blobs = blobs
    this.identity = identity
  }

  async store(record: EncryptedMemoryRecord): Promise<string> {
    if (!record || typeof record !== 'object') {
      throw new Error('EncryptedMemory.store requires a record object')
    }

    if (typeof record.$type !== 'string' || record.$type.length === 0) {
      throw new Error('EncryptedMemory.store requires a $type string')
    }

    const collection = record.$type
    const rkey = generateTid()
    const id = `${this.identity.did}/${collection}/${rkey}`

    const dek = await generateDek()
    const nonce = await generateNonce()
    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    const ciphertext = await encryptWithDek(plaintext, dek, nonce)
    const encryptedDek = await encryptDekForPublicKey(
      dek,
      this.identity.encryptionKey.publicKey
    )

    await this.db
      .prepare(
        `INSERT INTO records (id, did, collection, rkey, ciphertext, encrypted_dek, nonce, public, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        this.identity.did,
        collection,
        rkey,
        ciphertext,
        encryptedDek,
        nonce,
        0,
        new Date().toISOString()
      )
      .run()

    return id
  }

  async list<T = EncryptedMemoryRecord>(
    options: EncryptedMemoryListOptions = {}
  ): Promise<Array<EncryptedMemoryListEntry<T>>> {
    const limit = normalizeLimit(options.limit)
    const rows = await this.loadRows(options.collection)

    const visible = rows
      .filter((row) => !row.deleted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)

    const entries: Array<EncryptedMemoryListEntry<T>> = []
    for (const row of visible) {
      entries.push({ id: row.id, record: await this.decodeRow<T>(row) })
    }

    return entries
  }

  async retrieve<T = EncryptedMemoryRecord>(id: string): Promise<T | null> {
    const row = await this.db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, this.identity.did)
      .first<RecordsRow>()

    if (!row) return null
    if (row.deleted_at) return null

    return this.decodeRow<T>(row)
  }

  async update(id: string, record: EncryptedMemoryRecord): Promise<boolean> {
    if (!record || typeof record !== 'object') {
      throw new Error('EncryptedMemory.update requires a record object')
    }

    if (typeof record.$type !== 'string' || record.$type.length === 0) {
      throw new Error('EncryptedMemory.update requires a $type string')
    }

    const row = await this.db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, this.identity.did)
      .first<RecordsRow>()

    if (!row) return false
    if (row.deleted_at) return false

    if (row.collection !== record.$type) {
      throw new Error('EncryptedMemory.update $type must match the existing record collection')
    }

    const isPublic = row.public === true || Number(row.public) === 1 || row.encrypted_dek === null
    const nonce = await generateNonce()
    const updatedAt = new Date().toISOString()

    if (isPublic) {
      const plaintextBytes = new TextEncoder().encode(JSON.stringify(record))
      await this.db
        .prepare(
          `UPDATE records
           SET ciphertext = ?, encrypted_dek = ?, nonce = ?, public = ?, updated_at = ?
           WHERE id = ? AND did = ?`
        )
        .bind(plaintextBytes, null, nonce, 1, updatedAt, id, this.identity.did)
        .run()
      return true
    }

    const dek = await generateDek()
    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    const ciphertext = await encryptWithDek(plaintext, dek, nonce)
    const encryptedDek = await encryptDekForPublicKey(dek, this.identity.encryptionKey.publicKey)

    await this.db
      .prepare(
        `UPDATE records
         SET ciphertext = ?, encrypted_dek = ?, nonce = ?, public = ?, updated_at = ?
         WHERE id = ? AND did = ?`
      )
      .bind(ciphertext, encryptedDek, nonce, 0, updatedAt, id, this.identity.did)
      .run()

    return true
  }

  async softDelete(id: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, this.identity.did)
      .first<RecordsRow>()

    if (!row) return false
    if (row.deleted_at) return false

    const deletedAt = new Date().toISOString()
    await this.db
      .prepare(
        `UPDATE records
         SET deleted_at = ?, updated_at = ?
         WHERE id = ? AND did = ?`
      )
      .bind(deletedAt, deletedAt, id, this.identity.did)
      .run()

    return true
  }

  private async loadRows(collection?: string): Promise<RecordsRow[]> {
    if (collection) {
      const result = await this.db
        .prepare('SELECT * FROM records WHERE did = ? AND collection = ?')
        .bind(this.identity.did, collection)
        .all<RecordsRow>()
      return result.results
    }

    const result = await this.db
      .prepare('SELECT * FROM records WHERE did = ?')
      .bind(this.identity.did)
      .all<RecordsRow>()
    return result.results
  }

  private async decodeRow<T>(row: RecordsRow): Promise<T> {
    const ciphertext = toUint8Array(row.ciphertext, 'ciphertext')
    const nonce = toUint8Array(row.nonce, 'nonce')
    const isPublic = row.public === true || Number(row.public) === 1

    if (isPublic || row.encrypted_dek === null) {
      const decoded = new TextDecoder().decode(ciphertext)
      return JSON.parse(decoded) as T
    }

    const encryptedDek = toUint8Array(row.encrypted_dek, 'encrypted_dek')
    const dek = await decryptDekWithPrivateKey(
      encryptedDek,
      this.identity.encryptionKey.privateKey
    )
    const plaintext = await decryptWithDek(ciphertext, dek, nonce)
    const decoded = new TextDecoder().decode(plaintext)
    return JSON.parse(decoded) as T
  }
}

function normalizeLimit(limit: unknown): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(Math.floor(parsed), 200)
}
