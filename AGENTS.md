# AGENTS.md — ⚡ AT Protocol Agent Network

This is an autonomous development workspace. Agents build agents.

## First Session

1. Read this file completely
2. Read `PI-POC.md` — the implementation plan with security gates
3. Read `docs/O11Y.md` — observability architecture
4. Check `.agents/skills/` for available skills
5. Check the hive for current work: `hive_cells --status open`

## What We're Building

A decentralized agent communication and memory network on Cloudflare, using Pi as the agent runtime.

**Core properties:**
- **Private by default** — All memories encrypted (envelope encryption, X25519)
- **Pi runtime** — Tool-calling, streaming, self-extending agents
- **Cloudflare native** — Durable Objects, D1, R2, Vectorize, Queues
- **AT Protocol inspired** — DIDs, lexicons, firehose patterns

## Phase Overview

| Phase | Focus | Security Gate |
|-------|-------|---------------|
| 1 | Encrypted single agent | All memories encrypted, no plaintext in D1 |
| 2 | Semantic memory | Search on embeddings, decrypt only on retrieval |
| 3 | Multi-agent coordination | E2E encryption between agents |
| 4 | Selective sharing | Private by default, public requires explicit action |

## Project Structure

```
atproto-agent-network/
├── AGENTS.md            # You are here
├── PI-POC.md            # Implementation plan with security gates
├── README.md            # Project overview
├── REFERENCES.md        # Key resources (Pi, Cirrus, Cloudflare blogs)
├── docs/
│   ├── O11Y.md          # Observability architecture
│   ├── CONCEPTS.md      # AT Protocol concepts
│   ├── IDENTITY.md      # DID patterns
│   ├── MEMORY.md        # Repository/memory design
│   ├── LEXICONS.md      # Message schemas
│   ├── FIREHOSE.md      # Real-time coordination
│   ├── SECURITY.md      # Encryption patterns
│   └── IMPLEMENTATION.md # Code examples
├── .agents/
│   └── skills/          # Skills for autonomous development
└── src/                 # Implementation (to be created)
    ├── agent/           # Pi agent wrapper for Cloudflare DO
    ├── crypto/          # Encryption utilities
    ├── memory/          # D1 + R2 encrypted storage
    ├── comms/           # Inter-agent messaging
    ├── relay/           # Event coordination
    └── cli/             # zap observability CLI
```

## Skills Available

Skills live in `.agents/skills/`. Load a skill when working on its domain:

| Skill | When to Use |
|-------|-------------|
| `cloudflare-do` | Durable Objects, WebSockets, hibernation patterns |
| `pi-agent` | Pi runtime integration, tools, extensions, session trees |
| `envelope-encryption` | X25519, DEK management, envelope encryption |
| `d1-patterns` | D1 schema, encrypted records, queries |
| `vectorize-search` | Semantic search, embeddings, Vectorize API |
| `zap-cli` | Observability CLI, event logging, decision traces |

## HITL Gates

Human-in-the-loop checkpoints. **Do not proceed past these without approval:**

1. **Phase 1 complete** — Verify all memories encrypted, security audit
2. **Phase 2 complete** — Verify search works without decrypting content
3. **Phase 3 complete** — Verify E2E encryption between agents
4. **Phase 4 complete** — Verify sharing requires explicit action

When you hit a gate, ping the Oracle (Joel) with:
- What was completed
- Security verification results
- Any decisions that need Oracle Context™

## Workflow

### Starting Work

```bash
# Check current state
hive_cells --status open

# Claim a task
hive_update --id <cell-id> --status in_progress

# Load relevant skill
read .agents/skills/<skill>/SKILL.md
```

### During Work

- Commit frequently with clear messages
- Run tests before marking complete
- Document decisions in code comments or commit messages
- Store learnings in hivemind

### Completing Work

```bash
# Verify implementation
bun test
bun run typecheck

# Close the cell
hive_close --id <cell-id> --reason "Implemented X with Y approach"

# Push
git add -A && git commit -m "feat(scope): description" && git push
```

## Key Decisions (Already Made)

1. **Pi as runtime** — Not custom, not OpenClaw directly. Pi provides the agent loop.
2. **Cloudflare over Vercel** — Durable Objects are essential for agent state.
3. **Envelope encryption** — DEK per record, agent key encrypts DEK.
4. **Private by default** — No plaintext memories. Public is opt-in.
5. **did:cf method** — Lightweight DID based on Durable Object ID.

## Prior Art to Study

Before implementing, ensure familiarity with:

- **[Cirrus](https://github.com/ascorbic/cirrus)** — Production PDS on Cloudflare
- **[pi-mono](https://github.com/badlogic/pi-mono)** — Pi agent runtime
- **[moltworker](https://github.com/cloudflare/moltworker)** — OpenClaw on Cloudflare

Local clones exist at:
- `~/Code/ascorbic/cirrus`
- `~/Code/badlogic/pi-mono`
- `~/Code/cloudflare/moltworker`

## Testing Strategy

| Type | Location | When |
|------|----------|------|
| Unit | `src/**/*.test.ts` | Every save |
| Integration | `src/**/*.integration.test.ts` | Pre-commit |
| Security | `src/**/*.security.test.ts` | Phase gates |

Security tests verify:
- No plaintext in D1 tables
- Decryption requires correct keys
- Sharing requires explicit action
- Key rotation doesn't break access

## Environment

```bash
# Required
bun >= 1.0
wrangler >= 3.0

# Development
wrangler dev                    # Local development
wrangler d1 execute DB --local  # Query local D1
wrangler tail                   # View logs
```

## Naming Conventions

| Concept | Name | Example |
|---------|------|---------|
| Agent identity | `did:cf:<do-id>` | `did:cf:abc123` |
| Memory record | `<did>/<collection>/<rkey>` | `did:cf:abc/agent.memory.note/3jui7...` |
| Event type | `<domain>.<object>.<action>` | `agent.memory.store` |
| Lexicon | `agent.<domain>.<type>` | `agent.comms.message` |

## Don't Do This

- ❌ Store plaintext secrets or memories
- ❌ Skip security gates
- ❌ Implement without tests
- ❌ Make architecture decisions without Oracle approval
- ❌ Use PGLite (deprecated, use D1)
- ❌ Build custom agent loop (use Pi)

## Do This

- ✅ Encrypt everything by default
- ✅ Test security assumptions explicitly
- ✅ Study prior art before implementing
- ✅ Store learnings in hivemind
- ✅ Commit frequently
- ✅ Ping Oracle at gates
