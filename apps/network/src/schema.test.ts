import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.sql'
)

function normalize(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function extractTable(sql: string, table: string): string {
  const pattern = new RegExp(`create table\\s+${table}\\s*\\(([^;]+)\\)`, 'i')
  const match = sql.match(pattern)
  if (!match) {
    throw new Error(`Missing ${table} table definition`)
  }
  return match[1]
}

describe('schema.sql', () => {
  it('defines an encrypted records table', () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const normalized = normalize(schema)
    const records = extractTable(normalized, 'records')

    const required = [
      'id text primary key',
      'did text not null',
      'collection text not null',
      'rkey text not null',
      'ciphertext blob not null',
      'encrypted_dek blob',
      'nonce blob not null',
      'public integer default 0',
      'created_at text not null',
      'updated_at text',
      'deleted_at text',
      'unique(did, collection, rkey)'
    ]

    for (const snippet of required) {
      expect(records).toContain(snippet)
    }
  })

  it('defines shared records for key sharing', () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const normalized = normalize(schema)
    const shared = extractTable(normalized, 'shared_records')

    const required = [
      'id integer primary key autoincrement',
      'record_id text not null',
      'recipient_did text not null',
      'encrypted_dek blob not null',
      'shared_at text not null',
      'foreign key (record_id) references records(id)',
      'unique(record_id, recipient_did)'
    ]

    for (const snippet of required) {
      expect(shared).toContain(snippet)
    }
  })

  it('indexes record and share lookups', () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const normalized = normalize(schema)

    const indexSnippets = [
      'create index idx_records_did on records(did)',
      'create index idx_records_collection on records(collection)',
      'create index idx_records_did_collection on records(did, collection)',
      'create index idx_records_created on records(created_at)',
      'create index idx_shared_recipient on shared_records(recipient_did)'
    ]

    for (const snippet of indexSnippets) {
      expect(normalized).toContain(snippet)
    }
  })

  it('defines an agents registry table', () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const normalized = normalize(schema)
    const agents = extractTable(normalized, 'agents')

    const required = [
      'name text primary key',
      'did text not null',
      'created_at text not null',
    ]

    for (const snippet of required) {
      expect(agents).toContain(snippet)
    }
  })
})
