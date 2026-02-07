# ⚡ AT Protocol Agent Network on Cloudflare

⚡ A decentralized agent communication and memory network, implementing AT Protocol concepts on Cloudflare primitives.

**Published:** [grimlock.ai/garden/atproto-agent-network](https://grimlock.ai/garden/atproto-agent-network)

## Security Model

**Private by default. Encrypted by default.**

| Layer | Protection |
|-------|------------|
| Transport | TLS 1.3 + X25519MLKEM768 (post-quantum) |
| At-rest | Per-agent X25519 encryption keys |
| Memory | Envelope encryption (DEK per record) |
| Sharing | Explicit key exchange for public/shared |

Privacy levels:
- **private** (default) — Only the agent can decrypt
- **shared** — DEK encrypted for specific recipients
- **public** — Opt-in plaintext for network visibility

See [PI-POC.md](./PI-POC.md) for full security architecture.

## Prior Art

Before building anything, study these:

- **[Cirrus](https://github.com/ascorbic/cirrus)** — Production-ready single-user PDS on Cloudflare Workers. Uses Durable Objects (SQLite) + R2. Includes OAuth 2.1, passkeys, account migration. This is the reference implementation.
- **[Cloudflare Blog: Serverless ATProto](https://blog.cloudflare.com/serverless-atproto/)** — Official walkthrough
- **[atproto-oauth-client-cloudflare-workers](https://github.com/nDimensional/atproto-oauth-client-cloudflare-workers)** — OAuth client patched for Workers runtime
- **[AT Protocol Self-Hosting Guide](https://atproto.com/guides/self-hosting)** — Official PDS hosting docs

**What this repo adds:** Multi-agent coordination layer. Cirrus handles single-user PDS; this spec handles N agents talking to each other via typed lexicons, shared memory, and real-time coordination.

## Why Cloudflare?

AT Protocol provides the conceptual model—DIDs, repos, lexicons, firehose—but running a full PDS/relay stack is heavy. Cloudflare's primitives map surprisingly well to atproto's architecture while being operationally simpler:

| AT Protocol | Cloudflare | Notes |
|-------------|------------|-------|
| DID/Identity | Durable Objects | One DO per agent, holds keys and state |
| Repo (MST) | D1 + R2 | D1 for records, R2 for blobs |
| Lexicons | TypeScript schemas | Zod validation at edge |
| Firehose | DO WebSockets + Queues | Real-time via DO, async via Queues |
| Relay | Worker + DO coordination | Aggregates events, routes messages |
| PDS | The whole stack | D1/R2/DO combined = mini-PDS |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │  Agent DO   │     │  Agent DO   │     │  Agent DO   │       │
│  │  (did:cf:a) │     │  (did:cf:b) │     │  (did:cf:c) │       │
│  │             │     │             │     │             │       │
│  │ • Keys      │     │ • Keys      │     │ • Keys      │       │
│  │ • State     │     │ • State     │     │ • State     │       │
│  │ • WebSocket │     │ • WebSocket │     │ • WebSocket │       │
│  └──────┬──────┘     └──────┬──────┘     └──────┬──────┘       │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             │                                   │
│                             ▼                                   │
│                    ┌─────────────────┐                          │
│                    │   Relay DO      │                          │
│                    │                 │                          │
│                    │ • Event fanout  │                          │
│                    │ • Subscriptions │                          │
│                    │ • Filtering     │                          │
│                    └────────┬────────┘                          │
│                             │                                   │
│         ┌───────────────────┼───────────────────┐               │
│         ▼                   ▼                   ▼               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │     D1      │     │     R2      │     │  Vectorize  │       │
│  │  (records)  │     │   (blobs)   │     │ (embeddings)│       │
│  └─────────────┘     └─────────────┘     └─────────────┘       │
│                                                                 │
│                    ┌─────────────────┐                          │
│                    │     Queues      │                          │
│                    │ (async tasks)   │                          │
│                    └─────────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Agent Durable Object

Each agent is a Durable Object with:
- **Identity**: Signing keys (Ed25519), DID document
- **State**: Current context, active tasks, session data
- **WebSocket**: Real-time bidirectional communication
- **Hibernation**: Scales to zero when idle

```typescript
// src/agent.ts
import { DurableObject } from 'cloudflare:workers'

export class AgentDO extends DurableObject {
  private did: string
  private signingKey: CryptoKeyPair

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.did = `did:cf:${ctx.id.toString()}`
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request)
    }

    switch (url.pathname) {
      case '/identity':
        return this.getIdentity()
      case '/memory/create':
        return this.createRecord(request)
      case '/memory/list':
        return this.listRecords(request)
      case '/message':
        return this.sendMessage(request)
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    
    this.ctx.acceptWebSocket(server)
    
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string) {
    const event = JSON.parse(message)
    // Handle incoming events, emit to relay
  }

  webSocketClose(ws: WebSocket) {
    // Cleanup subscriptions
  }
}
```

### 2. Memory Records (D1)

D1 stores structured records, mimicking atproto repo collections:

```sql
-- schema.sql
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  record JSON NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(did, collection, rkey)
);

CREATE INDEX idx_records_did_collection ON records(did, collection);
CREATE INDEX idx_records_collection ON records(collection);

CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ops JSON NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_commits_did_seq ON commits(did, seq);
```

```typescript
// src/memory.ts
import { z } from 'zod'

// Lexicon-style schemas
const MemoryNote = z.object({
  $type: z.literal('agent.memory.note'),
  summary: z.string(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  createdAt: z.string().datetime(),
})

const MemoryDecision = z.object({
  $type: z.literal('agent.memory.decision'),
  decision: z.string(),
  context: z.string(),
  options: z.array(z.string()).optional(),
  rationale: z.string(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  createdAt: z.string().datetime(),
})

export async function createRecord(
  db: D1Database,
  did: string,
  collection: string,
  record: unknown
): Promise<{ uri: string; cid: string }> {
  const rkey = generateTid()
  const id = `${did}/${collection}/${rkey}`
  
  await db.prepare(`
    INSERT INTO records (id, did, collection, rkey, record, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, did, collection, rkey, JSON.stringify(record), new Date().toISOString()).run()
  
  // Emit commit event
  await emitCommit(db, did, { action: 'create', path: `${collection}/${rkey}`, record })
  
  return { uri: `at://${id}`, cid: hashRecord(record) }
}
```

### 3. Blob Storage (R2)

Large artifacts go in R2, referenced by CID in records:

```typescript
// src/blobs.ts
export async function uploadBlob(
  r2: R2Bucket,
  did: string,
  data: ArrayBuffer,
  mimeType: string
): Promise<{ cid: string; size: number }> {
  const cid = await hashBlob(data)
  const key = `${did}/blobs/${cid}`
  
  await r2.put(key, data, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { did, cid },
  })
  
  return { cid, size: data.byteLength }
}

export async function getBlob(
  r2: R2Bucket,
  did: string,
  cid: string
): Promise<R2ObjectBody | null> {
  return r2.get(`${did}/blobs/${cid}`)
}
```

### 4. Relay (Event Coordination)

A coordinator DO that aggregates events and manages subscriptions:

```typescript
// src/relay.ts
export class RelayDO extends DurableObject {
  private subscriptions = new Map<string, Set<WebSocket>>()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleSubscription(request)
    }

    const url = new URL(request.url)
    if (url.pathname === '/emit') {
      return this.handleEmit(request)
    }

    return new Response('Not found', { status: 404 })
  }

  private async handleSubscription(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const collections = url.searchParams.get('collections')?.split(',') || ['*']
    const dids = url.searchParams.get('dids')?.split(',') || ['*']

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    
    // Store subscription filters
    server.serializeAttachment({ collections, dids })
    this.ctx.acceptWebSocket(server)

    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleEmit(request: Request): Promise<Response> {
    const event = await request.json() as CommitEvent
    
    // Fan out to matching subscribers
    for (const ws of this.ctx.getWebSockets()) {
      const { collections, dids } = ws.deserializeAttachment() as SubscriptionFilter
      
      if (this.matches(event, collections, dids)) {
        ws.send(JSON.stringify(event))
      }
    }

    return new Response('OK')
  }

  private matches(event: CommitEvent, collections: string[], dids: string[]): boolean {
    const collectionMatch = collections.includes('*') || 
      collections.some(c => event.collection.startsWith(c))
    const didMatch = dids.includes('*') || dids.includes(event.did)
    return collectionMatch && didMatch
  }
}
```

### 5. Message Queue (Async Coordination)

For reliable async messaging between agents:

```typescript
// src/queue.ts
export interface AgentMessage {
  from: string  // sender DID
  to: string    // recipient DID
  collection: string
  record: unknown
  priority: number
}

export default {
  async queue(batch: MessageBatch<AgentMessage>, env: Env) {
    for (const msg of batch.messages) {
      const { from, to, collection, record } = msg.body
      
      // Get recipient's Agent DO
      const agentId = env.AGENTS.idFromName(to)
      const agent = env.AGENTS.get(agentId)
      
      // Deliver message
      await agent.fetch(new Request('https://agent/inbox', {
        method: 'POST',
        body: JSON.stringify({ from, collection, record }),
      }))
      
      msg.ack()
    }
  },
}
```

### 6. Semantic Memory (Vectorize)

For semantic retrieval alongside structured records:

```typescript
// src/vectorize.ts
export async function indexMemory(
  vectorize: VectorizeIndex,
  ai: Ai,
  did: string,
  record: MemoryRecord
): Promise<void> {
  const text = `${record.summary} ${record.text || ''}`
  
  const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] })
  
  await vectorize.upsert([{
    id: `${did}/${record.collection}/${record.rkey}`,
    values: embedding.data[0],
    metadata: {
      did,
      collection: record.collection,
      tags: record.tags?.join(','),
      createdAt: record.createdAt,
    },
  }])
}

export async function searchMemory(
  vectorize: VectorizeIndex,
  ai: Ai,
  query: string,
  options: { did?: string; collection?: string; limit?: number }
): Promise<VectorizeMatch[]> {
  const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [query] })
  
  const filter: VectorizeFilter = {}
  if (options.did) filter.did = options.did
  if (options.collection) filter.collection = options.collection
  
  return vectorize.query(embedding.data[0], {
    topK: options.limit || 10,
    filter,
  })
}
```

## Identity: did:cf

A lightweight DID method for Cloudflare-native identities:

```typescript
// did:cf:<durable-object-id>
// 
// DID Document:
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:cf:abc123",
  "verificationMethod": [{
    "id": "did:cf:abc123#signing",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:cf:abc123",
    "publicKeyMultibase": "z6Mk..."
  }],
  "service": [{
    "id": "did:cf:abc123#agent",
    "type": "AgentService",
    "serviceEndpoint": "https://agents.example.com/did:cf:abc123"
  }]
}
```

For interop with atproto, agents can also hold a `did:plc` or `did:web` and cross-reference.

## Message Lexicons

Typed message schemas (Zod, but could be compiled from Lexicon JSON):

```typescript
// src/lexicons/agent.comms.ts
import { z } from 'zod'

export const Message = z.object({
  $type: z.literal('agent.comms.message'),
  sender: z.string(),  // DID
  recipient: z.string(),  // DID
  thread: z.string().optional(),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({ kind: z.literal('json'), data: z.unknown() }),
    z.object({ kind: z.literal('ref'), uri: z.string() }),
  ]),
  priority: z.number().int().min(1).max(5).default(3),
  createdAt: z.string().datetime(),
})

export const Request = z.object({
  $type: z.literal('agent.comms.request'),
  sender: z.string(),
  recipient: z.string(),
  task: z.string(),
  params: z.record(z.unknown()).optional(),
  deadline: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
})

export const Response = z.object({
  $type: z.literal('agent.comms.response'),
  sender: z.string(),
  recipient: z.string(),
  requestUri: z.string(),  // at:// URI of original request
  status: z.enum(['accepted', 'completed', 'failed', 'rejected']),
  result: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
})
```

## Deployment

```bash
# wrangler.toml
name = "agent-network"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[durable_objects.bindings]]
name = "AGENTS"
class_name = "AgentDO"

[[durable_objects.bindings]]
name = "RELAY"
class_name = "RelayDO"

[[d1_databases]]
binding = "DB"
database_name = "agent-records"
database_id = "..."

[[r2_buckets]]
binding = "BLOBS"
bucket_name = "agent-blobs"

[[vectorize]]
binding = "VECTORIZE"
index_name = "agent-memory"

[[queues.producers]]
queue = "agent-messages"
binding = "MESSAGE_QUEUE"

[[queues.consumers]]
queue = "agent-messages"
max_batch_size = 10
max_batch_timeout = 30

[ai]
binding = "AI"
```

## Comparison: Full atproto vs Cloudflare Implementation

| Aspect | Full atproto Stack | Cloudflare Implementation |
|--------|-------------------|---------------------------|
| Identity | `did:plc` with PLCs | `did:cf` (DO-based) or bridge to `did:plc` |
| Repo Storage | MST in PDS | D1 tables + R2 blobs |
| Signing | Repo commit signatures | Per-record or batch signing |
| Firehose | WebSocket CBOR stream | DO WebSocket JSON stream |
| Interop | Full federation | Bridge to atproto via adapters |
| Ops Complexity | PDS + Relay + DID services | Managed edge services |
| Cost | Self-hosted or paid PDS | Pay-per-use edge compute |

## Building on Cirrus

For a single-agent PDS, use [Cirrus](https://github.com/ascorbic/cirrus) directly:

```bash
npm create pds
```

Cirrus handles:
- Repository operations (create, read, update, delete records)
- Federation (sync, firehose, blob storage)
- OAuth 2.1 provider (PKCE, DPoP, PAR)
- Account migration (tested and verified)
- Passkey authentication

For multi-agent coordination, extend Cirrus or run multiple instances with:
1. Custom `agent.comms.*` lexicons for typed messaging
2. Relay DO for event aggregation across agent PDSes
3. Vectorize index for semantic memory retrieval
4. Queues for async task coordination

## Tradeoffs

**Pros:**
- Zero operational overhead (managed edge)
- Automatic scaling and hibernation
- Low latency globally (edge deployment)
- Integrated vector search and AI
- Simple deployment (wrangler)
- Cirrus provides production-ready PDS foundation

**Cons:**
- Not federated with existing atproto network (without bridges)
- Vendor lock-in to Cloudflare
- D1/R2 limits vs. dedicated databases
- Cirrus is single-user; multi-agent requires extension

**When to use this:**
- Private agent networks (enterprise, internal tools)
- Prototyping agent coordination patterns
- Edge-first applications where latency matters
- Teams already on Cloudflare

**When to use full atproto:**
- Public agent interop with Bluesky ecosystem
- Decentralization as a core requirement
- Need for portable identity across hosts

## Research

See `/docs` for detailed research on each component:
- [CONCEPTS.md](./docs/CONCEPTS.md) - Core atproto concepts
- [IDENTITY.md](./docs/IDENTITY.md) - DID and identity patterns
- [MEMORY.md](./docs/MEMORY.md) - Repository and memory design
- [LEXICONS.md](./docs/LEXICONS.md) - Schema and message contracts
- [FIREHOSE.md](./docs/FIREHOSE.md) - Real-time coordination
- [SECURITY.md](./docs/SECURITY.md) - Trust and encryption
- [IMPLEMENTATION.md](./docs/IMPLEMENTATION.md) - atproto code examples
- [BLOG-POST.md](./docs/BLOG-POST.md) - Synthesis and runnable demo

## Sources

This research builds on work from:

- **[Cirrus](https://github.com/ascorbic/cirrus)** by Matt Kane — Production PDS on Cloudflare
- **[moltworker](https://github.com/cloudflare/moltworker)** — OpenClaw on CF Sandbox ([blog](https://blog.cloudflare.com/moltworker-self-hosted-ai-agent/))
- **[Serverless Statusphere](https://blog.cloudflare.com/serverless-statusphere/)** by Inanna Malick — ATProto on CF Workers
- **[Serverless Matrix](https://blog.cloudflare.com/serverless-matrix-homeserver-workers/)** by Nick Kuntz — Matrix on CF with post-quantum TLS
- **[atproto-oauth-client-cloudflare-workers](https://github.com/nDimensional/atproto-oauth-client-cloudflare-workers)** — OAuth for CF Workers
- **[AT Protocol Docs](https://atproto.com)** — Official specs

Full blog post text archived in `docs/cloudflare-blog-*.md`.

## License

MIT
