# Agent Memory on AT Protocol Repos

## Goal
Use atproto repositories as durable, verifiable, portable memory for agents, while keeping retrieval fast and privacy-sensitive data protected.

## Repository Grounding
- Records live in an account repo as key/value entries under `<collection>/<record-key>` paths.
- Repos are content-addressed and commit-signed; deletions and updates are supported, and repos can be exported as CAR files for backup or migration.
- Records should be compact; large payloads should be stored as blobs and referenced from records.

## Record Types (Structured vs Unstructured)
Use a dedicated NSID namespace (replace `com.example` with your domain).

### Structured Memory Collections
`com.example.agent.memory.fact`
A single factual claim.
Fields: `subject`, `predicate`, `object`, `confidence`, `source`, `validFrom`, `validTo`, `tags`, `createdAt`, `updatedAt`.
Rkey: `any` using a stable hash of `subject|predicate|object` to enable de-dup and updates.

`com.example.agent.memory.decision`
A decision with rationale and status.
Fields: `decision`, `context`, `options`, `rationale`, `status`, `owner`, `createdAt`, `updatedAt`, `refs`.
Rkey: `tid` for chronological audit trail.

`com.example.agent.memory.learning`
A lesson or heuristic.
Fields: `statement`, `context`, `evidence`, `confidence`, `createdAt`, `updatedAt`.
Rkey: `tid`.

### Unstructured Memory Collections
`com.example.agent.memory.episode`
A narrative event or interaction.
Fields: `text`, `summary`, `participants`, `tags`, `source`, `happenedAt`, `createdAt`, `refs`.
Rkey: `tid`.

`com.example.agent.memory.note`
Free-form notes, logs, transcripts, or artifacts.
Fields: `summary`, `text` (short), `blob` (CID ref), `tags`, `source`, `createdAt`.
Rkey: `tid`.

### Supporting Collections (Optional)
`com.example.agent.memory.profile`
Agent profile / preferences / defaults.
Fields: `displayName`, `description`, `defaultPrivacy`, `policies`, `createdAt`, `updatedAt`.
Rkey: `literal:self`.

`com.example.agent.memory.summary`
Periodic rollups used for pruning.
Fields: `scope`, `summary`, `covers`, `createdAt`.
Rkey: `tid`.

## Querying and Retrieval
- Read by collection with `com.atproto.repo.listRecords` (paged with cursors).
- Fetch a single record with `com.atproto.repo.getRecord` when you have a specific `rkey`.
- Write new memories with `com.atproto.repo.createRecord` (use `tid` for append-only logs).
- Update or overwrite stable records with `com.atproto.repo.putRecord`.
- Remove old or sensitive records with `com.atproto.repo.deleteRecord`.
- For full rebuilds, use `com.atproto.sync.getRepo` to export the entire repo and re-index locally.

Retrieval strategy:
- Use collection scans to hydrate a local index (keywords or embeddings).
- Keep a lightweight "last seen cursor" per collection to ingest incrementally.

## Repo Size and Pruning
- Repos are designed to scale to many records; practical limits are driven by PDS policy and blob size restrictions.
- Use rollup summaries (`memory.summary`) to replace large sets of old episodic records.
- Apply retention policies per collection (eg, keep all `decision` records, prune `episode` after 90 days).
- Prefer replacing large notes with short summaries + blob ref; delete old blobs when safe.

## Cross-Agent Memory Sharing
- Public repos can be read by other agents via `listRecords` or full `getRepo` export.
- Discover the peer PDS via the agent's DID document, then query that PDS directly.
- Expose only specific collections for sharing, and keep sensitive data in private or encrypted collections.

## Private vs Public Memories (Encryption Options)
- Repo content is public in atproto repositories, so sensitive memory must be protected.
- Client-side encryption: store ciphertext in records or blobs and share keys out-of-band.
- Private PDS or access-controlled proxy: only expose decrypted views to trusted peers.
- Store secrets outside atproto and keep only pointers or hashes in the repo.

## Comparison to Hivemind (Qdrant + Embeddings)
Atproto repo strengths:
- Canonical, signed, portable memory log tied to DID identity.
- Built-in replication and export (CAR), good for provenance and audit.
- Easy cross-agent sharing for public memory.

Qdrant strengths:
- Fast semantic retrieval, filtering, and ranking.
- Better suited for large-scale vector search and hybrid queries.

Recommended hybrid:
- Treat atproto repo as the source of truth.
- Maintain a derived vector index (Qdrant) for retrieval.
- Rebuild or incrementally update the index from `listRecords` or `getRepo` exports.

## Sources
- https://atproto.com/specs/repository
- https://atproto.com/specs/record-key
- https://atproto.com/specs/xrpc
- https://docs.bsky.app/docs/api/com-atproto-repo-list-records
- https://docs.bsky.app/docs/api/com-atproto-repo-get-record
- https://docs.bsky.app/docs/api/com-atproto-repo-create-record
- https://docs.bsky.app/docs/api/com-atproto-repo-put-record
- https://docs.bsky.app/docs/api/com-atproto-repo-delete-record
- https://docs.bsky.app/blog/repo-export
