
## Cloudflare Authentication — SACRED KNOWLEDGE

**Secrets are namespaced under `atproto-agents::`**

```bash
# CF API key (for wrangler deploy, tail, API calls)
secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 1h --client-id <task>

# CF Account ID
secrets lease "atproto-agents::cloudflare_account_id" --raw --ttl 1h --client-id <task>

# Admin token (for authenticated worker endpoints)
secrets lease "atproto-agents::admin_token" --raw --ttl 1h --client-id <task>
```

**Usage patterns:**
```bash
# Deploy
CLOUDFLARE_API_TOKEN=$(secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 30m --client-id deploy) \
CLOUDFLARE_ACCOUNT_ID=$(secrets lease "atproto-agents::cloudflare_account_id" --raw --ttl 30m --client-id deploy) \
npx wrangler deploy

# Tail logs (real-time monitoring)
CLOUDFLARE_API_TOKEN=$(secrets lease "atproto-agents::cloudflare_api_key" --raw --ttl 1h --client-id tail) \
CLOUDFLARE_ACCOUNT_ID=$(secrets lease "atproto-agents::cloudflare_account_id" --raw --ttl 1h --client-id tail) \
npx wrangler tail --format pretty

# Hit authenticated endpoints
ADMIN_TOKEN=$(secrets lease "atproto-agents::admin_token" --raw --ttl 30m --client-id test) \
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://agent-network.joelhooks.workers.dev/agents/test/loop/status
```

**Account:** `baac0d692a7fb14f` (Joel's personal CF account, NOT Skill Recordings)
**Worker:** `agent-network` at `https://agent-network.joelhooks.workers.dev`
**DO NOT use `cloudflare_api_token` (non-namespaced) — that's Skill Recordings, wrong account.**
