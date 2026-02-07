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

// TODO: X25519 key generation and DEK encryption
// See .agents/skills/envelope-encryption for full implementation
