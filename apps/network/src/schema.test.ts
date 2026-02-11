import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Miniflare } from 'miniflare'

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.sql'
)

function splitSqlStatements(sql: string): string[] {
  // Miniflare's D1 exec parser is strict: strip `--` comments and exec
  // statements one-by-one.
  return sql
    .replace(/^\uFEFF/, '')
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function normalize(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function extractTable(sql: string, table: string): string {
  const pattern = new RegExp(
    `create table\\s+(?:if not exists\\s+)?${table}\\s*\\(([^;]+)\\)`,
    'i'
  )
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

  it('defines an environments table with the expected columns', async () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const normalized = normalize(schema)

    // Ensure the on-disk schema uses IF NOT EXISTS to avoid destructive deploys.
    expect(normalized).toContain('create table if not exists environments')

    const mf = new Miniflare({
      modules: true,
      compatibilityDate: '2024-01-01',
      script: "export default { fetch(){ return new Response('ok') } }",
      d1Databases: { DB: 'DB' },
    })

    try {
      const db = await mf.getD1Database('DB')
      for (const statement of splitSqlStatements(schema)) {
        await db.exec(statement)
      }

      const tableRow = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='environments'")
        .first<{ name: string }>()
      expect(tableRow?.name).toBe('environments')

      const createRow = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='environments'")
        .first<{ sql: string }>()
      expect(createRow?.sql).toBeTruthy()

      const environments = extractTable(normalize(createRow!.sql), 'environments')
      const required = [
        'id text primary key',
        'type text',
        'host_agent text',
        'state text',
        'phase text',
        'players text',
        'winner text',
        'created_at text',
        'updated_at text',
      ]

      for (const snippet of required) {
        expect(environments).toContain(snippet)
      }
    } finally {
      await mf.dispose()
    }
  })

  it('defines a work_items table with the expected columns', async () => {
    const schema = readFileSync(schemaPath, 'utf8')
    const normalized = normalize(schema)

    // Ensure the on-disk schema uses IF NOT EXISTS to avoid destructive deploys.
    expect(normalized).toContain('create table if not exists work_items')

    const mf = new Miniflare({
      modules: true,
      compatibilityDate: '2024-01-01',
      script: "export default { fetch(){ return new Response('ok') } }",
      d1Databases: { DB: 'DB' },
    })

    try {
      const db = await mf.getD1Database('DB')
      for (const statement of splitSqlStatements(schema)) {
        await db.exec(statement)
      }

      const tableRow = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
        .first<{ name: string }>()
      expect(tableRow?.name).toBe('work_items')

      const createRow = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'")
        .first<{ sql: string }>()
      expect(createRow?.sql).toBeTruthy()

      const workItems = extractTable(normalize(createRow!.sql), 'work_items')
      const required = [
        'id text primary key',
        'env_type text not null',
        'env_id text',
        "status text not null default 'open'",
        'priority integer not null default 0',
        'title text not null',
        "payload_json text not null default '{}'",
        'claimed_by_did text',
        'claimed_at text',
        'created_at text not null',
        'updated_at text not null',
      ]

      for (const snippet of required) {
        expect(workItems).toContain(snippet)
      }
    } finally {
      await mf.dispose()
    }
  })
})
