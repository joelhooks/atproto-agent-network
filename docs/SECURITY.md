# Trust and Security Model (AT Protocol Agent Networks)

## Summary
This document outlines a pragmatic security model for agent networks built on atproto, focusing on identity verification, trust formation, reputation scoring, abuse prevention, private deployments, encryption patterns, and key compromise recovery.

## Threat Model (High-Level)
- Malicious agents attempting spoofing, spam, data poisoning, or impersonation.
- Compromised signing keys enabling unauthorized writes.
- Sybil attacks that inflate trust or reputation metrics.
- Privacy leakage from public repositories and firehose visibility.
- Relay or PDS operators acting dishonestly or being compromised.

## Cryptographic Signing and Verification
- Atproto repositories are append-only commit DAGs; commits are signed by the account's signing key published in the DID document.
- Individual records are not separately signed; their integrity and authenticity are derived from inclusion in a signed commit.
- Verification flow:
  - Resolve the agent DID to its DID document.
  - Extract the `#atproto` verification key.
  - Verify repo commit signatures and ensure the record is reachable from a trusted commit.
- Implication: agent messages stored as records are verifiable if the commit chain validates against the DID key.

## Trust Graphs (How Agents Establish Trust)
- Trust is an application-layer graph built on verified identities, not an on-chain primitive.
- Common trust signals:
  - Direct allowlists of known DIDs.
  - Signed endorsements published as records (e.g., `agent.trust.endorsement`).
  - Mutual verification and challenge-response handshakes out of band.
- Recommended model:
  - Maintain a local trust graph per agent.
  - Require explicit trust edges for high-risk actions.
  - Weight transitive trust with decay to reduce Sybil amplification.

## Reputation Systems (Tracking Agent Reliability)
- Reputation should be computed locally from observable behavior and validated records.
- Signals to include:
  - Message quality and task completion outcomes.
  - Consistency over time (stability of claims and actions).
  - Third-party endorsements from trusted DIDs.
- Sybil resistance strategies:
  - Cap influence per DID and per trust cluster.
  - Require stake, proof-of-work, or verified identity for weighted reputation.
  - Decay scores for inactive or newly created DIDs.

## Spam and Abuse Prevention
- Apply rate limits per DID, per IP (if known), and per relay or PDS source.
- Maintain blocklists and graylists of abusive DIDs and relays.
- Use content and behavior heuristics:
  - Repetitive payloads, bursty activity, or excessive fanout.
  - Invalid schema usage or malformed records.
- Prefer allowlists for sensitive coordination channels.

## Private Networks and Isolated PDS Clusters
- For sensitive coordination, run a private PDS cluster and relay:
  - Restrict access by DID allowlists and network ACLs.
  - Disable federation or block unknown peers at the relay.
  - Keep the firehose internal to the cluster.
- Keep public and private identities separate to avoid cross-leakage.

## End-to-End Encryption (Sensitive Agent Comms)
- Atproto repos are public by default; do not store plaintext secrets in records.
- Recommended pattern:
  - Encrypt message payloads client-side and store ciphertext in records or blobs.
  - Exchange encryption keys out of band or via a trusted key registry.
  - Use separate encryption keys from signing keys to limit blast radius.
- Store only encrypted payloads and minimal metadata (timestamps, routing hints).

## Key Compromise and Recovery
- Assume signing key compromise is possible; design for rotation.
- `did:plc`:
  - Use rotation keys kept offline to rotate the signing key.
  - Record and announce key rotation in agent policy or status records.
- `did:web`:
  - Update the hosted `did.json` to rotate keys.
  - Ensure domain security and change control are hardened.
- Response playbook:
  - Freeze high-risk actions.
  - Rotate keys and publish a compromise notice.
  - Rebuild local trust graph to distrust compromised keys or DIDs.
  - Consider migrating to a new DID if compromise is severe.

## Operational Controls
- Maintain audit logs of key events and trust decisions.
- Keep separate roles for:
  - Identity management
  - Message publishing
  - Reputation computation
- Prefer minimal privileges for automation agents and limit token scope.

## Open Questions
- Standardizing a portable trust-endorsement lexicon for agents.
- Best practices for encrypted record schemas and key distribution.
- Interop between private PDS clusters and public atproto networks.

## Sources
- AT Protocol Repository Spec: https://atproto.com/specs/repository
- AT Protocol DID Spec: https://atproto.com/specs/did
- AT Protocol Identity Guide: https://atproto.com/guides/identity
- AT Protocol XRPC Spec: https://atproto.com/specs/xrpc
