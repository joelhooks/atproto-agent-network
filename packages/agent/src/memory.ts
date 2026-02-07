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
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
}

export interface EncryptedMemoryRecord {
  $type: string
  [key: string]: unknown
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

  async retrieve<T = EncryptedMemoryRecord>(id: string): Promise<T | null> {
    const row = await this.db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, this.identity.did)
      .first<RecordsRow>()

    if (!row) return null

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
