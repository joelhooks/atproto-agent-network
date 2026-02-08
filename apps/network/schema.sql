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
