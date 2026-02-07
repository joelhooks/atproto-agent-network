import { describe, expect, it } from 'vitest'

import { createIsoTimestamp } from './test-utils'
import { parseLexiconRecord, validateLexiconRecord } from './validation'

describe('lexicon validation', () => {
  it('accepts valid lexicon records', () => {
    const record = {
      $type: 'agent.memory.note',
      summary: 'Test summary',
      text: 'Test text',
      createdAt: createIsoTimestamp(),
    }

    const result = validateLexiconRecord(record)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.$type).toBe('agent.memory.note')
    expect(result.value.summary).toBe('Test summary')
  })

  it('rejects invalid lexicon records with issues', () => {
    const record = {
      $type: 'agent.memory.note',
      createdAt: createIsoTimestamp(),
    }

    const result = validateLexiconRecord(record)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Invalid record')
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('rejects unknown $type discriminators', () => {
    const record = {
      $type: 'agent.memory.unknown',
      summary: 'Test summary',
      createdAt: createIsoTimestamp(),
    }

    const result = validateLexiconRecord(record)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('parseLexiconRecord throws on invalid input', () => {
    expect(() => parseLexiconRecord({ $type: 'agent.memory.note' })).toThrow()
  })
})

