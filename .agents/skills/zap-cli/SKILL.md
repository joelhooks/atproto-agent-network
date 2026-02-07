---
name: zap-cli
description: zap observability CLI for agent debugging. Use when implementing event logging, log viewing, query presets, decision traces, or network health monitoring. Triggers on zap, observability, logging, decision traces, debugging, agent events.
---

# zap CLI

Agent-first observability CLI. JSON output by default, jq-friendly.

## Event Schema

```typescript
interface AgentEvent {
  id: string                    // ULID
  agent_did: string
  session_id: string
  event_type: EventType
  outcome: 'success' | 'error' | 'timeout' | 'skipped'
  timestamp: string             // ISO-8601
  duration_ms?: number
  
  // Trace correlation
  trace_id?: string
  parent_span_id?: string
  span_id: string
  
  // Flexible context
  context: Record<string, unknown>
  
  // Decision reasoning
  reasoning?: {
    decision: string
    rationale: string
    alternatives?: string[]
    confidence?: number
  }
  
  // Error details
  error?: {
    code: string
    message: string
    stack?: string
    retryable: boolean
  }
}
```

## Event Types

| Type | Description |
|------|-------------|
| `agent.started` | Agent DO initialized |
| `agent.prompt` | Received prompt |
| `agent.response` | Completed response |
| `agent.tool_call` | Tool invoked |
| `agent.tool_error` | Tool failed |
| `memory.store` | Memory stored |
| `memory.search` | Memory queried |
| `memory.share` | Memory shared |
| `comms.message_sent` | Sent message |
| `comms.message_received` | Received message |
| `decision` | Decision with reasoning |
| `error.unhandled` | Unhandled error |

## Emit Events

```typescript
import { ulid } from 'ulid'

class EventEmitter {
  constructor(
    private db: D1Database,
    private agentDid: string,
    private sessionId: string
  ) {}
  
  async emit(event: Omit<AgentEvent, 'id' | 'agent_did' | 'session_id' | 'timestamp'>): Promise<string> {
    const id = ulid()
    
    await this.db.prepare(`
      INSERT INTO events (id, agent_did, session_id, event_type, outcome, timestamp, duration_ms, trace_id, span_id, parent_span_id, context, reasoning, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      this.agentDid,
      this.sessionId,
      event.event_type,
      event.outcome,
      new Date().toISOString(),
      event.duration_ms,
      event.trace_id,
      event.span_id,
      event.parent_span_id,
      JSON.stringify(event.context),
      event.reasoning ? JSON.stringify(event.reasoning) : null,
      event.error ? JSON.stringify(event.error) : null
    ).run()
    
    return id
  }
  
  // Convenience methods
  async toolCall(name: string, params: unknown, result: unknown, durationMs: number): Promise<string> {
    return this.emit({
      event_type: 'agent.tool_call',
      outcome: 'success',
      duration_ms: durationMs,
      span_id: ulid(),
      context: { tool_name: name, params, result_summary: summarize(result) }
    })
  }
  
  async decision(type: string, decision: string, rationale: string, alternatives?: string[]): Promise<string> {
    return this.emit({
      event_type: 'decision',
      outcome: 'success',
      span_id: ulid(),
      context: { decision_type: type },
      reasoning: { decision, rationale, alternatives, confidence: 0.9 }
    })
  }
}
```

## CLI Commands

### zap logs

View and filter logs:

```bash
# Recent logs (JSON output)
zap logs

# Human-friendly
zap logs --pretty

# Filter by time
zap logs --since 5m
zap logs --since 2h
zap logs --since "2025-01-01"

# Filter by type
zap logs --type tool_call
zap logs --type decision,memory.store

# Filter by outcome
zap logs --outcome error

# Watch mode (tail)
zap logs --watch
zap logs --watch --type error

# Complex filters (jq-style)
zap logs --filter '.duration_ms > 1000'
zap logs --filter '.context.tool_name == "remember"'
```

### zap query

SQL analytics with presets:

```bash
# Built-in presets
zap query --preset slow_tools
zap query --preset error_rate
zap query --preset decision_confidence
zap query --preset memory_hotspots

# Custom SQL
zap query --sql "SELECT event_type, COUNT(*) FROM events GROUP BY event_type"

# Output formats
zap query --preset error_rate --format json
zap query --preset error_rate --format csv
```

### zap trace

Decision trace analysis:

```bash
# View reasoning for event
zap trace <event-id>

# Find low-confidence decisions
zap traces --confidence-lt 0.5

# Replay decision sequence
zap replay --session sess-123 --type decision
```

### zap doctor

Self-diagnosis:

```bash
# Health check
zap doctor

# Storage usage
zap storage

# Index health
zap indexes
```

## Query Presets

```typescript
const PRESETS = {
  slow_tools: `
    SELECT 
      context->>'tool_name' as tool,
      COUNT(*) as calls,
      AVG(duration_ms) as avg_ms,
      MAX(duration_ms) as max_ms
    FROM events
    WHERE event_type = 'agent.tool_call'
    GROUP BY context->>'tool_name'
    HAVING AVG(duration_ms) > 100
    ORDER BY avg_ms DESC
  `,
  
  error_rate: `
    SELECT 
      event_type,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) / COUNT(*), 2) as error_pct
    FROM events
    GROUP BY event_type
    ORDER BY error_pct DESC
  `,
  
  decision_confidence: `
    SELECT 
      context->>'decision_type' as type,
      reasoning->>'decision' as decision,
      reasoning->>'confidence' as confidence,
      reasoning->>'rationale' as rationale
    FROM events
    WHERE event_type = 'decision'
    AND CAST(reasoning->>'confidence' AS REAL) < 0.7
    ORDER BY confidence ASC
    LIMIT 20
  `,
  
  memory_hotspots: `
    SELECT 
      context->>'collection' as collection,
      COUNT(*) as accesses,
      COUNT(DISTINCT session_id) as sessions
    FROM events
    WHERE event_type IN ('memory.store', 'memory.search')
    GROUP BY context->>'collection'
    ORDER BY accesses DESC
  `
}
```

## Retention Policy

Compact events over time:

```typescript
async function compactEvents(db: D1Database): Promise<void> {
  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000
  const sevenDays = 7 * oneDay
  const thirtyDays = 30 * oneDay
  
  // 7-30 days: aggregate to hourly buckets
  await db.prepare(`
    INSERT INTO events_hourly (hour, agent_did, event_type, count, avg_duration, error_count)
    SELECT 
      strftime('%Y-%m-%d %H:00:00', timestamp) as hour,
      agent_did,
      event_type,
      COUNT(*),
      AVG(duration_ms),
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END)
    FROM events
    WHERE timestamp < datetime('now', '-7 days')
    AND timestamp >= datetime('now', '-30 days')
    GROUP BY hour, agent_did, event_type
    ON CONFLICT DO NOTHING
  `).run()
  
  // Delete raw events older than 7 days
  await db.prepare(`
    DELETE FROM events
    WHERE timestamp < datetime('now', '-7 days')
  `).run()
  
  // Delete hourly aggregates older than 30 days
  await db.prepare(`
    DELETE FROM events_hourly
    WHERE hour < datetime('now', '-30 days')
  `).run()
}
```

## CLI Implementation

```typescript
#!/usr/bin/env bun

import { Command } from 'commander'

const program = new Command()
  .name('zap')
  .description('Agent observability CLI')
  .version('1.0.0')

program
  .command('logs')
  .description('View agent logs')
  .option('--since <time>', 'Show logs since time (e.g., 5m, 2h)')
  .option('--type <types>', 'Filter by event type (comma-separated)')
  .option('--outcome <outcome>', 'Filter by outcome')
  .option('--filter <expr>', 'jq-style filter expression')
  .option('--watch', 'Watch mode (tail)')
  .option('--pretty', 'Human-friendly output')
  .option('--limit <n>', 'Max results', '50')
  .action(async (options) => {
    // Implementation
  })

program
  .command('query')
  .description('Run SQL analytics')
  .option('--preset <name>', 'Use preset query')
  .option('--sql <query>', 'Custom SQL query')
  .option('--format <fmt>', 'Output format (json, csv, table)', 'json')
  .action(async (options) => {
    // Implementation
  })

program
  .command('trace <event-id>')
  .description('View decision trace')
  .action(async (eventId) => {
    // Implementation
  })

program
  .command('doctor')
  .description('Health check')
  .action(async () => {
    // Implementation
  })

program.parse()
```

## References

- [docs/O11Y.md](../../docs/O11Y.md) — Full observability architecture
- [Commander.js](https://github.com/tj/commander.js) — CLI framework
- [ULID Spec](https://github.com/ulid/spec) — Sortable unique IDs
