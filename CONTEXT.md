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

## Coordinator Instructions (CRITICAL)

**Before every Ralph loop run:**

1. **Groom the backlog first**
   - `gh issue list --state open --label agent/ready` — what's claimable?
   - Close completed issues
   - Remove `agent/ready` from blocked issues
   - Verify `type/container` issues don't have `agent/ready`

2. **Sync prd.json with GitHub**
   - Stories must map to real issues
   - Priority order must match dependencies
   - Remove stories for closed issues

3. **Check dependencies**
   - Don't start crypto stories before test infra
   - Don't start agent layer before crypto

4. **Update progress.txt**
   - What's done, what's blocked, what's next
   - Append learnings from completed work

**The backlog is the truth. prd.json is a cache.**

## Progress Reporting (REQUIRED)

**Workers must report progress to coordinator via OpenClaw:**

```bash
# Report task start
openclaw message "🚀 Starting: [story-id] - [title]"

# Report completion
openclaw message "✅ Completed: [story-id] - [summary of what was done]"

# Report blockers
openclaw message "🚫 Blocked: [story-id] - [what's blocking and why]"

# Report test failures
openclaw message "❌ Tests failing: [story-id] - [failure summary]"
```

**This keeps the coordinator (Grimlock) in the loop in real-time.**
Don't just commit silently — communicate!
