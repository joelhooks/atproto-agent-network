# References

## Existing Implementations

### Cirrus — PDS on Cloudflare
**Repo:** https://github.com/ascorbic/cirrus
**Status:** Beta, actively developed
**Author:** Matt Kane (@ascorbic)

The reference implementation for running AT Protocol PDS on Cloudflare. Single-user focus.

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Hono Router                                         │    │
│  │ • Authentication middleware                         │    │
│  │ • CORS handling                                     │    │
│  │ • DID document serving                              │    │
│  │ • XRPC endpoint routing                             │    │
│  │ • OAuth 2.1 provider                                │    │
│  │ • Proxy to AppView for read endpoints               │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ AccountDurableObject                                │    │
│  │ • SQLite repository storage                         │    │
│  │ • Merkle tree for commits                           │    │
│  │ • Record indexing                                   │    │
│  │ • WebSocket firehose                                │    │
│  │ • OAuth token storage                               │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ R2 Bucket                                           │    │
│  │ • Blob storage (images, videos)                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Repository operations (create, read, update, delete records)
- Federation (sync, firehose, blob storage)
- OAuth 2.1 provider (PKCE, DPoP, PAR)
- Account migration from/to other PDSes
- Passkey authentication (WebAuthn)
- CLI tooling (`pds init`, `pds migrate`, `pds identity`)

**Quick Start:**
```bash
npm create pds
cd pds-worker
npm run dev
```

**Packages:**
- `@getcirrus/pds` — Core PDS implementation
- `@getcirrus/oauth-provider` — OAuth 2.1 provider for "Login with Bluesky"
- `create-pds` — Scaffolding CLI

**Key Files:**
- `packages/pds/src/index.ts` — Worker entry point
- `packages/pds/src/durable-object.ts` — AccountDurableObject implementation
- `packages/pds/src/routes/` — XRPC endpoint handlers
- `packages/oauth-provider/src/` — OAuth flow implementation

---

### atproto-oauth-client-cloudflare-workers
**Repo:** https://github.com/nDimensional/atproto-oauth-client-cloudflare-workers
**Purpose:** OAuth client for authenticating with atproto from Workers

Patched version of `@atproto/oauth-client-node` that works with Cloudflare Workers runtime.

**Changes from upstream:**
1. `request.cache: "no-cache"` → `request.headers["cache-control"]: "no-cache"`
2. `request.redirect: "error"` → `request.redirect: "follow"`

**Usage:**
```typescript
import {
  WorkersOAuthClient,
  DidCacheKV,
  HandleCacheKV,
  StateStoreKV,
  SessionStoreKV,
} from "atproto-oauth-client-cloudflare-workers"

export const client = new WorkersOAuthClient({
  didCache: new DidCacheKV(env.DID_CACHE),
  handleCache: new HandleCacheKV(env.HANDLE_CACHE),
  clientMetadata: {
    stateStore: new StateStoreKV(env.OAUTH_STATE_STORE),
    sessionStore: new SessionStoreKV(env.OAUTH_SESSION_STORE),
    // ...
  }
})
```

Requires `nodejs_compat` compatibility flag for DNS handle resolution.

---

## Official Documentation

### Cloudflare Blog: Serverless ATProto
**URL:** https://blog.cloudflare.com/serverless-atproto/

Official walkthrough of building atproto apps on Cloudflare. Covers:
- PDS architecture on Workers
- Durable Objects for state
- R2 for blob storage
- OAuth implementation

---

### AT Protocol Self-Hosting Guide
**URL:** https://atproto.com/guides/self-hosting

Official guide for running your own PDS. Covers traditional deployment (Docker on VPS).

**Requirements:**
- Public IPv4, DNS, ports 80/443
- Ubuntu 22.04 recommended
- 1GB RAM, 1 CPU, 20GB SSD

**Cloudflare alternative:** Use Cirrus instead for serverless deployment.

---

## AT Protocol Specs

- [Repository Spec](https://atproto.com/specs/repository) — MST structure, commits, sync
- [DID Spec](https://atproto.com/specs/did) — `did:plc` and `did:web` methods
- [Lexicon Spec](https://atproto.com/specs/lexicon) — Schema language
- [XRPC Spec](https://atproto.com/specs/xrpc) — HTTP-based RPC
- [Sync Spec](https://atproto.com/specs/sync) — Firehose and repo sync
- [Event Stream Spec](https://atproto.com/specs/event-stream) — WebSocket framing

---

## Related Projects

- [Bluesky PDS](https://github.com/bluesky-social/pds) — Official PDS implementation (Node.js/Docker)
- [Jetstream](https://github.com/bluesky-social/jetstream) — Lightweight JSON firehose
- [indigo](https://github.com/bluesky-social/indigo) — Go implementation (includes relay)

---

## Cloudflare Primitives

| Primitive | Use Case | Limits |
|-----------|----------|--------|
| Workers | Stateless edge compute | 10ms-30s CPU time |
| Durable Objects | Stateful coordination, SQLite | 128MB storage per DO |
| R2 | Blob storage | S3-compatible, no egress fees |
| D1 | SQLite at edge | 10GB per database |
| Vectorize | Vector search | 5M vectors per index |
| Queues | Async messaging | 100K messages/month free |
| KV | Global key-value | Eventually consistent |

For multi-agent coordination, the key insight is:
- One DO per agent (identity + state)
- Shared Relay DO for event aggregation
- R2 for shared blob storage
- D1/Vectorize for queryable indexes
- Queues for reliable async messaging
