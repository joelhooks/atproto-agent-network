---
name: atproto-deploy
description: Deploy the atproto-agent-network project. Two separate Cloudflare Workers must be deployed independently — the network worker (API + agents) and the dashboard worker (highswarm.com). Use when deploying changes, fixing the dashboard, or updating agent configs.
---

# Deploy: atproto-agent-network

## ⚠️ CRITICAL: Two Separate Workers

This project has **two independent Cloudflare Workers**. Deploying one does NOT deploy the other.

| Worker | Location | URL | Serves |
|--------|----------|-----|--------|
| **network** | `apps/network/` | `agent-network.joelhooks.workers.dev` | API, Agent DOs, Relay, WebSocket |
| **dashboard** | `packages/dashboard/` | `highswarm.com` (`highswarm.joelhooks.workers.dev`) | Static dashboard SPA |

## Quick Deploy

```bash
# Get CF token
export CLOUDFLARE_API_TOKEN=$(secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 10m --client-id "deploy")

# Deploy network worker (API + agents)
cd apps/network && npx wrangler deploy

# Deploy dashboard (MUST rebuild Vite first!)
cd packages/dashboard && npx vite build && npx wrangler deploy
```

## Deploy Both (full deploy)

```bash
export CLOUDFLARE_API_TOKEN=$(secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 10m --client-id "deploy")

# Network
cd apps/network && npx wrangler deploy

# Dashboard — rebuild + deploy
cd ../../packages/dashboard && npx vite build && npx wrangler deploy
```

## Dashboard-Only Deploy

When changes are only in `packages/dashboard/`:

```bash
export CLOUDFLARE_API_TOKEN=$(secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 10m --client-id "deploy-dashboard")
cd packages/dashboard && npx vite build && npx wrangler deploy
```

### Verify dashboard deploy landed

```bash
# Check the JS bundle hash changed
curl -s https://highswarm.com | grep -o 'index-[A-Za-z0-9]*\.js'
```

## Network-Only Deploy

When changes are only in `apps/network/`, `packages/agent/`, or `packages/core/`:

```bash
export CLOUDFLARE_API_TOKEN=$(secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 10m --client-id "deploy-network")
cd apps/network && npx wrangler deploy
```

## Pre-Deploy Checks

```bash
# From repo root — always run before deploying
npx turbo typecheck        # Type check all packages
npx vitest run             # Run tests (1 flaky Catan test is known)
```

## CF Secrets

Secrets are namespaced under `atproto-agents::` in agent-secrets:
- `cloudflare_api_key` — CF API token for wrangler
- `cloudflare_account_id` — CF account ID
- `openrouter_api_key` — OpenRouter API key (set as CF worker secret)

Worker secrets (set via `wrangler secret put`):
- `ADMIN_TOKEN` — Admin auth token
- `OPENROUTER_API_KEY` — For AI Gateway
- `CF_ACCOUNT_ID` — For AI Gateway URL construction
- `GRIMLOCK_GITHUB_TOKEN` — For publish tool (GitHub Contents API)

## Agent Config (Runtime)

Agent model/config changes don't need a deploy — use the API:

```bash
ADMIN_TOKEN="grimlock-admin-f5f3ef8419386713454c05b8d475cce1"
BASE="https://agent-network.joelhooks.workers.dev"

# Change agent model
curl -s -X PATCH "$BASE/agents/scout/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "google/gemini-3-flash-preview"}'

# Stop/start agent loop
curl -s -X POST "$BASE/agents/scout/loop/stop" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s -X POST "$BASE/agents/scout/loop/start" -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Gotchas

1. **Dashboard rebuild required** — `packages/dashboard/dist/` is gitignored. Vite must rebuild before `wrangler deploy` or you ship stale code.
2. **DO memory persists across deploys** — Durable Object in-memory state (like conversation arrays) survives worker deploys. Stop/start the loop to reset.
3. **OpenRouter model IDs** — Use the full ID (e.g., `google/gemini-3-flash-preview`, NOT `google/gemini-3-flash`). Check https://openrouter.ai/models for valid IDs.
4. **Cache busting** — Dashboard HTML has `max-age=60`. Users may need a hard refresh. Verify with `curl -s https://highswarm.com | grep index-`.
