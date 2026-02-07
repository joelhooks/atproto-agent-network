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
- **AI Inference:** Vercel AI SDK → Cloudflare AI Gateway → OpenRouter (Kimi 2.5 primary)
- **Embeddings:** Workers AI (`@cf/baai/bge-large-en-v1.5`) — edge, free
- **Crypto:** X25519 (key exchange), Ed25519 (signing), AES-GCM (encryption)
- **Build:** pnpm + Turborepo
- **Test:** Vitest

## AI Gateway Architecture

See `docs/AI-GATEWAY-ARCHITECTURE.md` for full details.

```
Agent Code (Vercel AI SDK)
    → Cloudflare AI Gateway (observability, caching, fallback)
        → OpenRouter (Kimi 2.5, Claude, Gemini)
        → Workers AI (edge embeddings)
```

## Core Principles

1. **TDD is the law** — Write tests FIRST, then implementation
2. **Private by default** — All memories encrypted, no plaintext storage
3. **Envelope encryption** — Per-record DEK, wrapped by agent KEK
4. **HITL security gates** — Human approval at phase boundaries

## Secrets Management

Secrets are managed via `agent-secrets` CLI. Namespace: `atproto-agents`

**Available secrets:**
- `cloudflare_api_key` — CF API token (Workers, D1, AI Gateway, DNS, etc.)
- `cloudflare_account_id` — CF account ID
- `openrouter_api_key` — OpenRouter API key (Kimi 2.5, Claude, etc.)

**Usage:**
```bash
# Lease a secret (returns value only — perfect for piping)
export CF_API_TOKEN=$(secrets lease atproto-agents::cloudflare_api_key --ttl 2h)
export CF_ACCOUNT_ID=$(secrets lease atproto-agents::cloudflare_account_id --ttl 2h)
export OPENROUTER_API_KEY=$(secrets lease atproto-agents::openrouter_api_key --ttl 2h)

# Use with wrangler
CLOUDFLARE_API_TOKEN=$CF_API_TOKEN wrangler deploy
CLOUDFLARE_API_TOKEN=$CF_API_TOKEN wrangler d1 create atproto-agent-network

# Store as wrangler secrets (for production)
echo $OPENROUTER_API_KEY | CLOUDFLARE_API_TOKEN=$CF_API_TOKEN wrangler secret put OPENROUTER_API_KEY

# Revoke when done
secrets revoke --all
```

**Rules:**
- Never hardcode secrets in code or config files
- Always use `--ttl` matched to task duration
- Revoke leases after task completion
- Use `secrets exec` for one-shot commands

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
5. Commit with conventional format: `feat: description (#N)` where N is the GitHub issue number
6. Open PR

## Commit Message Convention (MANDATORY)

**Every commit MUST reference the GitHub issue number and project:**
- Format: `type: description (#N)` 
- Example: `feat: add X25519 keypair generation (#28)`
- Example: `test: add identity.ts unit tests (#25)`
- Types: `feat`, `test`, `fix`, `chore`, `refactor`
- The `(#N)` creates a clickable link to the issue on GitHub
- Check `prd.json` for the `githubIssue` field to find the issue number

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
