/**
 * Envelope encryption utilities
 * 
 * Pattern: DEK per record, encrypted with agent's public key
 */

function asBufferSource(bytes: Uint8Array): BufferSource {
  // TypeScript's lib types can be stricter than the WebCrypto runtime here
  // (e.g. ArrayBuffer vs SharedArrayBuffer). We only deal in Uint8Array bytes.
  return bytes as unknown as BufferSource
}

export async function generateDek(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32))
}

export async function generateNonce(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(12))
}

export async function generateX25519Keypair(): Promise<CryptoKeyPair> {
  const key = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  )
  if (!('publicKey' in key)) throw new Error('Expected X25519 CryptoKeyPair')
  return key
}

export async function generateEd25519Keypair(): Promise<CryptoKeyPair> {
  const key = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  )
  if (!('publicKey' in key)) throw new Error('Expected Ed25519 CryptoKeyPair')
  return key
}

export type StoredKeyAlgorithm = 'Ed25519' | 'X25519'

export interface StoredCryptoKeyPairJwk {
  algorithm: StoredKeyAlgorithm
  publicJwk: JsonWebKey
  privateJwk: JsonWebKey
}

const KEYPAIR_USAGES: Record<StoredKeyAlgorithm, { public: KeyUsage[]; private: KeyUsage[] }> = {
  Ed25519: { public: ['verify'], private: ['sign'] },
  X25519: { public: [], private: ['deriveBits'] },
}

function assertStoredKeyAlgorithm(value: unknown): asserts value is StoredKeyAlgorithm {
  if (value !== 'Ed25519' && value !== 'X25519') {
    throw new Error(`Unsupported key algorithm: ${String(value)}`)
  }
}

export async function exportCryptoKeyPairJwk(
  keypair: CryptoKeyPair
): Promise<StoredCryptoKeyPairJwk> {
  const algorithm = keypair.privateKey.algorithm.name
  assertStoredKeyAlgorithm(algorithm)

  if (keypair.publicKey.algorithm.name !== algorithm) {
    throw new Error('CryptoKeyPair algorithm mismatch')
  }

  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keypair.publicKey),
    crypto.subtle.exportKey('jwk', keypair.privateKey),
  ])

  return { algorithm, publicJwk, privateJwk }
}

export async function importCryptoKeyPairJwk(
  stored: StoredCryptoKeyPairJwk
): Promise<CryptoKeyPair> {
  assertStoredKeyAlgorithm(stored.algorithm)
  const usages = KEYPAIR_USAGES[stored.algorithm]
  const algorithm = { name: stored.algorithm }

  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.importKey('jwk', stored.publicJwk, algorithm, true, usages.public),
    crypto.subtle.importKey('jwk', stored.privateJwk, algorithm, true, usages.private),
  ])

  return { publicKey, privateKey }
}

export async function deriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256
  )

  return new Uint8Array(bits)
}

export async function encryptWithDek(
  plaintext: Uint8Array,
  dek: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    asBufferSource(dek),
    'AES-GCM',
    false,
    ['encrypt']
  )
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce) },
    key,
    asBufferSource(plaintext)
  )
  
  return new Uint8Array(ciphertext)
}

export async function decryptWithDek(
  ciphertext: Uint8Array,
  dek: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    asBufferSource(dek),
    'AES-GCM',
    false,
    ['decrypt']
  )
  
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce) },
    key,
    asBufferSource(ciphertext)
  )
  
  return new Uint8Array(plaintext)
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const MULTICODEC_PREFIX: Record<string, Uint8Array> = {
  Ed25519: new Uint8Array([0xed, 0x01]),
  X25519: new Uint8Array([0xec, 0x01]),
}

function encodeBase58btc(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte)
  }

  let encoded = ''
  while (value > 0n) {
    const mod = value % 58n
    encoded = BASE58_ALPHABET[Number(mod)] + encoded
    value /= 58n
  }

  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) {
    encoded = `1${encoded}`
  }

  return `z${encoded}`
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  if (publicKey.type !== 'public') {
    throw new Error('exportPublicKey requires a public key')
  }

  const algoName = publicKey.algorithm.name
  const prefix = MULTICODEC_PREFIX[algoName]
  if (!prefix) {
    throw new Error(`Unsupported public key algorithm: ${algoName}`)
  }

  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
  const payload = new Uint8Array(prefix.length + raw.length)
  payload.set(prefix, 0)
  payload.set(raw, prefix.length)

  return encodeBase58btc(payload)
}

const ENVELOPE_VERSION = 1
const ENVELOPE_SALT_LENGTH = 16
const ENVELOPE_NONCE_LENGTH = 12
const ENVELOPE_PUBLIC_KEY_LENGTH = 32
const ENVELOPE_INFO = new TextEncoder().encode('atproto-agent-network:dek')

function assertEnvelopeLength(encryptedDek: Uint8Array): void {
  const minimum = 1 + ENVELOPE_SALT_LENGTH + ENVELOPE_NONCE_LENGTH + ENVELOPE_PUBLIC_KEY_LENGTH + 1
  if (encryptedDek.length < minimum) {
    throw new Error('Encrypted DEK envelope is too short')
  }
}

function packEncryptedDek(params: {
  salt: Uint8Array
  nonce: Uint8Array
  ephemeralPublicKey: Uint8Array
  ciphertext: Uint8Array
}): Uint8Array {
  const { salt, nonce, ephemeralPublicKey, ciphertext } = params

  if (salt.length !== ENVELOPE_SALT_LENGTH) {
    throw new Error(`Envelope salt must be ${ENVELOPE_SALT_LENGTH} bytes`)
  }
  if (nonce.length !== ENVELOPE_NONCE_LENGTH) {
    throw new Error(`Envelope nonce must be ${ENVELOPE_NONCE_LENGTH} bytes`)
  }
  if (ephemeralPublicKey.length !== ENVELOPE_PUBLIC_KEY_LENGTH) {
    throw new Error(`Envelope public key must be ${ENVELOPE_PUBLIC_KEY_LENGTH} bytes`)
  }

  const payload = new Uint8Array(
    1 +
      ENVELOPE_SALT_LENGTH +
      ENVELOPE_NONCE_LENGTH +
      ENVELOPE_PUBLIC_KEY_LENGTH +
      ciphertext.length
  )

  let offset = 0
  payload[offset] = ENVELOPE_VERSION
  offset += 1
  payload.set(salt, offset)
  offset += ENVELOPE_SALT_LENGTH
  payload.set(nonce, offset)
  offset += ENVELOPE_NONCE_LENGTH
  payload.set(ephemeralPublicKey, offset)
  offset += ENVELOPE_PUBLIC_KEY_LENGTH
  payload.set(ciphertext, offset)

  return payload
}

function unpackEncryptedDek(encryptedDek: Uint8Array): {
  salt: Uint8Array
  nonce: Uint8Array
  ephemeralPublicKey: Uint8Array
  ciphertext: Uint8Array
} {
  assertEnvelopeLength(encryptedDek)

  let offset = 0
  const version = encryptedDek[offset]
  offset += 1
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported DEK envelope version: ${version}`)
  }

  const salt = encryptedDek.slice(offset, offset + ENVELOPE_SALT_LENGTH)
  offset += ENVELOPE_SALT_LENGTH
  const nonce = encryptedDek.slice(offset, offset + ENVELOPE_NONCE_LENGTH)
  offset += ENVELOPE_NONCE_LENGTH
  const ephemeralPublicKey = encryptedDek.slice(
    offset,
    offset + ENVELOPE_PUBLIC_KEY_LENGTH
  )
  offset += ENVELOPE_PUBLIC_KEY_LENGTH
  const ciphertext = encryptedDek.slice(offset)

  return { salt, nonce, ephemeralPublicKey, ciphertext }
}

async function deriveEnvelopeKey(
  sharedSecret: Uint8Array,
  salt: Uint8Array
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(sharedSecret),
    'HKDF',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asBufferSource(salt),
      info: asBufferSource(ENVELOPE_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptDekForPublicKey(
  dek: Uint8Array,
  recipientPublicKey: CryptoKey
): Promise<Uint8Array> {
  if (recipientPublicKey.algorithm.name !== 'X25519') {
    throw new Error('encryptDekForPublicKey requires an X25519 public key')
  }

  const ephemeralKeypair = await generateX25519Keypair()
  const sharedSecret = await deriveSharedSecret(
    ephemeralKeypair.privateKey,
    recipientPublicKey
  )

  const salt = crypto.getRandomValues(new Uint8Array(ENVELOPE_SALT_LENGTH))
  const nonce = crypto.getRandomValues(new Uint8Array(ENVELOPE_NONCE_LENGTH))
  const aesKey = await deriveEnvelopeKey(sharedSecret, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce) },
    aesKey,
    asBufferSource(dek)
  )

  const ephemeralRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralKeypair.publicKey)
  )

  return packEncryptedDek({
    salt,
    nonce,
    ephemeralPublicKey: ephemeralRaw,
    ciphertext: new Uint8Array(ciphertext),
  })
}

export async function decryptDekWithPrivateKey(
  encryptedDek: Uint8Array,
  recipientPrivateKey: CryptoKey
): Promise<Uint8Array> {
  if (recipientPrivateKey.algorithm.name !== 'X25519') {
    throw new Error('decryptDekWithPrivateKey requires an X25519 private key')
  }

  const { salt, nonce, ephemeralPublicKey, ciphertext } =
    unpackEncryptedDek(encryptedDek)

  const senderPublicKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(ephemeralPublicKey),
    { name: 'X25519' },
    true,
    []
  )

  const sharedSecret = await deriveSharedSecret(
    recipientPrivateKey,
    senderPublicKey
  )
  const aesKey = await deriveEnvelopeKey(sharedSecret, salt)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce) },
    aesKey,
    asBufferSource(ciphertext)
  )

  return new Uint8Array(plaintext)
}
