import { generateEd25519Keypair, generateX25519Keypair } from './crypto'

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
