CREATE TABLE IF NOT EXISTS sandbox_admin_config (
  id TEXT PRIMARY KEY,
  default_budget_hours REAL,
  agent_budgets_json TEXT,
  updated_at INTEGER NOT NULL
);
