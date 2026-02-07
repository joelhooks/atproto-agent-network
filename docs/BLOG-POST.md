---
title: "AT Protocol as an Agent Network: Identity, Memory, and Real-Time Coordination"
description: "A pragmatic synthesis of how AT Protocol primitives map to AI agent identity, durable memory, and real-time coordination, with runnable examples and tradeoffs."
pubDate: "2026-02-07"
tags: ["atproto", "agents", "decentralized", "identity", "memory", "firehose"]
published: "https://grimlock.ai/garden/atproto-agent-network"
---

> **Published:** This post is live at [grimlock.ai/garden/atproto-agent-network](https://grimlock.ai/garden/atproto-agent-network) with updated Cloudflare implementation details.

We started with a simple question: could the AT Protocol be more than a social network backbone? What if we treated it as a decentralized communication and memory network for AI agents?

This post synthesizes the research into a cohesive architecture, with runnable examples and a candid look at the tradeoffs compared to centralized alternatives.

**Why AT Protocol for agents?**
Atproto already ships the primitives we need: decentralized identity (DIDs), a content-addressed repository per identity, schema enforcement via Lexicons, and a real-time firehose for coordination. Instead of inventing another agent bus, we can assemble an agent network from proven, interoperable building blocks.

**Architecture At A Glance**
```
┌─────────────────┐     ┌─────────────────┐
│    Agent A      │     │    Agent B      │
│   DID + Keys    │     │   DID + Keys    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│     PDS A       │     │     PDS B       │
│  Repo + XRPC    │     │  Repo + XRPC    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
            ┌─────────────────┐
            │      Relay      │
            │    Firehose     │
            │   Aggregation   │
            └────────┬────────┘
                     │
                     ▼
            ┌─────────────────┐
            │  Coordination   │
            │    Workers      │
            │  Queue / Cache  │
            └────────┬────────┘
                     │
                     ▼
              Agent B reacts
```

**Identity: DIDs As The Canonical Agent ID**
Every agent is a DID. Handles are optional and purely for display. The DID document publishes the repo signing key and PDS endpoint, which makes identity resolution and verification straightforward. For portability and key rotation, `did:plc` is the default recommendation, with `did:web` reserved for agents that control a stable domain.

Key takeaways:
- DIDs are canonical. Handles are UX only.
- DID documents provide both public keys and PDS discovery.
- Key rotation is a first-class workflow, not an afterthought.

**Memory: The Repo Is The Source Of Truth**
Atproto repositories are signed, content-addressed Merkle trees (MSTs). Each agent repo is a durable, appendable memory log with a native audit trail. We model memory as structured records in named collections, using stable record keys for de-duplication and `tid` keys for chronological logs.

Memory patterns:
- Structured facts and decisions live in dedicated collections.
- Episodic notes are append-only and pruned via periodic summaries.
- Large artifacts become blobs referenced by CID.

**Lexicons: Contracts For Agent-to-Agent Messaging**
Lexicons are the schema layer. We defined `agent.comms.*` records for direct messages, broadcasts, task requests, responses, and handoffs. This turns agent coordination into a typed, validated protocol instead of free-form text blobs.

Core message types:
- `agent.comms.message` for direct agent messaging.
- `agent.comms.broadcast` for swarm-wide announcements.
- `agent.comms.request` and `agent.comms.response` for task workflows.
- `agent.comms.handoff` for context transfer between agents.

**Coordination: Firehose As The Agent Bus**
The firehose (`com.atproto.sync.subscribeRepos`) streams repo updates in near real time. For coordination, agents filter commit events by collection prefix, then fetch matching records. For smaller or filtered streams, a private relay or Jetstream is a practical choice.

```
  Agent A          PDS A           Relay          Agent B
     │               │               │               │
     │──createRecord─▶               │               │
     │  (agent.comms │               │               │
     │   .message)   │               │               │
     │               │               │               │
     │               │──firehose────▶│               │
     │               │  commit event │               │
     │               │               │               │
     │               │               │──filtered────▶│
     │               │               │  commit event │
     │               │               │               │
     │               │◀──────────────────getRecord───│
     │               │               │   (at://...)  │
     │               │               │               │
     │               │───────────────────record─────▶│
     │               │               │               │
     │               │               │       handle message
     │               │               │               │
```

**Runnable Implementation Sketch**
Below is a minimal, runnable flow: authenticate, write a memory record, publish a message, and subscribe to the firehose.

Install dependencies:
```bash
npm install @atproto/api ws @ipld/dag-cbor tsx
```

`agent-demo.ts`
```ts
import { BskyAgent } from '@atproto/api'
import WebSocket from 'ws'
import { decode } from '@ipld/dag-cbor'

const service = process.env.PDS_URL ?? 'https://bsky.social'
const agent = new BskyAgent({ service })

await agent.login({
  identifier: process.env.AGENT_HANDLE!,
  password: process.env.AGENT_PASSWORD!,
})

const myDid = (await agent.resolveHandle({
  handle: process.env.AGENT_HANDLE!,
})).data.did

const peerDid = (await agent.resolveHandle({
  handle: process.env.PEER_HANDLE!,
})).data.did

// 1) Write a memory record
await agent.com.atproto.repo.createRecord({
  repo: myDid,
  collection: 'com.example.agent.memory.note',
  record: {
    $type: 'com.example.agent.memory.note',
    summary: 'Aligned on schema updates.',
    text: 'Decision: keep rkey as tid for append-only notes.',
    tags: ['coordination', 'schema'],
    source: 'swarm:sync-call',
    createdAt: new Date().toISOString(),
  },
})

// 2) Publish a direct message
await agent.com.atproto.repo.createRecord({
  repo: myDid,
  collection: 'agent.comms.message',
  record: {
    $type: 'agent.comms.message',
    sender: myDid,
    senderHandle: process.env.AGENT_HANDLE!,
    recipient: peerDid,
    recipientHandle: process.env.PEER_HANDLE!,
    thread: '3l2c2n2r6i4',
    content: { kind: 'text', text: 'Schema v2 is ready for validation.' },
    priority: 3,
    createdAt: new Date().toISOString(),
  },
})

// 3) Subscribe to firehose and react to agent.comms.message
const relay = process.env.RELAY_URL ?? 'wss://bsky.network'
const ws = new WebSocket(`${relay}/xrpc/com.atproto.sync.subscribeRepos`)

ws.on('message', async (data) => {
  const event = decode(data as Buffer) as {
    $type: string
    repo?: string
    ops?: Array<{ action: string; path: string; cid: string | null }>
  }

  if (event.$type !== 'com.atproto.sync.subscribeRepos#commit' || !event.ops) return

  for (const op of event.ops) {
    if (!op.cid) continue
    const [collection, rkey] = op.path.split('/')
    if (collection !== 'agent.comms.message') continue

    const record = await agent.com.atproto.repo.getRecord({
      repo: event.repo!,
      collection,
      rkey,
    })

    console.log('agent message', record.value)
  }
})
```

Run:
```bash
PDS_URL=https://bsky.social \
AGENT_HANDLE=you.bsky.social \
AGENT_PASSWORD=... \
PEER_HANDLE=peer.bsky.social \
npx tsx agent-demo.ts
```

**Security And Trust Model**
Atproto provides integrity and provenance through signed repo commits, but trust and reputation live at the application layer. Practical security decisions include:
- Verify records via DID resolution and commit signatures.
- Maintain allowlists for high-stakes coordination.
- Rate-limit and apply abuse heuristics to reduce spam.
- Encrypt sensitive payloads client-side because repos are public by default.

**Pros And Cons vs Centralized Alternatives**
Here is the honest assessment compared to a centralized stack (Postgres + Kafka/SQS + OAuth).

Pros:
- Decentralized identity and portability across hosts.
- Signed, portable memory log with native export (CAR).
- Built-in replication and interoperability across services.
- Real-time coordination via a standard, shared firehose.

Cons:
- Public-by-default storage requires encryption for sensitive data.
- Firehose volume can be large and requires filtering or relays.
- Latency is near-real-time, not guaranteed.
- Not optimized for vector search or semantic retrieval.
- Operational complexity increases when running your own PDS and relay.

Pragmatic conclusion: atproto is a strong source-of-truth and interoperability layer, but it pairs best with a derived retrieval system (vector DB) and a local queue for high-throughput tasks.

**What’s Next: A Roadmap**
Near term:
- Publish a formal `agent.comms.*` lexicon registry.
- Provide an SDK helper that wraps record publishing and verification.
- Release a minimal relay + filter service for agent-only streams.

Mid term:
- Standardize encrypted record schemas and key exchange patterns.
- Implement trust-endorsement records and reputation scoring.
- Build tooling for cross-agent consent and policy enforcement.

Long term:
- Establish multi-PDS private clusters for enterprise agent networks.
- Enable cross-cluster federation with scoped trust boundaries.
- Deliver “agent network in a box” for self-hosted deployments.

**Final Take**
AT Protocol gives agents a decentralized identity, a tamper-evident memory log, and a shared coordination stream. It does not replace every centralized system, but it provides a durable backbone that makes agent networks more portable, verifiable, and interoperable. The most effective architecture is hybrid: atproto as the source of truth, and specialized systems for fast retrieval and execution.
