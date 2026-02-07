# ⚡ Pi Agent Network PoC

**SECURITY BY DEFAULT. PRIVATE BY DEFAULT.**

Use [Pi](https://github.com/badlogic/pi-mono) as the agent runtime on Cloudflare. Every memory encrypted. Public sharing opt-in.

## Security Model: Private by Default

```
┌─────────────────────────────────────────────────────────────────┐
│                     ENCRYPTION LAYERS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. TRANSPORT: TLS 1.3 + X25519MLKEM768 (post-quantum)          │
│     └── Automatic on Cloudflare, all connections                 │
│                                                                  │
│  2. AT-REST: Per-agent encryption keys (X25519)                  │
│     └── Each agent has a keypair in their Durable Object         │
│     └── D1 records store ciphertext, not plaintext               │
│     └── R2 blobs encrypted before upload                         │
│                                                                  │
│  3. MEMORY: Envelope encryption per record                       │
│     └── DEK (Data Encryption Key) per record                     │
│     └── DEK encrypted with agent's public key                    │
│     └── Rotate keys without re-encrypting all data               │
│                                                                  │
│  4. SHARING: Explicit key exchange for public/shared             │
│     └── Default: only agent can decrypt                          │
│     └── Public: re-encrypt with network-wide key                 │
│     └── Shared: recipient's public key encrypts DEK              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Privacy Levels

| Level | Who can read | How it works |
|-------|--------------|--------------|
| **private** (default) | Agent only | DEK encrypted with agent's key |
| **shared** | Specific agents | DEK encrypted for each recipient |
| **public** | Anyone | Plaintext (no DEK) |

### Key Management

```typescript
interface AgentIdentity {
  did: string                    // did:cf:<durable-object-id>
  signingKey: Ed25519KeyPair     // Signs commits, proves authorship
  encryptionKey: X25519KeyPair   // Encrypts memories
  rotationHistory: KeyRotation[] // Audit trail
}

interface EncryptedRecord {
  id: string
  collection: string
  ciphertext: Uint8Array         // Encrypted record content
  encryptedDek: Uint8Array       // DEK encrypted with agent's public key
  nonce: Uint8Array              // Unique per record
  recipients?: string[]          // DIDs who can decrypt (for shared)
  public?: boolean               // If true, ciphertext is actually plaintext
}
```

## Pi as the Agent Runtime

Pi provides the agent loop. We wrap it for Cloudflare deployment.

### What Drives an Agent

```typescript
import { Agent } from "@mariozechner/pi-agent-core"
import { getModel } from "@mariozechner/pi-ai"

// Pi agent instance per Durable Object
class AgentDO extends DurableObject {
  private agent: Agent
  private identity: AgentIdentity
  private memory: EncryptedMemory
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    
    // Load or create identity
    this.identity = await this.loadIdentity()
    
    // Initialize encrypted memory
    this.memory = new EncryptedMemory(env.D1, env.R2, this.identity)
    
    // Create Pi agent with tools
    this.agent = new Agent({
      initialState: {
        systemPrompt: await this.memory.getSystemPrompt(),
        model: getModel("anthropic", "claude-sonnet-4-5"),
        tools: this.getTools(),
      },
      // Transform context: inject relevant memories
      transformContext: async (messages) => {
        const context = await this.memory.search(messages)
        return [...context, ...messages]
      },
    })
  }
  
  // Agent tools with memory access
  private getTools(): AgentTool[] {
    return [
      this.memory.rememberTool(),     // Store encrypted memory
      this.memory.recallTool(),        // Search memories
      this.memory.shareTool(),         // Share with other agents
      this.comms.sendMessageTool(),    // Message other agents
      this.comms.broadcastTool(),      // Announce to network
    ]
  }
}
```

### Agent Triggers

What makes the agent think?

```typescript
class AgentDO extends DurableObject {
  
  // 1. Direct prompt (WebSocket from user/operator)
  async handleWebSocket(ws: WebSocket, message: string) {
    const result = await this.agent.prompt(message)
    ws.send(JSON.stringify(result))
  }
  
  // 2. Incoming message from another agent
  async handleAgentMessage(from: string, message: AgentMessage) {
    // Decrypt the message
    const plaintext = await this.identity.decrypt(message.ciphertext)
    
    // Store as memory with source
    await this.memory.store({
      collection: 'agent.comms.inbox',
      content: plaintext,
      metadata: { from, receivedAt: Date.now() }
    })
    
    // Prompt agent to respond
    const systemMsg = `Received message from ${from}: ${plaintext.text}`
    await this.agent.prompt(systemMsg)
  }
  
  // 3. Firehose event (something happened in the network)
  async handleNetworkEvent(event: NetworkEvent) {
    if (this.shouldReact(event)) {
      await this.agent.prompt(`Network event: ${event.type} from ${event.source}`)
    }
  }
  
  // 4. Scheduled task (cron-triggered via Queue)
  async handleScheduled(task: ScheduledTask) {
    await this.agent.prompt(`Scheduled task: ${task.description}`)
  }
  
  // 5. Tool result callback (another agent completed work)
  async handleTaskComplete(taskId: string, result: TaskResult) {
    await this.agent.prompt(`Task ${taskId} completed: ${JSON.stringify(result)}`)
  }
}
```

## Encrypted Memory System

```typescript
class EncryptedMemory {
  constructor(
    private db: D1Database,
    private blobs: R2Bucket,
    private identity: AgentIdentity
  ) {}
  
  async store(record: MemoryRecord): Promise<string> {
    // 1. Generate DEK for this record
    const dek = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    
    // 2. Encrypt content with DEK
    const plaintext = new TextEncoder().encode(JSON.stringify(record.content))
    const ciphertext = await this.encrypt(plaintext, dek, nonce)
    
    // 3. Encrypt DEK with agent's public key
    const encryptedDek = await this.identity.encryptForSelf(dek)
    
    // 4. Store encrypted record
    const id = generateTid()
    await this.db.prepare(`
      INSERT INTO records (id, did, collection, ciphertext, encrypted_dek, nonce, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, 
      this.identity.did, 
      record.collection,
      ciphertext,
      encryptedDek,
      nonce,
      new Date().toISOString()
    ).run()
    
    // 5. Index in Vectorize (embed the plaintext, store with record ID)
    await this.indexForSearch(id, record.content)
    
    return id
  }
  
  async retrieve(id: string): Promise<MemoryRecord | null> {
    const row = await this.db.prepare(`
      SELECT * FROM records WHERE id = ? AND did = ?
    `).bind(id, this.identity.did).first()
    
    if (!row) return null
    
    // Decrypt DEK
    const dek = await this.identity.decryptDek(row.encrypted_dek)
    
    // Decrypt content
    const plaintext = await this.decrypt(row.ciphertext, dek, row.nonce)
    
    return JSON.parse(new TextDecoder().decode(plaintext))
  }
  
  async share(id: string, recipient: string): Promise<void> {
    // Get recipient's public key
    const recipientKey = await this.resolvePublicKey(recipient)
    
    // Re-encrypt DEK for recipient
    const dek = await this.identity.decryptDek(record.encrypted_dek)
    const sharedDek = await box(dek, recipientKey)
    
    // Store in shared_records table
    await this.db.prepare(`
      INSERT INTO shared_records (record_id, recipient_did, encrypted_dek)
      VALUES (?, ?, ?)
    `).bind(id, recipient, sharedDek).run()
    
    // Notify recipient via Queue
    await this.env.MESSAGE_QUEUE.send({
      type: 'memory_shared',
      from: this.identity.did,
      to: recipient,
      recordId: id
    })
  }
  
  async makePublic(id: string): Promise<void> {
    // Re-encrypt as plaintext (remove encryption)
    const record = await this.retrieve(id)
    
    await this.db.prepare(`
      UPDATE records 
      SET ciphertext = ?, encrypted_dek = NULL, public = TRUE
      WHERE id = ? AND did = ?
    `).bind(
      new TextEncoder().encode(JSON.stringify(record)),
      id,
      this.identity.did
    ).run()
  }
}
```

## Network Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐     ┌─────────────────┐                    │
│  │  Pi Agent DO    │     │  Pi Agent DO    │                    │
│  │  (did:cf:alice) │     │  (did:cf:bob)   │                    │
│  │                 │     │                 │                    │
│  │ ┌─────────────┐ │     │ ┌─────────────┐ │                    │
│  │ │ Pi Agent    │ │     │ │ Pi Agent    │ │                    │
│  │ │ Runtime     │ │     │ │ Runtime     │ │                    │
│  │ └─────────────┘ │     │ └─────────────┘ │                    │
│  │ ┌─────────────┐ │     │ ┌─────────────┐ │                    │
│  │ │ Encrypted   │ │     │ │ Encrypted   │ │                    │
│  │ │ Memory      │ │     │ │ Memory      │ │                    │
│  │ └─────────────┘ │     │ └─────────────┘ │                    │
│  │ ┌─────────────┐ │     │ ┌─────────────┐ │                    │
│  │ │ X25519 Keys │ │     │ │ X25519 Keys │ │                    │
│  │ └─────────────┘ │     │ └─────────────┘ │                    │
│  └────────┬────────┘     └────────┬────────┘                    │
│           │                       │                              │
│           └───────────┬───────────┘                              │
│                       │                                          │
│              ┌────────▼────────┐                                │
│              │   Coordinator   │                                │
│              │   Durable Obj   │                                │
│              │                 │                                │
│              │ • Agent registry│                                │
│              │ • Event fanout  │                                │
│              │ • Public keys   │                                │
│              └────────┬────────┘                                │
│                       │                                          │
│    ┌──────────────────┼──────────────────┐                      │
│    ▼                  ▼                  ▼                      │
│ ┌──────┐         ┌──────┐         ┌───────────┐                 │
│ │  D1  │         │  R2  │         │ Vectorize │                 │
│ │ enc  │         │ enc  │         │ (indexes) │                 │
│ └──────┘         └──────┘         └───────────┘                 │
│                                                                  │
│              ┌─────────────────┐                                │
│              │     Queues      │                                │
│              │ (async comms)   │                                │
│              └─────────────────┘                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Message Types (Lexicons)

```typescript
// All messages signed + encrypted by default
const MessageSchema = z.object({
  $type: z.literal('agent.comms.message'),
  sender: z.string(),       // DID
  recipient: z.string(),    // DID
  thread: z.string().optional(),
  content: z.object({
    kind: z.enum(['text', 'json', 'ref']),
    data: z.unknown()
  }),
  // Crypto envelope
  signature: z.string(),    // Ed25519 signature of content
  encryptedDek: z.string(), // DEK encrypted for recipient
  nonce: z.string(),
  ciphertext: z.string(),   // Actual content (encrypted)
})

// Task delegation
const TaskRequestSchema = z.object({
  $type: z.literal('agent.comms.task'),
  sender: z.string(),
  recipient: z.string(),
  task: z.string(),         // Natural language task description
  params: z.record(z.unknown()).optional(),
  deadline: z.string().optional(),
  replyTo: z.string(),      // Where to send results
  // Privacy
  resultVisibility: z.enum(['private', 'shared', 'public']).default('private'),
})

// Handoff (full context transfer)
const HandoffSchema = z.object({
  $type: z.literal('agent.comms.handoff'),
  from: z.string(),
  to: z.string(),
  context: z.array(z.object({
    recordId: z.string(),
    encryptedDek: z.string(), // Re-encrypted for recipient
  })),
  reason: z.string(),
})
```

## Implementation Phases

### Phase 1: Encrypted Single Agent (Week 1)

- [ ] Fork pi-mono → `joelhooks/pi-agent-cf`
- [ ] Cloudflare Durable Object wrapper for Pi Agent
- [ ] X25519 keypair generation + storage
- [ ] Envelope encryption for memories (DEK + agent key)
- [ ] D1 schema with encrypted records
- [ ] Basic tools: remember, recall
- [ ] Deploy single agent

**Security checkpoint:** All memories encrypted. No plaintext in D1.

### Phase 2: Semantic Memory (Week 2)

- [ ] Vectorize integration (embed plaintext, index encrypted)
- [ ] Semantic search across encrypted memories
- [ ] Memory decay/compaction (summarize old memories)
- [ ] Large blob handling (R2 + encrypted)

**Security checkpoint:** Search works on embeddings. Decryption only on retrieval.

### Phase 3: Multi-Agent Coordination (Week 3)

- [ ] Coordinator DO (agent registry, public keys)
- [ ] Encrypted messaging (recipient's public key encrypts DEK)
- [ ] Queue-based async messaging
- [ ] WebSocket firehose for real-time
- [ ] Task request/response pattern

**Security checkpoint:** End-to-end encryption between agents. Coordinator can't read messages.

### Phase 4: Selective Sharing (Week 4)

- [ ] `share(recordId, recipient)` — re-encrypt DEK for recipient
- [ ] `makePublic(recordId)` — store plaintext, announce
- [ ] Public timeline/firehose for public records
- [ ] Trust levels (allowlist, reputation)
- [ ] Key rotation without re-encrypting all data

**Security checkpoint:** Private by default. Public requires explicit action.

## What We're Building vs What Exists

| Concern | Cirrus | Our PoC |
|---------|--------|---------|
| Records | Plaintext | **Encrypted by default** |
| Agent runtime | N/A | **Pi (tool-calling, streaming)** |
| Multi-agent | Single-user PDS | **N agents coordinating** |
| Memory | Append-only repo | **Semantic search + decay** |
| Sharing | Public by default | **Private by default, opt-in public** |

## Threat Model

**We protect against:**
- Cloudflare reading memory contents (encrypted at rest)
- Network observers reading messages (E2E encrypted)
- Other agents reading private memories (per-agent keys)
- Key compromise (rotation without full re-encryption)

**We don't protect against:**
- Cloudflare timing attacks / traffic analysis
- Compromised agent DO (has decrypted state in memory)
- Quantum attacks on current encryption (not post-quantum at rest yet)

**Future hardening:**
- HSM-backed keys (if CF offers)
- Post-quantum at-rest encryption (ML-KEM)
- Trusted execution (CF Confidential VMs when available)

## Resources

- **Pi Monorepo:** https://github.com/badlogic/pi-mono
- **Pi Agent Core:** `@mariozechner/pi-agent-core`
- **Cloudflare Crypto:** https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- **libsodium (X25519):** https://github.com/nicknisi/libsodium-cloudflare-workers
