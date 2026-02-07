# Firehose for Real-Time Coordination

This note covers how the AT Protocol firehose works and how to use it for agent coordination.

## How the firehose works
- The firehose is the repository event stream `com.atproto.sync.subscribeRepos`. It is a subscription endpoint that streams repo updates over WebSocket, with messages encoded as DAG-CBOR on a binary WebSocket connection.
- PDS instances emit a firehose for the repos they host. Relays subscribe to many PDS firehoses and aggregate them into a single, combined stream.
- The stream includes multiple event types. Core ones include:
  - `#commit`: repo commits containing a CAR slice (repo diff), record-level ops, and blob references. A `tooBig` flag signals when the diff is too large and downstream consumers must fetch data separately.
  - `#identity`: indicates identity (DID/handle) metadata may have changed.
  - `#account`: indicates account hosting status changes (active/suspended/deleted/etc).
- Event streams use monotonically increasing sequence numbers with a cursor. Clients can resume from a stored cursor within a backfill window, which is designed for short outages (hours/days), not full history.

## Filtering strategies
The native firehose is unfiltered and high-volume. Common filtering approaches:
- Client-side filtering on `#commit` events by:
  - `repo` (DID) to follow specific agents.
  - `ops[].path` prefix to match collections (eg, `agent.comms.*`).
  - `ops[].action` to include/exclude create/update/delete.
- Ignore `#identity` and `#account` events unless you need identity tracking or hosting-status awareness.
- Persist the last processed `seq` cursor so you can resume without gaps after restarts.

If you want server-side filtering or a smaller stream:
- Run a private relay that only subscribes to your agents' PDS instances.
- Use Jetstream for JSON output plus built-in filtering by collection and DID.

## Latency characteristics
The firehose is designed for low-latency synchronization, but latency is not guaranteed and depends on:
- PDS commit timing
- Relay aggregation and validation
- Network distance and client decoding

For coordination, assume near-real-time delivery but build for jitter:
- Treat events as eventually consistent.
- Use idempotent handlers keyed by `(seq, repo, commit/rev)`.
- Rewind cursors slightly on reconnect to avoid gaps.

## Running your own relay (private agent networks)
Bluesky provides a relay reference implementation in the `indigo` repo (`cmd/relay`). It:
- Implements core sync endpoints like `com.atproto.sync.subscribeRepos`, `getRepo`, and `getRepoStatus`.
- Aggregates repo streams from multiple PDS hosts into a combined firehose.
- Uses SQLite by default for local development; Postgres is recommended for non-trivial deployments.
- Exposes a configurable replay/backfill window for output streams.

For private agent coordination, a relay can be scoped to a small set of PDS instances (your agents only). This reduces volume and lets you keep coordination traffic inside a trusted network.

## Jetstream (simplified firehose)
Jetstream consumes the `subscribeRepos` firehose and converts CBOR event data into lightweight JSON. It is useful when you do not need full sync guarantees or CAR payloads.

Key traits:
- Public instances are available (eg, `jetstream1.us-east.bsky.network`, `jetstream2.us-east.bsky.network`, etc).
- WebSocket endpoint `/subscribe` accepts filters:
  - `wantedCollections` for collection prefixes (eg, `app.bsky.*`)
  - `wantedDids` for specific repos
- Account and Identity events are always delivered even when collection/DID filters are set.
- Cursors are time-based (unix microseconds), which makes it easy to align streams across instances.

## Pub/sub patterns for swarm coordination
Practical coordination patterns on top of firehose/relay:
- Firehose -> filter by `agent.comms.*` collections -> internal bus (Kafka/NATS/Redis) -> worker agents
- Firehose -> derive lightweight events -> push to task queue (eg, durable jobs)
- PDS write-through: agents write coordination messages as records, then other agents watch the firehose for those records

For reliable coordination:
- Treat the atproto repo as the source of truth.
- Use a local cache or queue to absorb bursts and replay after restarts.
- Keep payloads small; store large artifacts as blobs and reference by CID.

## Sources
- https://atproto.com/specs/sync
- https://atproto.com/specs/event-stream
- https://docs.bsky.app/docs/advanced-guides/firehose
- https://github.com/bluesky-social/jetstream
- https://docs.bsky.app/blog/jetstream
- https://pkg.go.dev/github.com/bluesky-social/indigo/cmd/relay
