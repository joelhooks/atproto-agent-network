import {
  deriveSharedSecret,
  decryptDekWithPrivateKey,
  encryptDekForPublicKey,
  exportPublicKey,
  generateDek,
  generateEd25519Keypair,
  generateX25519Keypair,
} from './crypto'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_LOOKUP = new Map(BASE58_ALPHABET.split('').map((char, index) => [char, index]))

function decodeBase58btc(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) {
    throw new Error(`Expected base58btc multibase string, received: ${multibase}`)
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

describe('generateX25519Keypair', () => {
  it('returns an extractable X25519 keypair ready for key agreement', async () => {
    const keypair = await generateX25519Keypair()

    expect(keypair.publicKey.algorithm).toMatchObject({ name: 'X25519' })
    expect(keypair.privateKey.algorithm).toMatchObject({ name: 'X25519' })
    expect(keypair.publicKey.type).toBe('public')
    expect(keypair.privateKey.type).toBe('private')
    expect(keypair.publicKey.extractable).toBe(true)
    expect(keypair.privateKey.extractable).toBe(true)
    expect(keypair.privateKey.usages).toContain('deriveBits')
    expect(keypair.publicKey.usages).toHaveLength(0)
  })
})

describe('generateEd25519Keypair', () => {
  it('returns an extractable Ed25519 keypair ready for signatures', async () => {
    const keypair = await generateEd25519Keypair()

    expect(keypair.publicKey.algorithm).toMatchObject({ name: 'Ed25519' })
    expect(keypair.privateKey.algorithm).toMatchObject({ name: 'Ed25519' })
    expect(keypair.publicKey.type).toBe('public')
    expect(keypair.privateKey.type).toBe('private')
    expect(keypair.publicKey.extractable).toBe(true)
    expect(keypair.privateKey.extractable).toBe(true)
    expect(keypair.privateKey.usages).toContain('sign')
    expect(keypair.publicKey.usages).toContain('verify')
  })
})

describe('deriveSharedSecret', () => {
  it('derives the same shared secret for both parties', async () => {
    const alice = await generateX25519Keypair()
    const bob = await generateX25519Keypair()

    const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey)
    const bobSecret = await deriveSharedSecret(bob.privateKey, alice.publicKey)

    expect(aliceSecret).toEqual(bobSecret)
    expect(aliceSecret).toHaveLength(32)
  })
})

describe('exportPublicKey', () => {
  it('exports Ed25519 public keys with multibase + multicodec prefix', async () => {
    const { publicKey } = await generateEd25519Keypair()
    const multibase = await exportPublicKey(publicKey)

    expect(multibase.startsWith('z')).toBe(true)

    const decoded = decodeBase58btc(multibase)
    expect(decoded.slice(0, 2)).toEqual(new Uint8Array([0xed, 0x01]))

    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
    expect(decoded.slice(2)).toEqual(raw)
  })

  it('exports X25519 public keys with multibase + multicodec prefix', async () => {
    const { publicKey } = await generateX25519Keypair()
    const multibase = await exportPublicKey(publicKey)

    expect(multibase.startsWith('z')).toBe(true)

    const decoded = decodeBase58btc(multibase)
    expect(decoded.slice(0, 2)).toEqual(new Uint8Array([0xec, 0x01]))

    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
    expect(decoded.slice(2)).toEqual(raw)
  })
})

describe('envelope encryption', () => {
  it('round-trips a DEK using an X25519 recipient keypair', async () => {
    const { publicKey, privateKey } = await generateX25519Keypair()
    const dek = await generateDek()

    const encryptedDek = await encryptDekForPublicKey(dek, publicKey)
    const decryptedDek = await decryptDekWithPrivateKey(encryptedDek, privateKey)

    expect(decryptedDek).toEqual(dek)
  })

  it('produces distinct envelopes for the same DEK', async () => {
    const { publicKey, privateKey } = await generateX25519Keypair()
    const dek = await generateDek()

    const first = await encryptDekForPublicKey(dek, publicKey)
    const second = await encryptDekForPublicKey(dek, publicKey)

    expect(first).not.toEqual(second)
    await expect(decryptDekWithPrivateKey(first, privateKey)).resolves.toEqual(dek)
    await expect(decryptDekWithPrivateKey(second, privateKey)).resolves.toEqual(dek)
  })

  it('fails to decrypt with the wrong private key', async () => {
    const recipient = await generateX25519Keypair()
    const intruder = await generateX25519Keypair()
    const dek = await generateDek()

    const encryptedDek = await encryptDekForPublicKey(dek, recipient.publicKey)

    await expect(
      decryptDekWithPrivateKey(encryptedDek, intruder.privateKey)
    ).rejects.toThrow()
  })
})
