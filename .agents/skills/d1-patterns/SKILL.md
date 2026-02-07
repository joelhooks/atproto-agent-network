---
name: d1-patterns
description: D1 database patterns for encrypted agent records. Use when implementing schema, storing/querying encrypted records, migrations, or working with the records table. Triggers on D1, database, schema, records table, SQL, encrypted storage.
---

# D1 Patterns

D1 stores encrypted records. Content is ciphertext; indexes work on unencrypted metadata.

## Schema

```sql
-- Core records table (encrypted content)
CREATE TABLE records (
  id TEXT PRIMARY KEY,              -- TID (timestamp-based ID)
  did TEXT NOT NULL,                -- Agent DID
  collection TEXT NOT NULL,         -- Lexicon type (agent.memory.note)
  rkey TEXT NOT NULL,               -- Record key within collection
  ciphertext BLOB NOT NULL,         -- Encrypted content
  encrypted_dek BLOB,               -- DEK encrypted for agent (NULL if public)
  nonce BLOB NOT NULL,              -- AES-GCM nonce
  public INTEGER DEFAULT 0,         -- 1 if plaintext
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(did, collection, rkey)
);

CREATE INDEX idx_records_did ON records(did);
CREATE INDEX idx_records_collection ON records(collection);
CREATE INDEX idx_records_did_collection ON records(did, collection);
CREATE INDEX idx_records_created ON records(created_at);

-- Shared records (re-encrypted DEKs for recipients)
CREATE TABLE shared_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  recipient_did TEXT NOT NULL,
  encrypted_dek BLOB NOT NULL,      -- DEK encrypted for recipient
  shared_at TEXT NOT NULL,
  FOREIGN KEY (record_id) REFERENCES records(id),
  UNIQUE(record_id, recipient_did)
);

CREATE INDEX idx_shared_recipient ON shared_records(recipient_did);

-- Agent registry (for multi-agent coordination)
CREATE TABLE agents (
  did TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,         -- X25519 public key
  signing_key BLOB NOT NULL,        -- Ed25519 public key
  metadata TEXT,                    -- JSON metadata
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Observability events
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- ULID
  agent_did TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  session_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  context TEXT,                     -- JSON
  reasoning TEXT,                   -- JSON (decision traces)
  error TEXT,                       -- JSON (error context)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_did) REFERENCES agents(did)
);

CREATE INDEX idx_events_agent ON events(agent_did);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_session ON events(session_id);
```

## TID Generation

Timestamp-based IDs (compatible with AT Protocol):

```typescript
function generateTid(): string {
  const now = Date.now()
  const timestamp = now.toString(36).padStart(10, '0')
  const random = crypto.getRandomValues(new Uint8Array(4))
  const suffix = Array.from(random).map(b => b.toString(36)).join('').slice(0, 4)
  return `${timestamp}${suffix}`
}
```

## CRUD Operations

### Create Record

```typescript
async function createRecord(
  db: D1Database,
  did: string,
  collection: string,
  encrypted: EncryptedRecord
): Promise<string> {
  const rkey = generateTid()
  const id = `${did}/${collection}/${rkey}`
  
  await db.prepare(`
    INSERT INTO records (id, did, collection, rkey, ciphertext, encrypted_dek, nonce, public, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    did,
    collection,
    rkey,
    encrypted.ciphertext,
    encrypted.encryptedDek,
    encrypted.nonce,
    encrypted.public ? 1 : 0,
    new Date().toISOString()
  ).run()
  
  return id
}
```

### Get Record

```typescript
async function getRecord(
  db: D1Database,
  id: string
): Promise<EncryptedRecord | null> {
  const row = await db.prepare(
    'SELECT * FROM records WHERE id = ?'
  ).bind(id).first()
  
  if (!row) return null
  
  return {
    id: row.id as string,
    collection: row.collection as string,
    ciphertext: row.ciphertext as Uint8Array,
    encryptedDek: row.encrypted_dek as Uint8Array,
    nonce: row.nonce as Uint8Array,
    public: row.public === 1,
    createdAt: row.created_at as string
  }
}
```

### List Records

```typescript
async function listRecords(
  db: D1Database,
  did: string,
  collection?: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ records: EncryptedRecord[]; cursor?: string }> {
  const limit = options.limit || 50
  
  let query = 'SELECT * FROM records WHERE did = ?'
  const params: unknown[] = [did]
  
  if (collection) {
    query += ' AND collection = ?'
    params.push(collection)
  }
  
  if (options.cursor) {
    query += ' AND id > ?'
    params.push(options.cursor)
  }
  
  query += ' ORDER BY id LIMIT ?'
  params.push(limit + 1)
  
  const rows = await db.prepare(query).bind(...params).all()
  
  const hasMore = rows.results.length > limit
  const records = rows.results.slice(0, limit).map(rowToRecord)
  
  return {
    records,
    cursor: hasMore ? records[records.length - 1].id : undefined
  }
}
```

### Update Record

```typescript
async function updateRecord(
  db: D1Database,
  id: string,
  encrypted: Partial<EncryptedRecord>
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  
  if (encrypted.ciphertext) {
    sets.push('ciphertext = ?')
    params.push(encrypted.ciphertext)
  }
  if (encrypted.encryptedDek) {
    sets.push('encrypted_dek = ?')
    params.push(encrypted.encryptedDek)
  }
  if (encrypted.nonce) {
    sets.push('nonce = ?')
    params.push(encrypted.nonce)
  }
  if (encrypted.public !== undefined) {
    sets.push('public = ?')
    params.push(encrypted.public ? 1 : 0)
  }
  
  sets.push('updated_at = ?')
  params.push(new Date().toISOString())
  params.push(id)
  
  await db.prepare(
    `UPDATE records SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...params).run()
}
```

### Delete Record

```typescript
async function deleteRecord(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM shared_records WHERE record_id = ?').bind(id),
    db.prepare('DELETE FROM records WHERE id = ?').bind(id)
  ])
}
```

## Batch Operations

D1 supports batching for efficiency:

```typescript
async function batchInsert(
  db: D1Database,
  records: Array<{ did: string; collection: string; encrypted: EncryptedRecord }>
): Promise<string[]> {
  const statements = records.map(r => {
    const rkey = generateTid()
    const id = `${r.did}/${r.collection}/${rkey}`
    return {
      id,
      stmt: db.prepare(`
        INSERT INTO records (id, did, collection, rkey, ciphertext, encrypted_dek, nonce, public, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, r.did, r.collection, rkey,
        r.encrypted.ciphertext, r.encrypted.encryptedDek, r.encrypted.nonce,
        r.encrypted.public ? 1 : 0, new Date().toISOString()
      )
    }
  })
  
  await db.batch(statements.map(s => s.stmt))
  return statements.map(s => s.id)
}
```

## Wrangler Configuration

```toml
[[d1_databases]]
binding = "DB"
database_name = "agent-records"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## Local Development

```bash
# Create local database
wrangler d1 create agent-records --local

# Apply schema
wrangler d1 execute agent-records --local --file=schema.sql

# Query
wrangler d1 execute agent-records --local --command="SELECT COUNT(*) FROM records"
```

## References

- [D1 Documentation](https://developers.cloudflare.com/d1/)
- [D1 Query API](https://developers.cloudflare.com/d1/platform/client-api/)
- [D1 Batch Operations](https://developers.cloudflare.com/d1/platform/client-api/#batch-statements)
