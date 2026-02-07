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

interface Condition {
  column: keyof RecordRow
  value: unknown
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

  prepare(sql: string): D1MockStatement {
    return new D1MockStatement(this, sql)
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    const normalized = normalizeSql(sql)

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

    if (normalized.startsWith('select') && normalized.includes('from records')) {
      const rows = this.filterRecords(normalized, params)
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

function asBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`${label} must be bytes`)
}
