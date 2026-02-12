-- story-mli4cnxe: rename legacy games table to environments.
-- D1 wraps each migration in an implicit transaction, no explicit BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  type TEXT,
  host_agent TEXT,
  state TEXT,
  phase TEXT,
  players TEXT,
  winner TEXT,
  created_at TEXT,
  updated_at TEXT
);

INSERT OR REPLACE INTO environments (
  id,
  type,
  host_agent,
  state,
  phase,
  players,
  winner,
  created_at,
  updated_at
)
SELECT
  id,
  type,
  host_agent,
  state,
  phase,
  players,
  winner,
  created_at,
  updated_at
FROM games;

DROP TABLE games;
