export interface RecordRow {
  id: string
  did: string
  collection: string
  rkey: string
  ciphertext: Uint8Array
  encrypted_dek: Uint8Array | null
  nonce: Uint8Array
  public: number
  created_at: string
  updated_at?: string | null
  deleted_at?: string | null
}

export interface SharedRecordRow {
  id: number
  record_id: string
  recipient_did: string
  encrypted_dek: Uint8Array
  shared_at: string
}

export interface AgentRow {
  name: string
  did: string
  created_at: string
}

export interface GameRow {
  id: string
  type?: string | null
  host_agent: string
  state: string
  phase: string
  players: string
  winner?: string | null
  created_at: string
  updated_at: string
}

interface Condition {
  column: keyof RecordRow
  value: unknown
}

interface SharedCondition {
  column: keyof SharedRecordRow
  value: unknown
}

interface AgentCondition {
  column: keyof AgentRow
  value: unknown
}

interface GameCondition {
  kind: 'eq' | 'like' | 'in' | 'not_in' | 'json_current_player'
  column?: keyof GameRow
  values?: string[]
  value?: unknown
}

export class D1MockStatement {
  private readonly params: unknown[]
  private readonly sql: string
  private readonly db: D1MockDatabase

  constructor(db: D1MockDatabase, sql: string, params: unknown[] = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }

  bind(...params: unknown[]): D1MockStatement {
    return new D1MockStatement(this.db, this.sql, params)
  }

  async run(): Promise<{ success: true }> {
    await this.db.run(this.sql, this.params)
    return { success: true }
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.params)
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.db.all<T>(this.sql, this.params)
  }
}

export class D1MockDatabase {
  readonly records = new Map<string, RecordRow>()
  readonly sharedRecords = new Map<string, SharedRecordRow>()
  readonly agents = new Map<string, AgentRow>()
  readonly games = new Map<string, GameRow>()
  private sharedAutoIncrement = 0

  prepare(sql: string): D1MockStatement {
    return new D1MockStatement(this, sql)
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = normalizeSql(sql)

    if (normalized.startsWith('insert into agents')) {
      const [name, did, createdAt] = params
      const key = String(name)
      if (this.agents.has(key)) {
        throw new Error(`UNIQUE constraint failed: agents.name (${key})`)
      }
      this.agents.set(key, {
        name: key,
        did: String(did),
        created_at: String(createdAt),
      })
      return
    }

    if (normalized.startsWith('delete from agents')) {
      const whereClause = extractWhereClause(normalized)
      if (!whereClause) {
        this.agents.clear()
        return
      }
      const conditions = parseAgentConditions(whereClause, params)
      for (const row of Array.from(this.agents.values())) {
        if (conditions.every((condition) => matchAgentCondition(row, condition))) {
          this.agents.delete(row.name)
        }
      }
      return
    }

    if (normalized.startsWith('insert into games')) {
      const now = new Date().toISOString()

      // Supports both:
      // - INSERT INTO games (id, host_agent, state, phase, players, ...) VALUES (?, ?, ?, ?, ?, ...)
      // - INSERT INTO games (id, type, host_agent, state, phase, players, ...) VALUES (?, ?, ?, ?, ?, ?, ...)
      let id: unknown
      let type: unknown = null
      let hostAgent: unknown
      let state: unknown
      let phase: unknown
      let players: unknown

      if (params.length >= 6) {
        ;[id, type, hostAgent, state, phase, players] = params
      } else {
        ;[id, hostAgent, state, phase, players] = params
      }
      const key = String(id)

      this.games.set(key, {
        id: key,
        type: type == null ? null : String(type),
        host_agent: String(hostAgent ?? ''),
        state: String(state ?? ''),
        phase: String(phase ?? ''),
        players: String(players ?? '[]'),
        winner: null,
        created_at: now,
        updated_at: now,
      })
      return
    }

    if (normalized.startsWith('update games set')) {
      const whereClause = extractWhereClause(normalized)
      if (!whereClause) {
        throw new Error(`Unsupported update statement (missing where): ${normalized}`)
      }

      // Only support updates scoped to a single game id.
      const idParamIndex = params.length - 1
      const id = String(params[idParamIndex])
      const existing = this.games.get(id)
      if (!existing) return

      const now = new Date().toISOString()

      // UPDATE games SET state = ?, phase = ?, winner = ?, updated_at = datetime('now') WHERE id = ?
      if (
        normalized.includes('state = ?') &&
        normalized.includes('phase = ?') &&
        normalized.includes('winner = ?') &&
        normalized.includes('players = ?')
      ) {
        const [state, phase, winner, players] = params
        existing.state = String(state ?? '')
        existing.phase = String(phase ?? '')
        existing.winner = winner == null ? null : String(winner)
        existing.players = String(players ?? '[]')
        existing.updated_at = now
        this.games.set(id, existing)
        return
      }

      if (normalized.includes('state = ?') && normalized.includes('phase = ?') && normalized.includes('winner = ?')) {
        const [state, phase, winner] = params
        existing.state = String(state ?? '')
        existing.phase = String(phase ?? '')
        existing.winner = winner == null ? null : String(winner)
        existing.updated_at = now
        this.games.set(id, existing)
        return
      }

      // UPDATE games SET phase = 'finished', winner = 'cancelled' WHERE id = ?
      if (normalized.includes("phase = 'finished'") && normalized.includes("winner = 'cancelled'")) {
        existing.phase = 'finished'
        existing.winner = 'cancelled'
        existing.updated_at = now
        this.games.set(id, existing)
        return
      }

      throw new Error(`Unsupported SQL in D1MockDatabase.run: ${normalized}`)
    }

    if (normalized.startsWith('insert into records')) {
      const [
        id,
        did,
        collection,
        rkey,
        ciphertext,
        encryptedDek,
        nonce,
        isPublic,
        createdAt,
      ] = params

      this.records.set(id as string, {
        id: id as string,
        did: did as string,
        collection: collection as string,
        rkey: rkey as string,
        ciphertext: asBytes(ciphertext, 'ciphertext'),
        encrypted_dek: encryptedDek ? asBytes(encryptedDek, 'encrypted_dek') : null,
        nonce: asBytes(nonce, 'nonce'),
        public: Number(isPublic),
        created_at: createdAt as string,
        updated_at: null,
        deleted_at: null,
      })
      return
    }

    if (normalized.includes('into shared_records')) {
      const [recordId, recipientDid, encryptedDek, sharedAt] = params
      const key = `${recordId as string}::${recipientDid as string}`
      const existing = this.sharedRecords.get(key)
      const id = existing?.id ?? (this.sharedAutoIncrement += 1)

      this.sharedRecords.set(key, {
        id,
        record_id: recordId as string,
        recipient_did: recipientDid as string,
        encrypted_dek: asBytes(encryptedDek, 'encrypted_dek'),
        shared_at: sharedAt as string,
      })
      return
    }

    if (normalized.startsWith('update records set')) {
      this.applyUpdate(normalized, params)
      return
    }

    throw new Error(`Unsupported SQL in D1MockDatabase.run: ${normalized}`)
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const result = await this.all<T>(sql, params)
    return result.results[0] ?? null
  }

  async all<T>(sql: string, params: unknown[]): Promise<{ results: T[] }> {
    const normalized = normalizeSql(sql)

    if (normalized.startsWith('select') && normalized.includes('from agents')) {
      const rows = this.filterAgents(normalized, params)
      return { results: rows as T[] }
    }

    if (normalized.startsWith('select') && normalized.includes('from games')) {
      const rows = this.filterGames(normalized, params)
      return { results: rows as T[] }
    }

    if (normalized.startsWith('select') && normalized.includes('from records')) {
      const rows = this.filterRecords(normalized, params)
      return { results: rows as T[] }
    }

    if (normalized.startsWith('select') && normalized.includes('from shared_records')) {
      const rows = this.filterSharedRecords(normalized, params)
      return { results: rows as T[] }
    }

    throw new Error(`Unsupported SQL in D1MockDatabase.all: ${normalized}`)
  }

  private filterRecords(normalized: string, params: unknown[]): RecordRow[] {
    const whereClause = extractWhereClause(normalized)
    if (!whereClause) {
      return Array.from(this.records.values())
    }

    const conditions = parseConditions(whereClause, params)
    return Array.from(this.records.values()).filter((row) =>
      conditions.every((condition) => matchCondition(row, condition))
    )
  }

  private filterSharedRecords(normalized: string, params: unknown[]): SharedRecordRow[] {
    const whereClause = extractWhereClause(normalized)
    if (!whereClause) {
      return Array.from(this.sharedRecords.values())
    }

    const conditions = parseSharedConditions(whereClause, params)
    return Array.from(this.sharedRecords.values()).filter((row) =>
      conditions.every((condition) => matchSharedCondition(row, condition))
    )
  }

  private filterAgents(normalized: string, params: unknown[]): AgentRow[] {
    const whereClause = extractWhereClause(normalized)
    if (!whereClause) {
      return Array.from(this.agents.values())
    }

    const conditions = parseAgentConditions(whereClause, params)
    return Array.from(this.agents.values()).filter((row) =>
      conditions.every((condition) => matchAgentCondition(row, condition))
    )
  }

  private filterGames(normalized: string, params: unknown[]): any[] {
    const whereClause = extractWhereClause(normalized)
    const { conditions, usedParams } = parseGameConditions(whereClause ?? '', params)

    let rows = Array.from(this.games.values()).filter((row) =>
      conditions.every((condition) => matchGameCondition(row, condition))
    )

    if (normalized.includes('order by updated_at desc')) {
      rows = rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    }

    const limitMatch = normalized.match(/\s+limit\s+(\d+)\s*$/)
    if (limitMatch) {
      const limit = Number(limitMatch[1])
      if (Number.isFinite(limit) && limit >= 0) rows = rows.slice(0, limit)
    }

    // Projection based on SELECT list, so callers see the expected columns.
    const projection = extractSelectColumns(normalized, 'games')
    if (projection === '*') return rows as unknown as any[]

    const projected = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const col of projection) {
        out[col] = (row as any)[col]
      }
      return out
    })

    // If a query uses more params than we consumed, it's likely a SQL shape we don't support.
    if (usedParams !== params.length && whereClause) {
      // best-effort: allow extra params for unsupported clauses rather than silently misbehaving
      // (tests should pin the supported shapes).
    }

    return projected
  }

  private applyUpdate(normalized: string, params: unknown[]): void {
    const setIndex = normalized.indexOf(' set ')
    const whereIndex = normalized.indexOf(' where ')
    if (setIndex === -1 || whereIndex === -1) {
      throw new Error(`Unsupported update statement: ${normalized}`)
    }

    const setClause = normalized.slice(setIndex + 5, whereIndex).trim()
    const assignments = setClause
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)

    const sets: Array<{ column: keyof RecordRow; value: unknown }> = []
    let paramIndex = 0
    for (const assignment of assignments) {
      const match = assignment.match(/^(\w+)\s*=\s*\?$/)
      if (!match) {
        throw new Error(`Unsupported set clause: ${assignment}`)
      }
      const column = match[1] as keyof RecordRow
      sets.push({ column, value: params[paramIndex] })
      paramIndex += 1
    }

    const whereClause = extractWhereClause(normalized)
    if (!whereClause) {
      throw new Error(`Unsupported update statement (missing where): ${normalized}`)
    }

    const conditions = parseConditions(whereClause, params.slice(paramIndex))
    const targets = Array.from(this.records.values()).filter((row) =>
      conditions.every((condition) => matchCondition(row, condition))
    )

    for (const row of targets) {
      for (const set of sets) {
        const { column, value } = set
        if (column === 'ciphertext' || column === 'nonce') {
          ;(row as RecordRow & Record<string, unknown>)[column] = asBytes(value, String(column))
          continue
        }
        if (column === 'encrypted_dek') {
          row.encrypted_dek = value ? asBytes(value, 'encrypted_dek') : null
          continue
        }
        if (column === 'public') {
          row.public = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
          continue
        }

        ;(row as RecordRow & Record<string, unknown>)[column] = value as never
      }

      this.records.set(row.id, row)
    }
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

function extractWhereClause(normalized: string): string | null {
  const whereIndex = normalized.indexOf(' where ')
  if (whereIndex === -1) return null

  let clause = normalized.slice(whereIndex + 7)
  const orderIndex = clause.indexOf(' order by ')
  if (orderIndex !== -1) {
    clause = clause.slice(0, orderIndex)
  }
  const limitIndex = clause.indexOf(' limit ')
  if (limitIndex !== -1) {
    clause = clause.slice(0, limitIndex)
  }

  return clause.trim()
}

function parseConditions(clause: string, params: unknown[]): Condition[] {
  const parts = clause.split(' and ').map((part) => part.trim())
  const conditions: Condition[] = []
  let index = 0

  for (const part of parts) {
    if (!part) continue
    const match = part.match(/^(\w+)\s*=\s*\?$/)
    if (!match) {
      throw new Error(`Unsupported where clause: ${part}`)
    }
    const column = match[1] as keyof RecordRow
    const value = params[index]
    conditions.push({ column, value })
    index += 1
  }

  return conditions
}

function matchCondition(row: RecordRow, condition: Condition): boolean {
  const { column, value } = condition
  if (column === 'public') {
    const expected = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
    return row.public === expected
  }
  return row[column] === value
}

function parseSharedConditions(clause: string, params: unknown[]): SharedCondition[] {
  const parts = clause.split(' and ').map((part) => part.trim())
  const conditions: SharedCondition[] = []
  let index = 0

  for (const part of parts) {
    if (!part) continue
    const match = part.match(/^(\w+)\s*=\s*\?$/)
    if (!match) {
      throw new Error(`Unsupported where clause: ${part}`)
    }
    const column = match[1] as keyof SharedRecordRow
    const value = params[index]
    conditions.push({ column, value })
    index += 1
  }

  return conditions
}

function matchSharedCondition(row: SharedRecordRow, condition: SharedCondition): boolean {
  const { column, value } = condition
  return row[column] === value
}

function parseAgentConditions(clause: string, params: unknown[]): AgentCondition[] {
  const parts = clause.split(' and ').map((part) => part.trim())
  const conditions: AgentCondition[] = []
  let index = 0

  for (const part of parts) {
    if (!part) continue
    const match = part.match(/^(\w+)\s*=\s*\?$/)
    if (!match) {
      throw new Error(`Unsupported where clause: ${part}`)
    }
    const column = match[1] as keyof AgentRow
    const value = params[index]
    conditions.push({ column, value })
    index += 1
  }

  return conditions
}

function matchAgentCondition(row: AgentRow, condition: AgentCondition): boolean {
  const { column, value } = condition
  return row[column] === value
}

function parseGameConditions(clause: string, params: unknown[]): { conditions: GameCondition[]; usedParams: number } {
  const trimmed = clause.trim()
  if (!trimmed) return { conditions: [], usedParams: 0 }

  const parts = trimmed.split(' and ').map((part) => part.trim())
  const conditions: GameCondition[] = []
  let index = 0

  for (const part of parts) {
    if (!part || part === '1=1') continue

    // phase not in ('finished', 'abandoned', 'setup')
    const notInMatch = part.match(/^(\w+)\s+not\s+in\s+\(([^)]+)\)$/)
    if (notInMatch) {
      const column = notInMatch[1] as keyof GameRow
      const values = notInMatch[2]
        .split(',')
        .map((v) => v.trim().replace(/^'(.*)'$/, '$1'))
        .filter(Boolean)
      conditions.push({ kind: 'not_in', column, values })
      continue
    }

    // phase in ('playing', 'setup')
    const inMatch = part.match(/^(\w+)\s+in\s+\(([^)]+)\)$/)
    if (inMatch) {
      const column = inMatch[1] as keyof GameRow
      const values = inMatch[2]
        .split(',')
        .map((v) => v.trim().replace(/^'(.*)'$/, '$1'))
        .filter(Boolean)
      conditions.push({ kind: 'in', column, values })
      continue
    }

    // json_extract(state, '$.currentPlayer') = ?
    if (part.startsWith("json_extract(state, '$.currentplayer') = ?")) {
      const value = params[index]
      index += 1
      conditions.push({ kind: 'json_current_player', value })
      continue
    }

    // players like ?
    const likeMatch = part.match(/^(\w+)\s+like\s+\?$/)
    if (likeMatch) {
      const column = likeMatch[1] as keyof GameRow
      const value = params[index]
      index += 1
      conditions.push({ kind: 'like', column, value })
      continue
    }

    // phase = 'playing'
    const eqLiteralMatch = part.match(/^(\w+)\s*=\s*'(.*)'$/)
    if (eqLiteralMatch) {
      const column = eqLiteralMatch[1] as keyof GameRow
      const value = eqLiteralMatch[2]
      conditions.push({ kind: 'eq', column, value })
      continue
    }

    // column = ?
    const eqMatch = part.match(/^(\w+)\s*=\s*\?$/)
    if (eqMatch) {
      const column = eqMatch[1] as keyof GameRow
      const value = params[index]
      index += 1
      conditions.push({ kind: 'eq', column, value })
      continue
    }

    throw new Error(`Unsupported where clause: ${part}`)
  }

  return { conditions, usedParams: index }
}

function sqlLike(haystack: string, pattern: string): boolean {
  // Minimal LIKE support for %wildcards used in this repo.
  if (pattern === '%') return true
  const startsWithWildcard = pattern.startsWith('%')
  const endsWithWildcard = pattern.endsWith('%')
  const needle = pattern.replace(/%/g, '')

  if (!startsWithWildcard && !endsWithWildcard) return haystack === pattern
  if (startsWithWildcard && endsWithWildcard) return haystack.includes(needle)
  if (startsWithWildcard) return haystack.endsWith(needle)
  return haystack.startsWith(needle)
}

function matchGameCondition(row: GameRow, condition: GameCondition): boolean {
  if (condition.kind === 'json_current_player') {
    try {
      const parsed = JSON.parse(row.state) as any
      return String(parsed?.currentPlayer ?? '') === String(condition.value ?? '')
    } catch {
      return false
    }
  }

  const column = condition.column
  if (!column) return true

  const value = (row as any)[column]

  if (condition.kind === 'eq') {
    return value === condition.value
  }

  if (condition.kind === 'like') {
    return sqlLike(String(value ?? ''), String(condition.value ?? ''))
  }

  if (condition.kind === 'in') {
    return condition.values?.includes(String(value ?? '')) ?? false
  }

  if (condition.kind === 'not_in') {
    return !(condition.values?.includes(String(value ?? '')) ?? false)
  }

  return true
}

function extractSelectColumns(normalized: string, table: string): '*' | string[] {
  const match = normalized.match(new RegExp(`^select\\s+(.+?)\\s+from\\s+${table}\\b`))
  if (!match) return '*'
  const list = match[1].trim()
  if (list === '*') return '*'
  return list
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`${label} must be bytes`)
}
