---
name: envelope-encryption
description: Envelope encryption patterns with X25519 for agent memories. Use when implementing key generation, DEK management, encrypting/decrypting records, key rotation, or sharing encrypted data between agents. Triggers on encryption, X25519, DEK, envelope encryption, key exchange, crypto.
---

# Envelope Encryption

Every memory is encrypted with a per-record Data Encryption Key (DEK). The DEK is encrypted with the agent's public key.

## Why Envelope Encryption?

1. **Key rotation** — Rotate agent key without re-encrypting all records
2. **Sharing** — Re-encrypt DEK for recipient without touching content
3. **Performance** — Symmetric DEK is fast; asymmetric only for DEK

## Key Hierarchy

```
Agent Identity (X25519 keypair)
└── Record 1: DEK₁ → Encrypted content
└── Record 2: DEK₂ → Encrypted content
└── Record 3: DEK₃ → Encrypted content
    └── Shared with Bob: DEK₃ encrypted for Bob's public key
```

## Agent Identity

```typescript
interface AgentIdentity {
  did: string                      // did:cf:<durable-object-id>
  signingKey: CryptoKeyPair        // Ed25519 for signatures
  encryptionKey: X25519KeyPair     // X25519 for encryption
  createdAt: number
  rotatedAt?: number
}

async function createIdentity(doId: string): Promise<AgentIdentity> {
  // Generate X25519 keypair for encryption
  const encryptionKey = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  )
  
  // Generate Ed25519 keypair for signing
  const signingKey = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  )
  
  return {
    did: `did:cf:${doId}`,
    signingKey,
    encryptionKey,
    createdAt: Date.now()
  }
}
```

## Encrypted Record Schema

```typescript
interface EncryptedRecord {
  id: string                  // Record ID (TID)
  collection: string          // Lexicon type
  ciphertext: Uint8Array      // Encrypted content
  encryptedDek: Uint8Array    // DEK encrypted with agent's public key
  nonce: Uint8Array           // Unique per record (12 bytes)
  public: boolean             // If true, ciphertext is plaintext
  recipients?: string[]       // DIDs who can decrypt (for shared)
  createdAt: string
}
```

## Encrypt on Store

```typescript
async function encryptRecord(
  content: unknown,
  identity: AgentIdentity
): Promise<EncryptedRecord> {
  // 1. Generate random DEK (256-bit)
  const dek = crypto.getRandomValues(new Uint8Array(32))
  
  // 2. Generate nonce (96-bit)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  
  // 3. Encrypt content with DEK using AES-GCM
  const plaintext = new TextEncoder().encode(JSON.stringify(content))
  const key = await crypto.subtle.importKey(
    'raw', dek, 'AES-GCM', false, ['encrypt']
  )
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    plaintext
  )
  
  // 4. Encrypt DEK with agent's public key (X25519 + HKDF + AES-GCM)
  const encryptedDek = await encryptForPublicKey(dek, identity.encryptionKey.publicKey)
  
  return {
    id: generateTid(),
    collection: content.$type,
    ciphertext: new Uint8Array(ciphertext),
    encryptedDek,
    nonce,
    public: false,
    createdAt: new Date().toISOString()
  }
}
```

## Decrypt on Retrieve

```typescript
async function decryptRecord(
  record: EncryptedRecord,
  identity: AgentIdentity
): Promise<unknown> {
  if (record.public) {
    return JSON.parse(new TextDecoder().decode(record.ciphertext))
  }
  
  // 1. Decrypt DEK with agent's private key
  const dek = await decryptWithPrivateKey(
    record.encryptedDek,
    identity.encryptionKey.privateKey
  )
  
  // 2. Decrypt content with DEK
  const key = await crypto.subtle.importKey(
    'raw', dek, 'AES-GCM', false, ['decrypt']
  )
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.nonce },
    key,
    record.ciphertext
  )
  
  return JSON.parse(new TextDecoder().decode(plaintext))
}
```

## Share with Another Agent

Re-encrypt the DEK for the recipient's public key:

```typescript
async function shareRecord(
  recordId: string,
  recipientDid: string,
  identity: AgentIdentity,
  db: D1Database
): Promise<void> {
  // 1. Get record
  const record = await db.prepare(
    'SELECT * FROM records WHERE id = ?'
  ).bind(recordId).first()
  
  // 2. Decrypt our DEK
  const dek = await decryptWithPrivateKey(
    record.encrypted_dek,
    identity.encryptionKey.privateKey
  )
  
  // 3. Get recipient's public key
  const recipientKey = await resolvePublicKey(recipientDid)
  
  // 4. Re-encrypt DEK for recipient
  const sharedDek = await encryptForPublicKey(dek, recipientKey)
  
  // 5. Store share record
  await db.prepare(`
    INSERT INTO shared_records (record_id, recipient_did, encrypted_dek)
    VALUES (?, ?, ?)
  `).bind(recordId, recipientDid, sharedDek).run()
}
```

## Make Public

Convert encrypted record to plaintext:

```typescript
async function makePublic(
  recordId: string,
  identity: AgentIdentity,
  db: D1Database
): Promise<void> {
  // 1. Decrypt the record
  const record = await getRecord(recordId, identity, db)
  const content = await decryptRecord(record, identity)
  
  // 2. Store as plaintext
  await db.prepare(`
    UPDATE records 
    SET ciphertext = ?, encrypted_dek = NULL, public = TRUE
    WHERE id = ?
  `).bind(
    new TextEncoder().encode(JSON.stringify(content)),
    recordId
  ).run()
}
```

## Key Rotation

Rotate agent key without re-encrypting all records:

```typescript
async function rotateKey(
  identity: AgentIdentity,
  storage: DurableObjectStorage
): Promise<AgentIdentity> {
  // 1. Generate new keypair
  const newKey = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  )
  
  // 2. Re-encrypt all DEKs with new key
  const records = await storage.list({ prefix: 'record:' })
  for (const [key, record] of records) {
    // Decrypt DEK with old key
    const dek = await decryptWithPrivateKey(
      record.encryptedDek,
      identity.encryptionKey.privateKey
    )
    // Re-encrypt with new key
    record.encryptedDek = await encryptForPublicKey(dek, newKey.publicKey)
    await storage.put(key, record)
  }
  
  // 3. Update identity
  const newIdentity = {
    ...identity,
    encryptionKey: newKey,
    rotatedAt: Date.now()
  }
  await storage.put('identity', newIdentity)
  
  return newIdentity
}
```

## Cloudflare Web Crypto Notes

Cloudflare Workers support Web Crypto API with some specifics:

```typescript
// X25519 is supported
const key = await crypto.subtle.generateKey(
  { name: 'X25519' },
  true,
  ['deriveBits']
)

// Derive shared secret
const sharedSecret = await crypto.subtle.deriveBits(
  { name: 'X25519', public: recipientPublicKey },
  myPrivateKey,
  256
)

// Use HKDF to derive encryption key from shared secret
const encKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', salt, info, hash: 'SHA-256' },
  await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']),
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
)
```

## References

- [Web Crypto API on Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [X25519 Key Agreement](https://www.rfc-editor.org/rfc/rfc7748)
- [AES-GCM Encryption](https://www.rfc-editor.org/rfc/rfc5116)
