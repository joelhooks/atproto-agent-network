# Pi-Based Agent Network PoC

Use [Pi](https://github.com/badlogic/pi-mono) as the agent runtime, not OpenClaw. But leverage OpenClaw's infrastructure patterns and Cloudflare primitives.

## Why Pi?

Pi is a minimal, focused agent runtime:
- Single-file architecture, easy to understand
- Terminal UI with streaming
- Tool execution
- Context management
- No heavyweight gateway or multi-channel complexity

For a PoC exploring atproto-style coordination, we want the simplest possible agent that can:
1. Hold an identity (DID)
2. Store memories (repo)
3. Send/receive messages (lexicons)
4. React to events (firehose)

## What We Steal from OpenClaw/moltworker

### Infrastructure Patterns

| Pattern | From | Use In Pi PoC |
|---------|------|---------------|
| Sandbox containers | moltworker | Run Pi agents in CF Sandbox |
| R2 backup/restore | moltworker | Persist agent state |
| Durable Objects | Cirrus | Per-agent identity + state |
| WebSocket proxy | moltworker | Real-time coordination |
| CF Access auth | moltworker | Admin protection |
| Hono routing | moltworker/Cirrus | Edge request handling |

### Specific Code to Lift

```
moltworker/
├── src/gateway/sync.ts      # R2 backup/restore logic
├── src/gateway/process.ts   # Sandbox process management  
├── src/auth/middleware.ts   # CF Access JWT validation
├── src/routes/cdp.ts        # Browser automation pattern
└── Dockerfile               # Sandbox container setup

cirrus/packages/pds/
├── src/repo/                # MST implementation
├── src/oauth/               # OAuth 2.1 for agent auth
└── src/firehose/            # WebSocket event streaming
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │  Pi Agent   │     │  Pi Agent   │     │  Pi Agent   │   │
│  │  Sandbox    │     │  Sandbox    │     │  Sandbox    │   │
│  │  (did:cf:a) │     │  (did:cf:b) │     │  (did:cf:c) │   │
│  └──────┬──────┘     └──────┬──────┘     └──────┬──────┘   │
│         │                   │                   │           │
│         └───────────────────┼───────────────────┘           │
│                             │                               │
│                             ▼                               │
│                    ┌─────────────────┐                      │
│                    │   Coordinator   │                      │
│                    │   Durable Obj   │                      │
│                    │                 │                      │
│                    │ • Event fanout  │                      │
│                    │ • Agent registry│                      │
│                    │ • Message queue │                      │
│                    └────────┬────────┘                      │
│                             │                               │
│         ┌───────────────────┼───────────────────┐           │
│         ▼                   ▼                   ▼           │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │     D1      │     │     R2      │     │  Vectorize  │   │
│  │  (records)  │     │   (blobs)   │     │ (embeddings)│   │
│  └─────────────┘     └─────────────┘     └─────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Phase 1: Single Agent

1. **Fork pi-mono**, add Cloudflare integration layer
2. **Sandbox wrapper**: Dockerfile + startup script (lift from moltworker)
3. **Identity**: Generate keypair, serve DID document
4. **Memory**: D1 for records, R2 for state backup
5. **Deploy**: Worker + Sandbox container

Deliverable: One Pi agent running on Cloudflare with persistent identity

## Phase 2: Agent Memory

1. **Record types**: Define memory schemas (Zod)
   - `agent.memory.note` — free-form observations
   - `agent.memory.decision` — choices with rationale
   - `agent.memory.fact` — structured claims
2. **D1 storage**: CRUD for records by collection
3. **Vectorize index**: Embed memories for semantic retrieval
4. **Query API**: `/memory/search`, `/memory/list`

Deliverable: Agent can store and retrieve memories semantically

## Phase 3: Multi-Agent Coordination

1. **Coordinator DO**: Central event bus
2. **Message lexicons**: 
   - `agent.comms.message` — direct messages
   - `agent.comms.request` — task assignments
   - `agent.comms.response` — task results
3. **WebSocket relay**: Real-time event streaming to agents
4. **Queue integration**: Async task processing

Deliverable: Two agents can message each other and coordinate on tasks

## Phase 4: Firehose

1. **Event streaming**: Coordinator broadcasts all record changes
2. **Subscription API**: Agents subscribe to collection prefixes
3. **Filtering**: Server-side filtering by DID, collection, action
4. **Cursor support**: Resume from last-seen event

Deliverable: Agents react to each other's state changes in real-time

## Pi Integration Points

Looking at pi-mono structure, key integration points:

```typescript
// agent.ts - Add identity
interface PiAgent {
  did: string
  signingKey: CryptoKeyPair
  // ... existing Pi fields
}

// memory.ts - Add durable storage
interface Memory {
  store(collection: string, record: unknown): Promise<string>
  list(collection: string, opts?: ListOpts): Promise<Record[]>
  search(query: string, opts?: SearchOpts): Promise<Record[]>
}

// comms.ts - Add messaging
interface Comms {
  send(to: string, message: Message): Promise<void>
  subscribe(collections: string[]): AsyncIterable<Event>
}
```

## Development Plan

```bash
# Week 1: Single agent
- Fork pi-mono → joelhooks/pi-agent-cf
- Add Sandbox Dockerfile (steal from moltworker)
- Basic identity (keypair + DID doc)
- Deploy to Cloudflare

# Week 2: Memory
- D1 schema for records
- CRUD endpoints
- Vectorize integration
- Memory tool for Pi

# Week 3: Multi-agent
- Coordinator DO
- Message lexicons
- WebSocket relay
- Two-agent demo

# Week 4: Polish
- Firehose with cursors
- Error handling
- Documentation
- Example workflows
```

## What We're NOT Building

- Full PDS compatibility (use Cirrus if you need that)
- Bluesky interop (private network only)
- Account migration
- OAuth provider (CF Access is enough)
- Multi-user (single owner, multiple agents)

This is a PoC to validate the patterns. If it works, we can add federation later.

## Resources

- **Pi**: https://github.com/badlogic/pi-mono
- **moltworker**: https://github.com/cloudflare/moltworker
- **Cirrus**: https://github.com/ascorbic/cirrus
- **Sandbox docs**: https://developers.cloudflare.com/sandbox/
- **Durable Objects**: https://developers.cloudflare.com/durable-objects/
