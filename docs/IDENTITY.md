# Agent Identity Architecture (AT Protocol)

## Summary
Agents can have decentralized identities on atproto by using DIDs as the primary, stable identifier and optionally attaching a handle for human-friendly display. Atproto supports two DID methods: `did:plc` (recommended for portability and recoverability) and `did:web` (recommended only when an agent controls a stable domain and is comfortable with domain-tied identity).

## Identity Primitives
- DID: The primary, persistent account identifier. Use DIDs for all protocol-level references.
- Handle: Human-friendly hostname that resolves to a DID. Optional for agents.
- DID document: Publishes the signing key and service endpoints (PDS) for the DID.
- PDS: The personal data server hosting the agent repo.

## DID Method Options

### `did:plc` (recommended default)
- Self-authenticating DID method designed for atproto with key rotation and recovery.
- Identity state is updated by signed operations recorded in the PLC directory log.
- Good for agents that may move between PDS hosts or need robust key rotation.

### `did:web`
- DID document is hosted on the agent-controlled domain under `/.well-known/did.json`.
- In atproto, only hostname-level `did:web` DIDs are supported (no path-based DIDs).
- Strongly tied to domain control; loss of the domain means loss of identity.

## Registration and Automation

### `did:plc` creation flow (automatable)
1. Generate a signing key for the DID document and one or more rotation keys.
2. Build a PLC operation with `rotationKeys`, `verificationMethods`, `alsoKnownAs`, `services`, and `prev: null`.
3. Sign the operation and submit it to the PLC directory API.
4. Store rotation keys offline (or in KMS/HSM) for future updates.

### `did:web` creation flow (automatable)
1. Provision a domain and TLS certificate.
2. Publish `did.json` at `https://<domain>/.well-known/did.json`.
3. Update `did.json` when rotating keys or changing service endpoints.

## Handle Strategy
- Handles are DNS hostnames that resolve to a DID via DNS TXT (`_atproto.<handle>`) or HTTPS (`/.well-known/atproto-did`).
- Always verify handle and DID bidirectionally: resolve handle to DID, then confirm the DID document includes the handle.
- Use DIDs as canonical identity in protocols. Handles are display-only and can change.
- Agent options:
  - No handle (pure machine identity).
  - Subdomain handle (agent1.example.com) for organizations with a domain.
  - Default handle (agentname.bsky.social) for quick start.

## Key Management
- Signing key: The public key in the DID document under `verificationMethod` (with `#atproto`). Used to sign repo commits and agent messages.
- Rotation keys (PLC only): Authorize updates to the DID state and key rotation.
- Recommendations:
  - Store rotation keys offline or in KMS/HSM.
  - Use separate keys per agent identity (avoid shared keys).
  - Rotate signing keys on a regular cadence and update the DID document or PLC operation.
  - Log all key events for auditability.

## Identity Verification Between Agents
1. Resolve the peer DID:
   - `did:plc`: resolve via PLC directory and verify operation log.
   - `did:web`: fetch `did.json` over HTTPS and verify the DID matches the document `id`.
2. If a handle is presented, resolve it to a DID and verify the handle appears in `alsoKnownAs` in the DID document.
3. Use the DID document `#atproto` key to verify signed records or messages from the agent.
4. Optionally maintain an allow-list of trusted DIDs or require out-of-band verification for high-stakes interactions.

## Legal and ToS Considerations (Bluesky-hosted PDS)
- Bluesky Developer Guidelines prohibit automated bulk interactions (follows, likes, replies, messages) and account generation tools. Agent bots must be rate-limited and avoid behavior that resembles spam.
- Bluesky Community Guidelines prohibit spam and manipulative behavior. Agent interactions should be transparent and non-deceptive.
- If using the Bluesky-hosted PDS (`bsky.social`), compliance with Bluesky Terms and policies applies.

## Existing Bot Account Precedents on Bluesky
- `bskychan.bsky.social` (bot that replies occasionally).
- arXiv category bots such as `physicsclassph-bot.bsky.social`.
- `botitibot.bsky.social` (testing bot).

## Recommendation
- Default to `did:plc` for agents that need portability and recoverable key rotation.
- Use `did:web` only for agents with stable domain control and self-hosted identity.
- Treat handles as UX-only; use DIDs as the canonical identity for agent-to-agent protocols.

## Sources
- AT Protocol DID Spec: https://atproto.com/specs/did
- AT Protocol Handle Spec: https://atproto.com/specs/handle
- AT Protocol Identity Guide: https://atproto.com/guides/identity
- DID PLC Spec: https://web.plc.directory/spec/v0.1/did-plc
- DID Web Method Spec: https://w3c-ccg.github.io/did-method-web/
- Bluesky Developer Guidelines: https://docs.bsky.app/docs/support/developer-guidelines
- Bluesky Community Guidelines: https://bsky.social/about/support/community-guidelines
- Example bot profiles:
  - https://bsky.app/profile/bskychan.bsky.social
  - https://bsky.app/profile/physicsclassph-bot.bsky.social
  - https://bsky.app/profile/botitibot.bsky.social
