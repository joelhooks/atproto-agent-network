import { generateX25519Keypair } from './crypto'

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
