# AT Protocol Concepts -> Agent Network Mapping

This maps core AT Protocol primitives to potential agent network building blocks.

## DIDs (Identity)
Atproto: Uses W3C DIDs as stable, long-term account identifiers and currently supports `did:web` and `did:plc`. DID Documents publish signing keys and the account's PDS service endpoint for discovery. In atproto, `did:web` is tied to DNS control, while `did:plc` is a dedicated method for portability.

Agent mapping: Assign each agent a DID. The DID Document becomes the discovery + verification anchor (public keys + PDS location). Use `did:web` for self-hosted agents with stable domain control; use `did:plc` when you want portability without relying on domain ownership.

## Personal Data Servers (PDS)
Atproto: The PDS is the account's trusted agent in the network. It hosts the repository, routes client requests, and can proxy calls to other services. In the architecture, PDS is the "home in the cloud" for user data and identity.

Self-hosting options: A self-hosted PDS can use `did:web` if the operator controls the domain; otherwise `did:plc` works for hosted scenarios.

Agent mapping: The PDS becomes the agent's home base and persistence layer. Self-host for autonomy and control, or use a hosted PDS for convenience. The PDS can also proxy RPC calls for agent workflows.

## Repositories
Atproto: Each account has a repository (repo) that stores records. Repos are content-addressed Merkle trees (MST) with signed commits. Records are stored as key/value entries under `<collection>/<record-key>` paths, and large blobs are referenced by CID rather than embedded. Repos can be exported as CAR files for backup and migration.

Agent mapping: Treat the repo as the agent's durable memory store. Signed commits provide an audit trail for memory changes. CAR exports enable backup, replication, or migration between hosting providers.

## Lexicons
Atproto: Lexicon is the schema system for record types and API endpoints. Primary Lexicon types include `record`, `query`, `procedure`, and `subscription` (event streams). Lexicons themselves are published as records (`com.atproto.lexicon.schema`) in repositories.

Agent mapping: Define agent-to-agent message types, task schemas, and memory record formats as Lexicons. This gives structured, verifiable communication contracts and enables cross-agent interoperability.

## XRPC
Atproto: XRPC is the HTTP RPC layer. Endpoints live at `/xrpc/<NSID>`, where the NSID maps to a Lexicon definition. Queries use HTTP GET and procedures use HTTP POST, with schemas defined by Lexicons.

Agent mapping: Use XRPC as the standard RPC layer between agents and their PDS. Queries read memory/state; procedures write records, trigger tasks, or invoke agent actions.

## Firehose / Relay
Atproto: The firehose (`com.atproto.sync.subscribeRepos`) is a real-time event stream of repo updates. Relays subscribe to many PDS instances and aggregate them into a unified firehose. Event streams are subscription endpoints over WebSockets with sequence numbers and backfill support.

Agent mapping: Treat the firehose as the coordination bus. Agents subscribe to updates for memory changes, task announcements, or status signals. Private relays can scope coordination to a team or cluster; public relays enable global discovery.
