const BASIC_INSTANCE_MEMORY_GIB = 1
const BASIC_INSTANCE_VCPU = 0.25
const MEMORY_RATE_PER_GIB_HOUR = 0.009
const CPU_RATE_PER_VCPU_MIN = 0.0012
const COST_PER_ACTIVE_HOUR =
  BASIC_INSTANCE_MEMORY_GIB * MEMORY_RATE_PER_GIB_HOUR +
  BASIC_INSTANCE_VCPU * 60 * CPU_RATE_PER_VCPU_MIN

type LeaseStatus = 'active' | 'expired' | 'destroyed'

type LeaseUsageRow = {
  agent_name: string
  leased_at: number
  last_activity_at: number
  status: string
}

type LeaseAuditRow = {
  id: string
  agent_name: string
  environment_id: string
  sandbox_id: string
  status: string
  leased_at: number
  expires_at: number
  last_activity_at: number
  expiry_conditions: string | null
}

type SandboxConfigRow = {
  default_budget_hours: number | null
  agent_budgets_json: string | null
}

export type SandboxBudgetConfig = {
  defaultMonthlyHours: number | null
  agentBudgets: Record<string, number>
}

export type SandboxLeaseAuditEntry = {
  id: string
  agentName: string
  environmentId: string
  sandboxId: string
  status: LeaseStatus | string
  leasedAt: number
  expiresAt: number
  lastActivityAt: number
  uptimeMs: number
  expiryConditions: string[]
}

export type SandboxCostsByAgent = {
  name: string
  activeHours: number
  estimatedCost: number
}

export type SandboxCostBreakdown = {
  agents: SandboxCostsByAgent[]
  total: {
    hours: number
    cost: number
  }
}

export class SandboxBudgetExceededError extends Error {
  readonly code = 'SANDBOX_BUDGET_EXCEEDED'
  readonly agentName: string
  readonly budgetHours: number
  readonly activeHours: number

  constructor(input: { agentName: string; budgetHours: number; activeHours: number }) {
    super(
      `Sandbox budget exceeded for ${input.agentName}: active ${input.activeHours.toFixed(3)}h >= budget ${input.budgetHours.toFixed(3)}h`
    )
    this.name = 'SandboxBudgetExceededError'
    this.agentName = input.agentName
    this.budgetHours = input.budgetHours
    this.activeHours = input.activeHours
  }
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function round(value: number, decimals: number = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function currentMonthStartUtc(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function parseAgentBudgetsJson(raw: string | null): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const numeric = toFiniteNumber(value, NaN)
      if (Number.isFinite(numeric) && numeric > 0) out[key] = numeric
    }
    return out
  } catch {
    return {}
  }
}

function computeLeaseDurationMs(input: {
  leasedAt: number
  lastActivityAt: number
  status: string
  monthStart: number
  now: number
}): number {
  const clampedStart = Math.max(input.leasedAt, input.monthStart)
  const endBase = input.status === 'active' ? input.now : input.lastActivityAt
  const clampedEnd = Math.min(Math.max(endBase, input.leasedAt), input.now)
  return Math.max(0, clampedEnd - clampedStart)
}

export class LeaseManager {
  constructor(private db: D1Database) {}

  async acquire(
    agentName: string,
    envId: string,
    sandboxId: string,
    ttlMs: number,
    expiryConditions: string[] = []
  ): Promise<void> {
    const now = Date.now()
    await this.assertWithinMonthlyBudget(agentName, now)

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO sandbox_leases (id, agent_name, environment_id, sandbox_id, status, leased_at, expires_at, last_activity_at, expiry_conditions)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .bind(
        `${agentName}:${envId}`,
        agentName,
        envId,
        sandboxId,
        now,
        now + ttlMs,
        now,
        JSON.stringify(expiryConditions)
      )
      .run()
  }

  async renew(agentName: string, envId: string, ttlMs: number = 14400000): Promise<void> {
    const now = Date.now()
    await this.db
      .prepare(`UPDATE sandbox_leases SET last_activity_at = ?, expires_at = ? WHERE id = ? AND status = 'active'`)
      .bind(now, now + ttlMs, `${agentName}:${envId}`)
      .run()
  }

  async release(agentName: string, envId: string): Promise<void> {
    await this.db.prepare(`UPDATE sandbox_leases SET status = 'destroyed' WHERE id = ?`).bind(`${agentName}:${envId}`).run()
  }

  async getExpiredLeases(): Promise<Array<{ agent_name: string; environment_id: string; sandbox_id: string }>> {
    const result = await this.db
      .prepare(`SELECT agent_name, environment_id, sandbox_id FROM sandbox_leases WHERE status = 'active' AND expires_at < ?`)
      .bind(Date.now())
      .all()
    return result.results as Array<{ agent_name: string; environment_id: string; sandbox_id: string }>
  }

  async getAgentLease(agentName: string, envId: string) {
    return this.db.prepare(`SELECT * FROM sandbox_leases WHERE id = ?`).bind(`${agentName}:${envId}`).first()
  }

  async getSandboxConfig(): Promise<SandboxBudgetConfig> {
    const row = await this.db
      .prepare(`SELECT default_budget_hours, agent_budgets_json FROM sandbox_admin_config WHERE id = ?`)
      .bind('global')
      .first<SandboxConfigRow>()

    if (!row) {
      return { defaultMonthlyHours: null, agentBudgets: {} }
    }

    const defaultBudget = toFiniteNumber(row.default_budget_hours, NaN)
    return {
      defaultMonthlyHours: Number.isFinite(defaultBudget) && defaultBudget > 0 ? defaultBudget : null,
      agentBudgets: parseAgentBudgetsJson(row.agent_budgets_json),
    }
  }

  async setSandboxConfig(input: Partial<SandboxBudgetConfig>): Promise<SandboxBudgetConfig> {
    const existing = await this.getSandboxConfig()
    const merged: SandboxBudgetConfig = {
      defaultMonthlyHours:
        typeof input.defaultMonthlyHours === 'undefined'
          ? existing.defaultMonthlyHours
          : input.defaultMonthlyHours,
      agentBudgets: input.agentBudgets ?? existing.agentBudgets,
    }

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO sandbox_admin_config (id, default_budget_hours, agent_budgets_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(
        'global',
        merged.defaultMonthlyHours,
        JSON.stringify(merged.agentBudgets),
        Date.now()
      )
      .run()

    return merged
  }

  async listLeases(now: number = Date.now()): Promise<SandboxLeaseAuditEntry[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM sandbox_leases ORDER BY leased_at DESC`
      )
      .all<LeaseAuditRow>()

    return (result.results ?? []).map((row) => {
      const leasedAt = toFiniteNumber(row.leased_at, 0)
      const lastActivityAt = toFiniteNumber(row.last_activity_at, leasedAt)
      const end = row.status === 'active' ? now : Math.max(lastActivityAt, leasedAt)
      const uptimeMs = Math.max(0, end - leasedAt)
      const expiryConditions = (() => {
        if (typeof row.expiry_conditions !== 'string' || row.expiry_conditions.length === 0) return []
        try {
          const parsed = JSON.parse(row.expiry_conditions)
          return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
        } catch {
          return []
        }
      })()

      return {
        id: String(row.id ?? ''),
        agentName: String(row.agent_name ?? ''),
        environmentId: String(row.environment_id ?? ''),
        sandboxId: String(row.sandbox_id ?? ''),
        status: String(row.status ?? ''),
        leasedAt,
        expiresAt: toFiniteNumber(row.expires_at, leasedAt),
        lastActivityAt,
        uptimeMs,
        expiryConditions,
      }
    })
  }

  async getCostBreakdown(now: number = Date.now()): Promise<SandboxCostBreakdown> {
    const monthStart = currentMonthStartUtc(now)
    const rows = await this.getLeaseUsageRows()
    const byAgent = new Map<string, number>()

    for (const row of rows) {
      const leasedAt = toFiniteNumber(row.leased_at, 0)
      const lastActivityAt = toFiniteNumber(row.last_activity_at, leasedAt)
      const durationMs = computeLeaseDurationMs({
        leasedAt,
        lastActivityAt,
        status: String(row.status ?? ''),
        monthStart,
        now,
      })
      byAgent.set(String(row.agent_name ?? ''), (byAgent.get(String(row.agent_name ?? '')) ?? 0) + durationMs)
    }

    const agents = Array.from(byAgent.entries())
      .map(([name, durationMs]) => {
        const activeHours = durationMs / (60 * 60 * 1000)
        const estimatedCost = activeHours * COST_PER_ACTIVE_HOUR
        return {
          name,
          activeHours: round(activeHours, 4),
          estimatedCost: round(estimatedCost, 4),
        }
      })
      .sort((a, b) => b.estimatedCost - a.estimatedCost || a.name.localeCompare(b.name))

    const totals = agents.reduce(
      (acc, item) => {
        acc.hours += item.activeHours
        acc.cost += item.estimatedCost
        return acc
      },
      { hours: 0, cost: 0 }
    )

    return {
      agents,
      total: {
        hours: round(totals.hours, 4),
        cost: round(totals.cost, 4),
      },
    }
  }

  private async assertWithinMonthlyBudget(agentName: string, now: number): Promise<void> {
    const config = await this.getSandboxConfig()
    const configuredBudget = config.agentBudgets[agentName] ?? config.defaultMonthlyHours
    if (typeof configuredBudget !== 'number' || configuredBudget <= 0) return

    const monthStart = currentMonthStartUtc(now)
    const activeHours = await this.getMonthlyActiveHoursForAgent(agentName, monthStart, now)
    if (activeHours >= configuredBudget) {
      throw new SandboxBudgetExceededError({
        agentName,
        budgetHours: configuredBudget,
        activeHours,
      })
    }
  }

  private async getMonthlyActiveHoursForAgent(agentName: string, monthStart: number, now: number): Promise<number> {
    const rows = await this.getLeaseUsageRows(agentName)
    let totalMs = 0

    for (const row of rows) {
      const durationMs = computeLeaseDurationMs({
        leasedAt: toFiniteNumber(row.leased_at, 0),
        lastActivityAt: toFiniteNumber(row.last_activity_at, toFiniteNumber(row.leased_at, 0)),
        status: String(row.status ?? ''),
        monthStart,
        now,
      })
      totalMs += durationMs
    }

    return totalMs / (60 * 60 * 1000)
  }

  private async getLeaseUsageRows(agentName?: string): Promise<LeaseUsageRow[]> {
    if (agentName) {
      const filtered = await this.db
        .prepare(`SELECT agent_name, leased_at, last_activity_at, status FROM sandbox_leases WHERE agent_name = ?`)
        .bind(agentName)
        .all<LeaseUsageRow>()
      return filtered.results ?? []
    }

    const all = await this.db
      .prepare(`SELECT agent_name, leased_at, last_activity_at, status FROM sandbox_leases`)
      .all<LeaseUsageRow>()
    return all.results ?? []
  }
}
