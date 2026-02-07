import type { ZodIssue } from 'zod'

import { LexiconRecordSchema, type LexiconRecord } from './lexicons'

export type LexiconValidationResult =
  | { ok: true; value: LexiconRecord }
  | { ok: false; error: 'Invalid record'; issues: ZodIssue[] }

export function validateLexiconRecord(input: unknown): LexiconValidationResult {
  const parsed = LexiconRecordSchema.safeParse(input)
  if (parsed.success) {
    return { ok: true, value: parsed.data }
  }

  return {
    ok: false,
    error: 'Invalid record',
    issues: parsed.error.issues,
  }
}

export function parseLexiconRecord(input: unknown): LexiconRecord {
  return LexiconRecordSchema.parse(input)
}

