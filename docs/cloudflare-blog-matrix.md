# Building a serverless, post-quantum Matrix homeserver

**Source:** https://blog.cloudflare.com/serverless-matrix-homeserver-workers/
**Date:** 2026-01-27
**Author:** Nick Kuntz

Matrix is the gold standard for decentralized, end-to-end encrypted communication. It powers government messaging systems, open-source communities, and privacy-focused organizations worldwide.

For the individual developer, however, the appeal is often closer to home: bridging fragmented chat networks (like Discord and Slack) into a single inbox, or simply ensuring your conversation history lives on infrastructure you control. Functionally, Matrix operates as a decentralized, eventually consistent state machine. Instead of a central server pushing updates, homeservers exchange signed JSON events over HTTP, using a conflict resolution algorithm to merge these streams into a unified view of the room's history.

But there is a "tax" to running it. Traditionally, operating a Matrix homeserver has meant accepting a heavy operational burden. You have to provision virtual private servers (VPS), tune PostgreSQL for heavy write loads, manage Redis for caching, configure reverse proxies, and handle rotation for TLS certificates. It's a stateful, heavy beast that demands to be fed time and money, whether you're using it a lot or a little.

**Spoiler:** We could eliminate that tax entirely.

**Repo:** https://github.com/nickkutz/matrix-workers

## From Synapse to Workers

Our starting point was Synapse, the Python-based reference Matrix homeserver designed for traditional deployments. PostgreSQL for persistence, Redis for caching, filesystem for media.

Porting it to Workers meant questioning every storage assumption we'd taken for granted.

The challenge was storage. Traditional homeservers assume strong consistency via a central SQL database. Cloudflare Durable Objects offers a powerful alternative. This primitive gives us the strong consistency and atomicity required for Matrix state resolution, while still allowing the application to run at the edge.

We ported the core Matrix protocol logic — event authorization, room state resolution, cryptographic verification — in TypeScript using the Hono framework.

### The Storage Mapping

| Traditional | Cloudflare |
|-------------|------------|
| PostgreSQL | D1 |
| Redis | KV |
| Filesystem | R2 |
| Mutexes | Durable Objects |

## From monolith to serverless

Moving to Cloudflare Workers brings several advantages:

### Easy deployment

A traditional Matrix deployment requires server provisioning, PostgreSQL administration, Redis cluster management, TLS certificate renewal, load balancer configuration, monitoring infrastructure, and on-call rotations.

With Workers, deployment is simply: `wrangler deploy`. Workers handles TLS, load balancing, DDoS protection, and global distribution.

### Usage-based costs

Traditional homeservers cost money whether anyone is using them or not. Workers pricing is request-based, so you pay when you're using it, but costs drop to near zero when everyone's asleep.

### Lower latency globally

A traditional Matrix homeserver in us-east-1 adds 200ms+ latency for users in Asia or Europe. Workers run in 300+ locations worldwide. When a user in Tokyo sends a message, the Worker executes in Tokyo.

### Built-in security

Matrix homeservers can be high-value targets: They handle encrypted communications, store message history, and authenticate users. Traditional deployments require careful hardening: firewall configuration, rate limiting, DDoS mitigation, WAF rules, IP reputation filtering.

Workers provide all of this by default.

## Post-quantum protection

Cloudflare deployed post-quantum hybrid key agreement across all TLS 1.3 connections in October 2022. Every connection to our Worker automatically negotiates X25519MLKEM768 — a hybrid combining classical X25519 with ML-KEM, the post-quantum algorithm standardized by NIST.

Classical cryptography relies on mathematical problems that are hard for traditional computers but trivial for quantum computers running Shor's algorithm. ML-KEM is based on lattice problems that remain hard even for quantum computers. The hybrid approach means both algorithms must fail for the connection to be compromised.

## Following a message through the system

When someone sends a message through our homeserver:

1. The sender's client takes the plaintext message and encrypts it with Megolm — Matrix's end-to-end encryption
2. This encrypted payload then gets wrapped in TLS for transport
3. On Cloudflare, that TLS connection uses X25519MLKEM768, making it quantum-resistant
4. The Worker terminates TLS, but receives Megolm ciphertext (still encrypted)
5. We store that ciphertext in D1, index it by room and timestamp
6. When the recipient syncs, the process reverses over another quantum-resistant TLS connection

**We never see the plaintext.** The message "Hello, world" exists only on the sender's device and the recipient's device.

## Two encryption layers

This protects via two encryption layers that operate independently:

- **Transport layer (TLS)** — Protects data in transit. With X25519MLKEM768, this layer is now post-quantum.
- **Application layer (Megolm E2EE)** — Protects message content. Encrypted on sender's device, decrypted only on recipient devices.

## The storage architecture that made it work

Different data needs different consistency guarantees. We use each Cloudflare primitive for what it does best.

### D1 for the data model

D1 stores everything that needs to survive restarts and support queries: users, rooms, events, device keys. Over 25 tables covering the full Matrix data model.

```sql
CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    event_type TEXT NOT NULL,
    state_key TEXT,
    content TEXT NOT NULL,
    origin_server_ts INTEGER NOT NULL,
    depth INTEGER NOT NULL
);
```

D1's SQLite foundation meant we could port queries with minimal changes. Joins, indexes, and aggregations work as expected.

**Hard lesson:** D1's eventual consistency breaks foreign key constraints. A write to rooms might not be visible when a subsequent write to events checks the foreign key. We removed all foreign keys and enforce referential integrity in application code.

### KV for ephemeral state

OAuth authorization codes live for 10 minutes, while refresh tokens last for a session.

```typescript
kv.put(`oauth_code:${code}`, tokenData, { expirationTtl: 600 });
```

KV's global distribution means OAuth flows work fast regardless of where users are located.

### R2 for media

Matrix media maps directly to R2, so you can upload an image, get back a content-addressed URL – and egress is free.

### Durable Objects for atomicity

Some operations can't tolerate eventual consistency. When a client claims a one-time encryption key, that key must be atomically removed. If two clients claim the same key, encrypted session establishment fails.

```typescript
@durableObject
class UserKeysObject {
    async claimOtk(algorithm: string): Promise<Key | null> {
        // Atomic within single DO - no race conditions possible
        const keys = await this.state.storage.get('one_time_keys') || [];
        const idx = keys.findIndex(k => k.algorithm === algorithm);
        if (idx >= 0) {
            const key = keys.splice(idx, 1)[0];
            await this.state.storage.put('one_time_keys', keys);
            return key;
        }
        return null;
    }
}
```

We use:
- **UserKeysObject** for E2EE key management
- **RoomObject** for real-time room events like typing indicators and read receipts
- **UserSyncObject** for to-device message queues

The rest flows through D1.

## Complete E2EE and OAuth

Our implementation supports the full Matrix E2EE stack: device keys, cross-signing keys, one-time keys, fallback keys, key backup, and dehydrated devices.

Modern Matrix clients use OAuth 2.0/OIDC instead of legacy password flows. We implemented a complete OAuth provider.

```bash
curl https://matrix.example.com/.well-known/openid-configuration
{
  "issuer": "https://matrix.example.com",
  "authorization_endpoint": "https://matrix.example.com/oauth/authorize",
  "token_endpoint": "https://matrix.example.com/oauth/token",
  "jwks_uri": "https://matrix.example.com/.well-known/jwks.json"
}
```

## Sliding Sync for mobile

Traditional Matrix sync transfers megabytes of data on initial connection, draining mobile battery and data plans.

Sliding Sync lets clients request exactly what they need. Instead of downloading everything, clients get the 20 most recent rooms with minimal state. As users scroll, they request more ranges. The server tracks position and sends only deltas.

Combined with edge execution, mobile clients can connect and render their room list in under 500ms, even on slow networks.

## The comparison

For a homeserver serving a small team:

| | Traditional (VPS) | Workers |
|---|---|---|
| Monthly cost (idle) | $20-50 | <$1 |
| Monthly cost (active) | $20-50 | $3-10 |
| Global latency | 100-300ms | 20-50ms |
| Time to deploy | Hours | Seconds |
| Maintenance | Weekly | None |
| DDoS protection | Additional cost | Included |
| Post-quantum TLS | Complex setup | Automatic |

## The future of decentralized protocols

We started this as an experiment: could Matrix run on Workers? It can—and the approach can work for other stateful protocols, too.

By mapping traditional stateful components to Cloudflare's primitives — Postgres to D1, Redis to KV, mutexes to Durable Objects — complex applications don't need complex infrastructure. We stripped away the operating system, the database management, and the network configuration, leaving only the application logic and the data itself.

**Workers offers the sovereignty of owning your data, without the burden of owning the infrastructure.**
