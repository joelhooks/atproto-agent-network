CREATE TABLE IF NOT EXISTS sandbox_leases (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','destroyed')),
  leased_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expiry_conditions TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_name, environment_id)
);
CREATE INDEX idx_leases_agent ON sandbox_leases(agent_name);
CREATE INDEX idx_leases_env ON sandbox_leases(environment_id);
CREATE INDEX idx_leases_status ON sandbox_leases(status);
