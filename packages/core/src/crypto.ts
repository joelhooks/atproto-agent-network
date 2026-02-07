/**
 * Envelope encryption utilities
 * 
 * Pattern: DEK per record, encrypted with agent's public key
 */

export async function generateDek(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32))
}

export async function generateNonce(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(12))
}

export async function generateX25519Keypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  )
}

export async function generateEd25519Keypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  )
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
    dek,
    'AES-GCM',
    false,
    ['encrypt']
  )
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    plaintext
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
    dek,
    'AES-GCM',
    false,
    ['decrypt']
  )
  
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext
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

// TODO: DEK encryption helpers
// See .agents/skills/envelope-encryption for full implementation
