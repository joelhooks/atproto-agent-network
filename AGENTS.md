# AGENTS.md — ⚡ AT Protocol Agent Network

This is an autonomous development workspace. Agents build agents.

## First Session

1. Read this file completely
2. Read `PI-POC.md` — the implementation plan with security gates
3. Read `docs/O11Y.md` — observability architecture
4. Check `.agents/skills/` for available skills
5. Check the hive for current work: `swarm hive cells --status open`

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

## Workflow: The Ralph Loop

### TDD is the Law

**Every feature has tests first. No exceptions.**

```
    RED           GREEN         REFACTOR
     │              │              │
     ▼              ▼              ▼
┌─────────┐   ┌─────────┐   ┌─────────┐
│  Write  │   │  Write  │   │  Clean  │
│ failing │──▶│ minimal │──▶│  code,  │
│  test   │   │  code   │   │ keep    │
│         │   │         │   │ tests   │
└─────────┘   └─────────┘   └─────────┘
```

### Sprint Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                        RALPH LOOP SPRINT                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. PLANNING (#21 template)                                      │
│     └── Select issues from backlog                               │
│     └── Verify TDD instructions complete                         │
│     └── Identify HITL gates                                      │
│                                                                  │
│  2. EXECUTION (ralph_iterate)                                    │
│     └── For each story:                                          │
│         ├── Write tests (RED)                                    │
│         ├── Implement (GREEN)                                    │
│         ├── Refactor                                             │
│         ├── Commit with "Closes #X"                              │
│         └── Update epic checkbox                                 │
│                                                                  │
│  3. GARDENING (#23)                                              │
│     └── Update affected issues                                   │
│     └── Add agent/ready to unblocked issues                      │
│     └── Update documentation                                     │
│                                                                  │
│  4. RETROSPECTIVE (#20 template)                                 │
│     └── What went well                                           │
│     └── What went poorly                                         │
│     └── Process improvements                                     │
│                                                                  │
│  5. GROOMING (#22)                                               │
│     └── Review stale issues                                      │
│     └── Verify issue quality                                     │
│     └── Update dependencies                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Starting Work

```bash
# Check prd.json for current sprint
cat prd.json | jq '.sprints[0]'

# Or check GitHub for agent/ready issues
gh issue list --label "agent/ready" --limit 10

# Claim a task
gh issue edit <number> --remove-label "agent/ready" --add-label "agent/claimed"

# Load relevant skill
read .agents/skills/<skill>/SKILL.md
```

### During Work (TDD)

```bash
# 1. Write test first
touch packages/[pkg]/src/[feature].test.ts
# Write failing tests

# 2. Run test (should fail)
pnpm vitest run packages/[pkg]/src/[feature].test.ts

# 3. Implement minimal code to pass
# Edit packages/[pkg]/src/[feature].ts

# 4. Run test (should pass)
pnpm vitest run packages/[pkg]/src/[feature].test.ts

# 5. Commit
git add -A && git commit -m "test(pkg): add tests for feature"
git add -A && git commit -m "feat(pkg): implement feature"

# 6. Refactor if needed, ensure tests still pass
pnpm test
```

### Completing Work

```bash
# Verify all tests pass
pnpm turbo test

# Verify types
pnpm turbo typecheck

# Create PR with issue reference
gh pr create --title "feat(pkg): description" --body "Closes #X

## Changes
- Added tests for X
- Implemented X
- Updated documentation

## Tests
- packages/pkg/src/feature.test.ts (5 new tests)
"

# Update epic checkbox (in issue #1 or parent)
# Add comment linking PR

# Mark for review
gh issue edit <number> --remove-label "agent/claimed" --add-label "agent/review"
```

### Gardening After Work

```bash
# Check what issues are now unblocked
gh issue list --label "agent/blocked"

# For each unblocked issue:
gh issue edit <number> --remove-label "agent/blocked" --add-label "agent/ready"

# Update epic progress
gh issue comment <epic-number> --body "✅ Completed #X - [summary]"
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

## Secrets (agent-secrets)

Credentials are managed via `agent-secrets` under the `atproto-agents` namespace:

| Secret | Purpose |
|--------|---------|
| `atproto-agents::cloudflare_api_key` | Cloudflare API key for Workers/DO deployment |
| `atproto-agents::cloudflare_account_id` | Cloudflare account ID |
| `atproto-agents::openrouter_api_key` | OpenRouter API key for LLM access |

```bash
# Lease credentials for a session (2h default)
secrets lease atproto-agents::cloudflare_api_key --ttl 2h
secrets lease atproto-agents::cloudflare_account_id --ttl 2h
secrets lease atproto-agents::openrouter_api_key --ttl 2h

# Or inject into a command directly
secrets exec --namespace atproto-agents -- wrangler deploy

# Revoke all leases when done
secrets revoke --namespace atproto-agents

# Check what's available
secrets health
```

**Do NOT hardcode credentials.** Always lease from `agent-secrets`.

## Environment

```bash
# Required
pnpm >= 9.0
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
- ❌ **Hand-write package.json dependencies** — NEVER manually edit dependency versions or create stub packages
- ❌ Create fake workspace packages to satisfy imports

## Do This

- ✅ Encrypt everything by default
- ✅ Test security assumptions explicitly
- ✅ Study prior art before implementing
- ✅ Store learnings in hivemind
- ✅ Commit frequently
- ✅ Ping Oracle at gates
- ✅ **ALWAYS install packages from CLI**: `pnpm add <pkg>` or `pnpm add -D <pkg>` — never hand-write versions in package.json
