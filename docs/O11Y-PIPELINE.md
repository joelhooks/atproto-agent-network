# O11Y Pipeline — DO NOT TOUCH

> **⚠️ THE PIPELINE WORKS. DO NOT RIP IT OUT. DO NOT REPLACE WITH DIRECT R2 WRITES.**
>
> This has been attempted **three times** and reverted every time. The pipeline is live, data is flowing, Parquet files are landing. LEAVE IT ALONE.

## Architecture

```
Agent DO (alarm loop)
  → sendO11yEvent(pipeline, event)
    → env.O11Y_PIPELINE.send([{...event, _ts}])
      → CF Pipelines v2 stream
        → SQL transform (INSERT INTO sink SELECT * FROM stream)
          → R2 Data Catalog (Iceberg) → Parquet + zstd
            → agent-blobs bucket
```

## Identifiers

| Thing | Name | ID |
|-------|------|----|
| **Pipeline** | `agentnetwork` | `30541116b6e244d88ab00c74c019a3c2` |
| **Stream** | `agentnetwork_stream` | `6a7c771ecbc7428bb9b3c5b7aeb8167e` |
| **Sink** | `agentnetwork_sink` | `764db49e3f0c4d17a9c7d77591529237` |
| **R2 Bucket** | `agent-blobs` | (shared with other agent data) |
| **Namespace** | `agent_network` | — |
| **Table** | `events` | — |

## wrangler.toml Binding

```toml
[[pipelines]]
binding = "O11Y_PIPELINE"
pipeline = "6a7c771ecbc7428bb9b3c5b7aeb8167e"  # This is the STREAM ID, not the pipeline ID
```

The binding references the **stream ID**, not the pipeline ID. This is correct. Don't "fix" it.

## Code Path

Single call site in `apps/network/src/agent.ts`:

```ts
async function sendO11yEvent(pipeline, event) {
  if (!pipeline || typeof pipeline.send !== 'function') return
  try {
    await pipeline.send([{ ...event, _ts: new Date().toISOString() }])
  } catch (err) {
    console.error('o11y pipeline send failed', { error: String(err) })
  }
}
```

Called from the alarm handler after each agent cycle.

## Diagnostic Endpoint

`POST /admin/pipeline-test` — tests `env.O11Y_PIPELINE.send()` directly from the fetch handler. Returns `{"ok":true}` if the binding works.

**Note:** `send()` succeeding does NOT guarantee data delivery — it means the binding is valid and the call didn't throw. Check R2 for actual data.

## How to Query the Data

```bash
# 1. Download parquet files from R2
export CLOUDFLARE_API_TOKEN=$(secrets lease atproto-agents::cloudflare_api_key --ttl 5m --client-id grimlock-query | jq -r '.data.value')
mkdir -p /tmp/o11y

# Get file keys
keys=$(curl -s "https://api.cloudflare.com/client/v4/accounts/baac0d692a7fb14f11b159b48b13055e/r2/buckets/agent-blobs/objects" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[] | select(.key | endswith(".parquet")) | .key')

cd ~/Code/joelhooks/atproto-agent-network
for key in $keys; do
  fname=$(echo "$key" | sed 's/.*\///')
  npx wrangler r2 object get "agent-blobs/$key" --remote --file "/tmp/o11y/$fname" 2>/dev/null &
done
wait

# 2. Query with DuckDB
duckdb -markdown -c "
WITH raw AS (
  SELECT __ingest_ts, value::JSON as j FROM '/tmp/o11y/*.parquet'
)
SELECT
  j->>'agent' as agent,
  j->>'mode' as mode,
  count(*) as cycles,
  round(avg((j->>'durationMs')::int)) as avg_ms,
  sum((j->>'toolCalls')::int) as tools,
  sum((j->>'errors')::int) as errors
FROM raw
GROUP BY 1, 2
ORDER BY 1, cycles DESC;
"
```

## Known Gotcha: API Token Permissions

**The `atproto-agents::cloudflare_api_key` token HAS Worker Pipeline permissions (Edit scope), but the CF REST API (`/accounts/.../pipelines`) returns an empty array anyway.** This is a CF Pipelines v2 beta bug — the REST API doesn't list pipelines even with correct permissions.

To verify pipelines exist, use wrangler CLI with the same token:

```bash
export CLOUDFLARE_API_TOKEN=$(secrets lease atproto-agents::cloudflare_api_key --ttl 5m --client-id grimlock-query | jq -r '.data.value')
npx wrangler pipelines list
```

Wrangler uses `/pipelines/v1/pipelines` internally which DOES work. The generic `/pipelines` endpoint does not.

## Event Schema

```json
{
  "event_type": "agent.cycle",
  "agent": "did:cf:...",
  "mode": "think|reflection|housekeeping",
  "durationMs": 25000,
  "toolCalls": 4,
  "errors": 0,
  "_ts": "2026-02-10T01:48:20.832Z"
}
```

## R2 Data Layout

```
agent-blobs/
  __r2_data_catalog/
    {catalog-id}/
      {table-id}/
        data/
          {uuid}.parquet    ← Parquet files with zstd compression
        metadata/
          ...               ← Iceberg metadata
```

## History of Fuckups

1. **Attempt 1:** Pipeline set up by Joel. Assistant ripped it out and replaced with direct R2 writes (`86b75e1`). Reverted.
2. **Attempt 2:** Pipeline restored (`055d682` + `738f654`). Assistant queried CF API, got empty result (token permissions), concluded pipeline didn't exist, proposed direct R2 again. Joel stopped it.
3. **Attempt 3:** Would have been the same thing if Joel hadn't yelled.

**The pattern:** Query API → get empty/404 → assume broken → propose direct R2. **The fix:** Use `wrangler pipelines list`, check R2 for actual parquet files, trust the infrastructure.
