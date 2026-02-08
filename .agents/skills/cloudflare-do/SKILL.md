---
name: cloudflare-do
description: Cloudflare Durable Objects patterns for agent state. Use when implementing agent DOs, WebSocket handling, hibernation, storage API, alarms, or DO-to-DO communication. Triggers on Durable Object, DO state, WebSocket server, hibernation, agent persistence.
---

# Cloudflare Durable Objects

Durable Objects provide strongly consistent, single-threaded state for each agent.

## Core Pattern: Agent as Durable Object

```typescript
import { DurableObject } from 'cloudflare:workers'

export class AgentDO extends DurableObject {
  private initialized = false
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
  
  async fetch(request: Request): Promise<Response> {
    // Lazy initialization
    if (!this.initialized) {
      await this.initialize()
    }
    
    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request)
    }
    
    // HTTP routing
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/prompt':
        return this.handlePrompt(request)
      case '/memory':
        return this.handleMemory(request)
      default:
        return new Response('Not found', { status: 404 })
    }
  }
  
  private async initialize() {
    // Load identity and state from storage
    this.initialized = true
  }
}
```

## WebSocket with Hibernation

Hibernatable WebSockets allow DO to sleep while connections stay open:

```typescript
export class AgentDO extends DurableObject {
  async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    
    // Attach metadata that persists through hibernation
    server.serializeAttachment({ 
      connectedAt: Date.now(),
      subscriptions: ['agent.memory.*']
    })
    
    // Accept with hibernation support
    this.ctx.acceptWebSocket(server)
    
    return new Response(null, { status: 101, webSocket: client })
  }
  
  // Called when message arrives (even after hibernation)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as ConnectionMeta
    const data = JSON.parse(message as string)
    
    // Handle message
    const response = await this.processMessage(data)
    ws.send(JSON.stringify(response))
  }
  
  // Called when connection closes
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Cleanup subscriptions
  }
  
  // Called on connection error
  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error:', error)
  }
}
```

## Storage API

Key-value storage with strong consistency:

```typescript
// Store values
await this.ctx.storage.put('key', value)
await this.ctx.storage.put({ key1: val1, key2: val2 })

// Retrieve values
const val = await this.ctx.storage.get('key')
const vals = await this.ctx.storage.get(['key1', 'key2'])

// List with prefix
const entries = await this.ctx.storage.list({ prefix: 'memory:' })

// Delete
await this.ctx.storage.delete('key')
await this.ctx.storage.deleteAll() // Dangerous!

// Atomic transactions
await this.ctx.storage.transaction(async (txn) => {
  const current = await txn.get('counter') || 0
  await txn.put('counter', current + 1)
})
```

## Alarms

**Source:** https://developers.cloudflare.com/durable-objects/api/alarms/

Key facts:
- Each DO can have **one alarm at a time** (`setAlarm()` overrides previous)
- **Guaranteed at-least-once execution** — retried automatically on failure
- Retries use **exponential backoff** starting at 2s, up to 6 retries
- `alarm(alarmInfo)` receives `{ retryCount: number, isRetry: boolean }`
- Only one `alarm()` runs at a time per DO instance
- If DO crashes, alarm re-runs on another machine after short delay
- Calling `deleteAlarm()` inside `alarm()` may prevent retries (best-effort, not guaranteed)
- `getAlarm()` returns `null` while alarm is running (unless `setAlarm()` called during handler)

### API

```typescript
// Storage API methods
ctx.storage.setAlarm(scheduledTimeMs: number): void   // Set alarm (epoch ms)
ctx.storage.getAlarm(): number | null                  // Get current alarm time or null
ctx.storage.deleteAlarm(): void                        // Cancel alarm

// Handler (on the DurableObject class)
async alarm(alarmInfo?: { retryCount: number, isRetry: boolean }): void
```

### Agent Loop Pattern

```typescript
export class AgentDO extends DurableObject {
  async startLoop() {
    await this.ctx.storage.put('loopRunning', true)
    await this.ctx.storage.setAlarm(Date.now()) // Fire immediately
  }

  async stopLoop() {
    await this.ctx.storage.put('loopRunning', false)
    await this.ctx.storage.deleteAlarm()
  }

  async alarm(alarmInfo?: { retryCount: number, isRetry: boolean }) {
    const running = await this.ctx.storage.get('loopRunning')
    if (!running) return // Don't reschedule

    try {
      if (alarmInfo?.isRetry) {
        console.log(`Alarm retry #${alarmInfo.retryCount}`)
      }
      await this.runLoopCycle()
    } catch (err) {
      console.error('Loop cycle error:', err)
      // DON'T rethrow if you want to control retry behavior
      // Rethrow if you want automatic exponential backoff retry
    }

    // Always reschedule (even after error) to keep the chain alive
    const config = await this.ctx.storage.get('config')
    const interval = config?.loopIntervalMs ?? 60_000
    await this.ctx.storage.setAlarm(Date.now() + interval)
  }
}
```

### Managing Multiple Scheduled Events

For complex scheduling (multiple events at different times):

```typescript
async alarm() {
  const now = Date.now()
  const events = await this.ctx.storage.list({ prefix: 'event:' })
  let nextAlarm = null

  for (const [key, event] of events) {
    if (event.runAt <= now) {
      await this.processEvent(event)
      if (event.repeatMs) {
        event.runAt = now + event.repeatMs
        await this.ctx.storage.put(key, event)
      } else {
        await this.ctx.storage.delete(key)
      }
    }
    if (event.runAt > now && (!nextAlarm || event.runAt < nextAlarm)) {
      nextAlarm = event.runAt
    }
  }

  if (nextAlarm) await this.ctx.storage.setAlarm(nextAlarm)
}
```

## DO-to-DO Communication

Agents calling other agents:

```typescript
async sendToAgent(targetDid: string, message: unknown): Promise<unknown> {
  // Get target DO stub
  const targetId = this.env.AGENTS.idFromName(targetDid)
  const target = this.env.AGENTS.get(targetId)
  
  // Call target's fetch
  const response = await target.fetch(new Request('https://agent/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: this.did,
      message
    })
  }))
  
  return response.json()
}
```

## Wrangler Configuration

```toml
[[durable_objects.bindings]]
name = "AGENTS"
class_name = "AgentDO"

[[durable_objects.bindings]]
name = "RELAY"
class_name = "RelayDO"

[[migrations]]
tag = "v1"
new_classes = ["AgentDO", "RelayDO"]
```

## References

- [Durable Objects API](https://developers.cloudflare.com/durable-objects/api/)
- [Hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation/)
- [DO Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/)
