export class LeaseManager {
  constructor(private db: D1Database) {}

  async acquire(agentName: string, envId: string, sandboxId: string, ttlMs: number): Promise<void> {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO sandbox_leases (id, agent_name, environment_id, sandbox_id, status, leased_at, expires_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .bind(`${agentName}:${envId}`, agentName, envId, sandboxId, now, now + ttlMs, now)
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
}
