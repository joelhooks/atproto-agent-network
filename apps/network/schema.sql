-- Encrypted records schema (private by default)
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  encrypted_dek BLOB,
  nonce BLOB NOT NULL,
  public INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT,
  UNIQUE(did, collection, rkey)
);

CREATE INDEX idx_records_did ON records(did);
CREATE INDEX idx_records_collection ON records(collection);
CREATE INDEX idx_records_did_collection ON records(did, collection);
CREATE INDEX idx_records_created ON records(created_at);

CREATE TABLE shared_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  recipient_did TEXT NOT NULL,
  encrypted_dek BLOB NOT NULL,
  shared_at TEXT NOT NULL,
  FOREIGN KEY (record_id) REFERENCES records(id),
  UNIQUE(record_id, recipient_did)
);

CREATE INDEX idx_shared_recipient ON shared_records(recipient_did);

-- Agent registry (names -> DIDs)
CREATE TABLE agents (
  name TEXT PRIMARY KEY,
  did TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agents_created_at ON agents(created_at);

CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, type TEXT, host_agent TEXT, state TEXT, phase TEXT, players TEXT, winner TEXT, created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  env_type TEXT NOT NULL,
  env_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  claimed_by_did TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observer_reports (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
