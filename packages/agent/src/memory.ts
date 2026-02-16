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

export interface EncryptedMemorySharedListOptions {
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

interface SharedRecordsRow {
  id: number
  record_id: string
  recipient_did: string
  encrypted_dek: Uint8Array | ArrayBuffer | ArrayBufferView
  shared_at: string
}

function decodeBase64ToBytes(input: string): Uint8Array {
  const normalized = input
    .trim()
    // base64url -> base64
    .replace(/-/g, '+')
    .replace(/_/g, '/')

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  // atob is available in Workers (and in modern Node), but keep a Buffer fallback.
  if (typeof atob === 'function') {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BufferCtor = (globalThis as any).Buffer as undefined | {
    from(data: string, encoding: 'base64'): Uint8Array
  }
  if (BufferCtor) {
    return new Uint8Array(BufferCtor.from(padded, 'base64'))
  }

  throw new Error('base64 decode unsupported in this runtime')
}

function toUint8Array(value: unknown, label: string): Uint8Array {
  // Miniflare/D1 can return ArrayBuffers from a different JS realm than the
  // Worker runtime. Avoid `instanceof` checks which break across realms.
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array(value as ArrayBuffer)
  }
  if (typeof value === 'string') {
    return decodeBase64ToBytes(value)
  }
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return Uint8Array.from(value)
  }
  if (value && typeof value === 'object') {
    const asRecord = value as Record<string, unknown>
    // Node Buffer JSON shape: { type: 'Buffer', data: number[] }
    if (
      asRecord.type === 'Buffer' &&
      Array.isArray(asRecord.data) &&
      asRecord.data.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
    ) {
      return Uint8Array.from(asRecord.data as number[])
    }
  }

  const tag = Object.prototype.toString.call(value)
  throw new Error(`${label} must be bytes (received ${typeof value} ${tag})`)
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
      try {
        entries.push({ id: row.id, record: await this.decodeRow<T>(row) })
      } catch {
        // Skip records that can't be decrypted (e.g. encrypted with a
        // previous identity's keys after DO storage was wiped).
        continue
      }
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

    try {
      return await this.decodeRow<T>(row)
    } catch {
      // Record encrypted with a previous identity's keys — treat as missing.
      return null
    }
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

    if (row.encrypted_dek === null) {
      throw new Error('EncryptedMemory.update missing encrypted_dek for private record')
    }
    const encryptedDek = toUint8Array(row.encrypted_dek, 'encrypted_dek')
    const dek = await decryptDekWithPrivateKey(
      encryptedDek,
      this.identity.encryptionKey.privateKey
    )
    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    const ciphertext = await encryptWithDek(plaintext, dek, nonce)

    await this.db
      .prepare(
        `UPDATE records
         SET ciphertext = ?, encrypted_dek = ?, nonce = ?, public = ?, updated_at = ?
         WHERE id = ? AND did = ?`
      )
      // Preserve DEK so existing shared_records entries stay valid across updates.
      .bind(ciphertext, encryptedDek, nonce, 0, updatedAt, id, this.identity.did)
      .run()

    return true
  }

  async share(
    id: string,
    recipientDid: string,
    recipientPublicKey: CryptoKey | string
  ): Promise<boolean> {
    if (!id) {
      throw new Error('EncryptedMemory.share requires an id')
    }
    if (typeof recipientDid !== 'string' || recipientDid.length === 0) {
      throw new Error('EncryptedMemory.share requires a recipient DID')
    }
    if (recipientDid === this.identity.did) {
      throw new Error('EncryptedMemory.share recipient DID must be different from the sender')
    }

    const row = await this.db
      .prepare('SELECT * FROM records WHERE id = ? AND did = ?')
      .bind(id, this.identity.did)
      .first<RecordsRow>()

    if (!row) return false
    if (row.deleted_at) return false

    const isPublic = row.public === true || Number(row.public) === 1 || row.encrypted_dek === null
    if (isPublic) {
      throw new Error('EncryptedMemory.share cannot share public records')
    }

    if (row.encrypted_dek === null) {
      throw new Error('EncryptedMemory.share missing encrypted_dek for private record')
    }
    const encryptedDek = toUint8Array(row.encrypted_dek, 'encrypted_dek')
    const dek = await decryptDekWithPrivateKey(
      encryptedDek,
      this.identity.encryptionKey.privateKey
    )

    const recipientKey = await resolveX25519PublicKey(recipientPublicKey)
    const sharedDek = await encryptDekForPublicKey(dek, recipientKey)
    const sharedAt = new Date().toISOString()

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO shared_records (record_id, recipient_did, encrypted_dek, shared_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(id, recipientDid, sharedDek, sharedAt)
      .run()

    return true
  }

  async retrieveShared<T = EncryptedMemoryRecord>(id: string): Promise<T | null> {
    const shared = await this.db
      .prepare('SELECT * FROM shared_records WHERE record_id = ? AND recipient_did = ?')
      .bind(id, this.identity.did)
      .first<SharedRecordsRow>()

    if (!shared) return null

    const row = await this.db
      .prepare('SELECT * FROM records WHERE id = ?')
      .bind(id)
      .first<RecordsRow>()

    if (!row) return null
    if (row.deleted_at) return null

    const ciphertext = toUint8Array(row.ciphertext, 'ciphertext')
    const nonce = toUint8Array(row.nonce, 'nonce')
    const isPublic = row.public === true || Number(row.public) === 1 || row.encrypted_dek === null

    if (isPublic) {
      const decoded = new TextDecoder().decode(ciphertext)
      return JSON.parse(decoded) as T
    }

    try {
      const sharedDek = toUint8Array(shared.encrypted_dek, 'encrypted_dek')
      const dek = await decryptDekWithPrivateKey(
        sharedDek,
        this.identity.encryptionKey.privateKey
      )
      const plaintext = await decryptWithDek(ciphertext, dek, nonce)
      const decoded = new TextDecoder().decode(plaintext)
      return JSON.parse(decoded) as T
    } catch {
      return null
    }
  }

  async listShared<T = EncryptedMemoryRecord>(
    options: EncryptedMemorySharedListOptions = {}
  ): Promise<Array<EncryptedMemoryListEntry<T>>> {
    const limit = normalizeLimit(options.limit)
    const rows = await this.db
      .prepare('SELECT * FROM shared_records WHERE recipient_did = ?')
      .bind(this.identity.did)
      .all<SharedRecordsRow>()

    const visible = rows.results
      .slice()
      .sort((a, b) => b.shared_at.localeCompare(a.shared_at))
      .slice(0, limit)

    const entries: Array<EncryptedMemoryListEntry<T>> = []
    for (const share of visible) {
      const recordRow = await this.db
        .prepare('SELECT * FROM records WHERE id = ?')
        .bind(share.record_id)
        .first<RecordsRow>()

      if (!recordRow) continue
      if (recordRow.deleted_at) continue
      if (options.collection && recordRow.collection !== options.collection) continue

      try {
        const record = await this.decodeSharedRow<T>(recordRow, share)
        entries.push({ id: share.record_id, record })
      } catch {
        // Skip records that can't be decrypted (identity key mismatch).
        continue
      }
    }

    return entries
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

  private async decodeSharedRow<T>(row: RecordsRow, shared: SharedRecordsRow): Promise<T> {
    const ciphertext = toUint8Array(row.ciphertext, 'ciphertext')
    const nonce = toUint8Array(row.nonce, 'nonce')
    const isPublic = row.public === true || Number(row.public) === 1 || row.encrypted_dek === null

    if (isPublic) {
      const decoded = new TextDecoder().decode(ciphertext)
      return JSON.parse(decoded) as T
    }

    const encryptedDek = toUint8Array(shared.encrypted_dek, 'encrypted_dek')
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

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_LOOKUP = new Map(BASE58_ALPHABET.split('').map((char, index) => [char, index]))

function decodeBase58btc(multibase: string): Uint8Array {
  if (typeof multibase !== 'string' || !multibase.startsWith('z')) {
    throw new Error(`Expected base58btc multibase string, received: ${String(multibase)}`)
  }

  const encoded = multibase.slice(1)
  let value = 0n

  for (const char of encoded) {
    const digit = BASE58_LOOKUP.get(char)
    if (digit === undefined) {
      throw new Error(`Invalid base58 character: ${char}`)
    }
    value = value * 58n + BigInt(digit)
  }

  const bytes: number[] = []
  while (value > 0n) {
    bytes.push(Number(value % 256n))
    value /= 256n
  }
  bytes.reverse()

  let leadingZeros = 0
  for (const char of encoded) {
    if (char !== '1') break
    leadingZeros += 1
  }

  const result = new Uint8Array(leadingZeros + bytes.length)
  result.set(bytes, leadingZeros)
  return result
}

function isCryptoKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey !== 'function') return false
  return value instanceof CryptoKey
}

async function resolveX25519PublicKey(value: CryptoKey | string): Promise<CryptoKey> {
  if (isCryptoKey(value)) {
    if (value.type !== 'public' || value.algorithm.name !== 'X25519') {
      throw new Error('recipientPublicKey must be an X25519 public key')
    }
    return value
  }

  const decoded = decodeBase58btc(value)
  // multicodec prefix for X25519 public keys: 0xec 0x01
  if (decoded.length !== 34 || decoded[0] !== 0xec || decoded[1] !== 0x01) {
    throw new Error('recipientPublicKey must be a multicodec X25519 public key')
  }

  const raw = decoded.slice(2)
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'X25519' },
    true,
    []
  )
}
