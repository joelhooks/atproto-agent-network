export type JsonLogLevel = 'info' | 'warn' | 'error'

export type JsonLogError = {
  name?: string
  message: string
  stack?: string
  code?: string | number
}

export type JsonLogEvent = {
  timestamp?: string
  ts?: number
  level: JsonLogLevel
  event_type: string
  component?: string
  did?: string
  session_id?: string
  trace_id?: string
  span_id?: string
  context?: Record<string, unknown>
  error?: JsonLogError
  [key: string]: unknown
}

type LoggerBase = Omit<JsonLogEvent, 'level' | 'event_type' | 'timestamp' | 'ts' | 'error'> & {
  component?: string
  did?: string
  session_id?: string
  trace_id?: string
  span_id?: string
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Error) {
      return {
        name: v.name,
        message: v.message,
        stack: v.stack,
      }
    }
    if (v && typeof v === 'object') {
      const obj = v as object
      if (seen.has(obj)) return '[Circular]'
      seen.add(obj)
    }
    return v
  })
}

export function toErrorDetails(error: unknown): JsonLogError {
  if (error instanceof Error) {
    const anyErr = error as Error & { code?: unknown }
    const code = anyErr.code
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    }
  }
  return { message: typeof error === 'string' ? error : String(error) }
}

export function logEvent(event: Omit<JsonLogEvent, 'timestamp' | 'ts'> & { timestamp?: string; ts?: number }): void {
  const ts = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()
  const timestamp = typeof event.timestamp === 'string' ? event.timestamp : new Date(ts).toISOString()
  const payload = { ...event, ts, timestamp } as JsonLogEvent
  // Cloudflare Pipelines (and most log drains) want a single JSON object per line.
  console.log(safeJsonStringify(payload))
}

export function createLogger(base: LoggerBase) {
  return {
    info(event_type: string, fields?: Omit<JsonLogEvent, 'level' | 'event_type'>) {
      logEvent({ ...(base as Record<string, unknown>), ...(fields ?? {}), event_type, level: 'info' })
    },
    warn(event_type: string, fields?: Omit<JsonLogEvent, 'level' | 'event_type'>) {
      logEvent({ ...(base as Record<string, unknown>), ...(fields ?? {}), event_type, level: 'warn' })
    },
    error(event_type: string, fields?: Omit<JsonLogEvent, 'level' | 'event_type'> & { error?: JsonLogError }) {
      logEvent({ ...(base as Record<string, unknown>), ...(fields ?? {}), event_type, level: 'error' })
    },
  }
}

