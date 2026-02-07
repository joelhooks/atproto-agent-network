# AT Protocol Agent Network Research

## Goal
Explore using AT Protocol as a decentralized communication and memory network for AI agents like OpenClaw/Grimlock.

## Why This Matters
Currently, agent memory (hivemind) and coordination (swarm) are centralized. AT Protocol offers:
- **Decentralized identity** via DIDs - agents own their identity
- **Portable data** - agent memories aren't locked to one service
- **Cryptographic verification** - agents can verify each other's messages
- **Federated infrastructure** - agents can run their own PDS or use existing ones
- **Open protocol** - anyone can build compatible agents

## Key Questions
1. Can AI agents have legitimate DIDs on the atproto network?
2. How would agent memory map to atproto repos and records?
3. What custom lexicons would we need for agent communication?
4. Is the firehose fast enough for real-time agent coordination?
5. How do agents establish trust with each other?

## AT Protocol Reference

### Source Code
Cloned to: `~/.openclaw-autopsy/bluesky-social/atproto`

### Key Packages (npm)
- `@atproto/api` - Client library for interacting with PDS
- `@atproto/crypto` - Cryptographic signing and key management  
- `@atproto/identity` - DID and handle resolution
- `@atproto/lexicon` - Schema definition language
- `@atproto/repo` - Data storage structure (Merkle Search Tree)
- `@atproto/syntax` - String parsers for identifiers
- `@atproto/xrpc` - HTTP API helpers

### Lexicon Namespaces
- `com.atproto.*` - Core protocol operations
- `app.bsky.*` - Bluesky social app specific
- `chat.bsky.*` - Direct messaging
- `tools.ozone.*` - Moderation tools

### Key Specs (atproto.com)
- [Overview and Guides](https://atproto.com/guides/overview)
- [Protocol Specifications](https://atproto.com/specs/atp)
- [Lexicon Spec](https://atproto.com/specs/lexicon)
- [DID Spec](https://atproto.com/specs/did)
- [Repository Spec](https://atproto.com/specs/repository)

### Related Repos
- [bluesky-social/pds](https://github.com/bluesky-social/pds) - Self-hosting PDS
- [bluesky-social/indigo](https://github.com/bluesky-social/indigo) - Go implementation
- [bluesky-social/jetstream](https://github.com/bluesky-social/jetstream) - Simplified firehose

## Current Agent Architecture (for comparison)

### OpenClaw/Grimlock
- **Identity**: Configured in gateway, not portable
- **Memory**: Hivemind (Qdrant vectors + semantic search)
- **Communication**: SwarmMail (file-based locking + messaging)
- **Coordination**: Hive cells (task management)

### What atproto could replace/augment
- Identity → DIDs (portable, self-sovereign)
- Memory → Personal Data Repo (signed, portable)
- Communication → Custom lexicons (structured, verifiable)
- Coordination → Firehose subscriptions (real-time, decentralized)

## Research Output
Each story should produce a .md file with findings, code examples, and architectural proposals. Final output is a blog post for grimlock.ai.

## Commands for Research
```bash
# Explore atproto source
cd ~/.openclaw-autopsy/bluesky-social/atproto

# Search for patterns
rg "DID" packages/identity/
rg "lexicon" packages/lexicon/

# Read specific files
cat packages/api/README.md
cat lexicons/com/atproto/repo/createRecord.json
```
