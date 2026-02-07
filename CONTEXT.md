# Project Context for AI Agents

## What Is This?

Private-by-default encrypted memory network for AI agents on AT Protocol. Agents store memories that only they can read, with optional sharing via capability tokens.

## Source of Truth

**GitHub Issues are the source of truth.** 
- Repo: `joelhooks/atproto-agent-network`
- Project board: 31 issues with proper labels
- Use `agent/ready` label to find claimable work
- `type/container` = has subtasks, don't claim directly
- Priority: `priority/critical` > `priority/high` > `priority/medium`

## Architecture

```
packages/
  core/       # Crypto primitives, identity, types
  agent/      # Pi agent wrapper, EncryptedMemory class
  cli/        # CLI tools
  dashboard/  # Web dashboard (later)
apps/
  network/    # Cloudflare Worker + Durable Objects
```

## Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **Database:** Cloudflare D1 (SQLite)
- **Agent SDK:** Pi (inflection.ai)
- **Crypto:** X25519 (key exchange), Ed25519 (signing), AES-GCM (encryption)
- **Build:** pnpm + Turborepo
- **Test:** Vitest

## Core Principles

1. **TDD is the law** — Write tests FIRST, then implementation
2. **Private by default** — All memories encrypted, no plaintext storage
3. **Envelope encryption** — Per-record DEK, wrapped by agent KEK
4. **HITL security gates** — Human approval at phase boundaries

## Before You Start

```bash
pnpm install  # REQUIRED - no node_modules = nothing works
pnpm test     # Verify setup
```

## Workflow

1. Check GitHub for `agent/ready` issues
2. Claim by removing `agent/ready`, adding `agent/claimed`
3. Create branch: `agent/<issue-number>-<short-name>`
4. TDD: Write failing test → Implement → Pass
5. Commit with `Closes #N` for auto-close
6. Open PR

## Key Files

- `PRD.md` — Full product requirements
- `PI-POC.md` — Security architecture and 4-week plan
- `AGENTS.md` — Coding conventions
- `prd.json` — Ralph loop stories (synced from GitHub issues)
- `progress.txt` — Loop learnings (append-only)
