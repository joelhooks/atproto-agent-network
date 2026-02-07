# Serverless Statusphere: building serverless ATProto applications on Cloudflare

**Source:** https://blog.cloudflare.com/serverless-statusphere/
**Date:** 2025-07-24
**Author:** Inanna Malick

Social media users are tired of losing their identity and data every time a platform shuts down or pivots. In the ATProto ecosystem — short for Authenticated Transfer Protocol — users own their data and identities. Everything they publish becomes part of a global, cryptographically signed shared social web. Bluesky is the first big example, but a new wave of decentralized social networks is just beginning. In this post I'll show you how to get started, by building and deploying a fully serverless ATProto application on Cloudflare's Developer Platform.

**Why serverless?** The overhead of managing VMs, scaling databases, maintaining CI pipelines, distributing data across availability zones, and securing APIs against DDoS attacks pulls focus away from actually building.

That's where Cloudflare comes in. You can take advantage of our Developer Platform to build applications that run on our global network:

- **Workers** deploy code globally in milliseconds
- **KV** provides fast, globally distributed caching
- **D1** offers a distributed relational database
- **Durable Objects** manage WebSockets and handle real-time coordination

Best of all, everything you need to build your serverless ATProto application is available on our free tier.

**Repo:** https://github.com/cloudflare/statusphere-workers

## The ATProto ecosystem: a quick introduction

Users interact with apps, which write updates to their personal repositories. Those updates trigger change events, which are published to a relay and broadcast through the global event stream. Any app can subscribe to these events — even if it didn't publish the original update — because in ATProto, repos, relays, and apps are all independent components, which can be (and are) run by different operators.

### Identity

User identity starts with handles — human-readable names like `alice.example.com`. Each handle must be a valid domain name, allowing the protocol to leverage DNS to provide a global view of who owns what account. Handles map to a user's Decentralized Identifier (DID), which contains the location of the user's Personal Data Server (PDS).

### Authentication

A user's PDS manages their keys and repos. It handles authentication and provides an authoritative view of their data via their repo.

What's different here — and easy to miss — is how little any part of this stack relies on trust in a single service. DID resolution is verifiable. The PDS is user-selected. The client app is just an interface.

When we publish or fetch data, it's signed and self-validating. That means any other app can consume or build on top of it without asking permission, and without trusting our backend.

## Statusphere: The Application

Statusphere is a tiny but complete demo app built by the ATProto team. It's the simplest possible social media app: users post single-emoji status updates. Because it's so minimal, Statusphere is a perfect starting point for learning how decentralized ATProto apps work.

### Statusphere schema

In ATProto, all repository data is typed using Lexicons — a shared schema language similar to JSON-Schema:

```json
{
  "type": "record",
  "key": "tid",
  "record": {
    "type": "object",
    "required": ["status", "createdAt"],
    "properties": {
      "status": { "type": "string", "maxGraphemes": 1 },
      "createdAt": { "type": "string", "format": "datetime" }
    }
  }
}
```

Lexicons are strongly typed, which allows for easy interoperability between apps.

## How it's built

### Language choice

ATProto's core libraries are written in TypeScript, and Cloudflare Workers provide first-class TypeScript support. However, the ATProto TypeScript libraries assume a backend or browser context. The ATProto library's use of the 'error' redirect handling mode isn't compatible with the edge runtime.

Cloudflare also supports Rust in Workers via WASM cross-compilation. The ATProto Rust crates and codegen tooling make strong use of Rust's type system. Rust's WASM ecosystem is solid, so I was able to get a working prototype running quickly by adapting an existing Rust implementation of Statusphere — originally written by Bailey Townsend.

If you're building ATProto apps on Cloudflare Workers, I'd suggest contributing to the TypeScript libraries to better support serverless runtimes.

### Resolving the user's handle

To interact with a user's data, we start by resolving their handle to a DID using the record registered at the `_atproto` subdomain. For example, `inanna.recursion.wtf` → `_atproto.inanna.recursion.wtf` → `did:plc:p2sm7vlwgcbbdjpfy6qajd4g`.

We then resolve the DID to its corresponding DID Document, which contains identity metadata including the location of the user's Personal Data Server. Depending on the DID method, this resolution is handled directly via DNS (for `did:web` identifiers) or via the Public Ledger of Credentials for `did:plc` identifiers.

Since these values don't change frequently, we cache them using **Cloudflare KV** — it's perfect for cases like this.

### Fetching status and profile data

Using the DID stored in the session cookie, we restore the user's OAuth session and spin up an authenticated agent:

```rust
let agent = state.oauth.restore_session(&did).await?;
let current_status = agent.current_status().await?;
let profile = agent.bsky_profile().await?;
```

### Publishing updates

When a user posts a new emoji status, we create a new record in their personal repo:

```rust
let uri = agent.create_status(form.status.clone()).await?.uri;
```

We then write the status update into D1, so it can immediately be reflected in the UI.

### Using Durable Objects to broadcast updates

Every active homepage maintains a WebSocket connection to a Durable Object, which acts as a lightweight real-time message broker. When idle, the Durable Object hibernates, saving resources while keeping the WebSocket connections alive.

```rust
state.durable_object.broadcast(status).await?;

// Inside the Durable Object:
for ws in self.state.get_websockets() {
    ws.send(&status);
}
```

### Listening for live changes: The challenge

Publishing updates inside our own app is easy, but in the ATProto ecosystem, other applications can publish status updates for users. If we want Statusphere to be fully integrated, we need to pick up those events too.

Listening for live event updates requires a persistent WebSocket connection to the ATProto Jetstream service. Traditional server-based apps can keep WebSocket client sockets open indefinitely, but serverless platforms can't — workers aren't allowed to run forever.

### The solution: Cloudflare worker Cron Triggers

To solve this, we moved the listening logic into a Cron Trigger — instead of keeping a live socket open, we used this feature to read updates in small batches using a recurring scheduled job.

```rust
let ws = WebSocket::connect(
    "wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=xyz.statusphere.status&cursor={cursor}"
).await?;
```

We store a cursor — a microsecond timestamp marking the last message we received — in the Durable Object's persistent storage. As soon as we process an event newer than our start time, we close the WebSocket connection.

**The tradeoff:** Updates can lag by up to a minute, but the system stays fully serverless. This is a great fit for early-stage apps and prototypes.

### Optional upgrade: real-time event listener

If you want real time updates, you can deploy a lightweight listener process that maintains a live WebSocket connection to Jetstream. Instead of polling once a minute, this process listens for new events and pushes updates to our Cloudflare Worker as soon as they arrive.

The result still isn't a traditional server:
- No public exposure to the web
- No open HTTP ports
- No persistent database

It's just a single-purpose, stateless listener.

## Looking ahead

Future improvements to Durable Objects — like adding support for hibernating active WebSocket clients — could remove the need for these workarounds entirely.

## Build your own ATProto app

This is a full-featured atproto app running entirely on Cloudflare with zero servers and minimal ops overhead. Workers run your code within 50 ms of most users, KV and D1 keep your data available, and Durable Objects handle WebSocket fan-out and live coordination.

Use the Deploy to Cloudflare Button to clone the repo and set up your serverless environment.
