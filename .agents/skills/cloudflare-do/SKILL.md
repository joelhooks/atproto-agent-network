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

Schedule future work:

```typescript
export class AgentDO extends DurableObject {
  async scheduleTask(delayMs: number) {
    const scheduled = Date.now() + delayMs
    await this.ctx.storage.setAlarm(scheduled)
  }
  
  // Called when alarm fires
  async alarm() {
    // Process scheduled work
    await this.processScheduledTasks()
    
    // Optionally schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + 60000)
  }
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
