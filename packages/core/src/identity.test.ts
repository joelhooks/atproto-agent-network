import { createDid, generateTid, isFederatedDid, isLocalDid, parseDid, parseFederatedDid } from './identity'

describe('identity utilities', () => {
  it('creates and parses local DIDs', () => {
    const did = createDid('abc123')

    expect(did).toBe('did:cf:abc123')
    expect(parseDid(did)).toEqual({ method: 'cf', id: 'abc123' })
    expect(isLocalDid(did)).toBe(true)
    expect(isFederatedDid(did)).toBe(false)
  })

  it('parses federated DIDs', () => {
    const federated = 'did:cf:alice@network.example'

    expect(isFederatedDid(federated)).toBe(true)
    expect(parseFederatedDid(federated)).toEqual({
      did: 'did:cf:alice',
      network: 'network.example',
    })
  })

  it('returns null for invalid DIDs', () => {
    expect(parseDid('not-a-did')).toBeNull()
    expect(parseFederatedDid('did:cf:missing-at')).toBeNull()
  })
})

describe('generateTid', () => {
  it('returns a timestamp-based base36 prefix with a random suffix', () => {
    const before = Date.now()
    const tid = generateTid()
    const after = Date.now()

    expect(tid).toHaveLength(14)
    expect(tid).toMatch(/^[0-9a-z]{14}$/)

    const prefix = parseInt(tid.slice(0, 10), 36)
    expect(prefix).toBeGreaterThanOrEqual(before)
    expect(prefix).toBeLessThanOrEqual(after)
  })
})
