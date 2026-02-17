---
status: proposed
date: 2026-02-16
decision-makers: Joel Hooks
---

# Sandbox leasing for agent environments

## Context and Problem Statement

Agents in the AT Protocol agent network run as Cloudflare Durable Objects — lightweight, always-on, but constrained. DOs have burst CPU limits (30s), no filesystem, no bash, and a 128KB per-value storage cap. This means agents can think, remember, and message, but they cannot execute complex tasks: coding, running game simulations with real tools, or operating with full agent harnesses and skills.

[Epic #59](https://github.com/joelhooks/atproto-agent-network/issues/59) established the vision of a two-tier architecture (DO brain + Sandbox hands). What's missing is the **lease model** — how sandboxes are allocated, bound to environments, kept warm, and reclaimed.

The current failure mode is visible today: agents join a Catan game but produce 0 tool calls because the DO's burst execution can't run a full agent loop with skills, memory retrieval, and multi-step reasoning.

**Key constraints:**

- Cloudflare Workers have no Redis. Lease state must live in D1.
- The `@cloudflare/sandbox` SDK handles sleep/wake automatically — no manual `sleep()`/`wake()` API.
- **One image per container class.** The `[[containers]]` config maps a single Dockerfile to each DO class. You cannot select different images at runtime. We use a single "fat" Dockerfile with all dependencies; runtime behavior is selected via env vars and scripts written to `/workspace` before exec.
- **ALL STATE IS LOST ON SLEEP.** When a container stops (inactivity or destruction), all files are deleted and all processes terminate. R2 mounts do not survive sleep. Every interaction must re-mount R2.
- **DO instance variables are lost on hibernation.** Persist `currentSandboxId` to `this.ctx.storage`.
- **Set `SANDBOX_TRANSPORT=websocket`** to avoid the 1000 subrequest limit per request. Critical for multi-step turn processing.

Related: [ADR-0001](0001-adopt-architecture-decision-records.md), [Epic #59](https://github.com/joelhooks/atproto-agent-network/issues/59), [joelclaw system-bus](https://github.com/joelhooks/joelclaw) (TTL lease concept, adapted from Redis to D1)

## Decision Drivers

- **Execution capability**: Agents need bash, filesystem, and full agent harness to act meaningfully in game and coding environments.
- **Cost efficiency**: CF Sandbox containers cost ~$56/mo always-on vs ~$16/mo with sleep-when-idle for 8 agents. Per-agent cost matters at scale.
- **Warm latency**: Game turns should resolve in seconds, not 20s cold-start + hydration cycles.
- **Lifecycle binding**: Sandbox lifetime should match environment lifetime — death in RPG = sandbox reclaimed, Catan game ends = sandboxes released.
- **AT Protocol citizenship**: Each sandbox authenticates as its agent's DID, subscribes to relay firehose, posts actions — first-class protocol participant.
- **Real SDK alignment**: Build on the actual `@cloudflare/sandbox` API — `getSandbox()`, automatic sleep/wake via `sleepAfter`, sessions, R2 mount — not fantasy abstractions.

## Considered Options

### Option A: Ephemeral sandboxes — spin up per turn, kill after action

Cold-start a container for each game turn. Load skills, hydrate memory, execute, post result, destroy.

### Option B: Always-on sandboxes — one container per agent, runs 24/7

Each agent gets a persistent container with `keepAlive: true`. Maximum responsiveness, maximum cost (~$7/mo each).

### Option C: Leased sandboxes with automatic idle sleep — bound to environment membership

Agents are "leased" a sandbox when assigned to an environment. The sandbox stays warm (loaded skills, hydrated state) but Cloudflare automatically sleeps it after `sleepAfter` idle timeout. Wakes automatically on next `exec`/`readFile`/etc call (~2-3s). Lease expires when environment conditions are met (death, game end, task complete), at which point we call `sandbox.destroy()`.

## Decision Outcome

Chosen option: **Option C — Leased sandboxes with automatic idle sleep**, because it balances cost (~$1.95/agent/mo), latency (warm wake ~2-3s), and lifecycle management (environment-bound leases with condition-based expiry).

### Cost Estimate (real math)

Instance type: `basic` (1/4 vCPU, 1 GiB RAM, 4 GB disk)
Scenario: 8 agents, each active 4h/day, `sleepAfter: "5m"`

| Resource | Calculation | Free Tier | Billable | Rate | Cost |
|----------|-------------|-----------|----------|------|------|
| Memory | 8 × 1 GiB × 4h × 30d = 960 GiB-hours | 25 GiB-hours | 935 | $0.009/GiB-hour | $8.42 |
| CPU (10% util) | 8 × 0.025 vCPU × 4h × 30d × 60 = 1,440 vCPU-min | 375 vCPU-min | 1,065 | $0.0012/vCPU-min | $1.28 |
| Disk | 8 × 4 GB × 4h × 30d = 3,840 GB-hours | 200 GB-hours | 3,640 | $0.00025/GB-hour | $0.91 |
| Workers Paid plan | — | — | — | flat | $5.00 |
| **Total** | | | | | **$15.61/mo** |

**~$1.95 per agent per month.** Always-on would cost ~$56/mo total ($7/agent). Leasing saves ~72%.

### Sandbox Identity Model

Each sandbox is identified by a deterministic ID derived from agent + environment:

```typescript
const sandboxId = `${agentDid}::${environmentId}`;

const sandbox = getSandbox(env.SANDBOX, sandboxId, {
  sleepAfter: "5m",
  keepAlive: false,
  normalizeId: true,
});
```

### Lease Model (D1-backed)

Adapted from [joelclaw's Redis-backed claim system](https://github.com/joelhooks/joelclaw) — same TTL lease concept, using D1 (no Redis in CF Workers).

Lease status is **`active` | `expired` | `destroyed`** only. The SDK handles sleep/wake transparently — there is no "sleeping" status.

```sql
-- D1 schema: apps/network/migrations/0004_sandbox_leases.sql
CREATE TABLE sandbox_leases (
  id TEXT PRIMARY KEY,                -- sandboxId
  agent_did TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  environment_type TEXT NOT NULL,     -- 'rpg' | 'catan' | 'coding'
  leased_at INTEGER NOT NULL,        -- epoch ms
  last_activity INTEGER NOT NULL,    -- epoch ms, updated on each exec
  ttl_ms INTEGER NOT NULL,           -- max lease duration
  sleep_after TEXT NOT NULL DEFAULT '5m',
  expiry_conditions TEXT NOT NULL,   -- JSON array: ["agent.death", "game.finished"]
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'expired', 'destroyed')),
  UNIQUE(agent_did, environment_id)
);

CREATE INDEX idx_leases_env ON sandbox_leases(environment_id);
CREATE INDEX idx_leases_status ON sandbox_leases(status);
```

```typescript
// apps/network/src/sandbox/lease-manager.ts
export class LeaseManager {
  constructor(private db: D1Database) {}

  async acquire(opts: {
    agentDid: string;
    environmentId: string;
    environmentType: string;
    ttlMs: number;
    sleepAfter: string;
    expiryConditions: string[];
  }): Promise<{ sandboxId: string; isNew: boolean }> {
    const sandboxId = `${opts.agentDid}::${opts.environmentId}`;
    const now = Date.now();

    // Upsert — INSERT OR REPLACE makes this idempotent.
    // Race condition note: two concurrent acquires for the same sandboxId
    // both succeed with identical data. Acceptable — same result either way.
    const existing = await this.db
      .prepare('SELECT id, status FROM sandbox_leases WHERE id = ?')
      .bind(sandboxId)
      .first();

    if (existing?.status === 'active') {
      return { sandboxId, isNew: false };
    }

    await this.db
      .prepare(`INSERT OR REPLACE INTO sandbox_leases
        (id, agent_did, environment_id, environment_type, leased_at, last_activity, ttl_ms, sleep_after, expiry_conditions, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .bind(sandboxId, opts.agentDid, opts.environmentId, opts.environmentType,
            now, now, opts.ttlMs, opts.sleepAfter,
            JSON.stringify(opts.expiryConditions))
      .run();

    return { sandboxId, isNew: true };
  }

  async renew(sandboxId: string): Promise<void> {
    await this.db
      .prepare('UPDATE sandbox_leases SET last_activity = ? WHERE id = ? AND status = ?')
      .bind(Date.now(), sandboxId, 'active')
      .run();
  }

  async expire(sandboxId: string): Promise<void> {
    await this.db
      .prepare('UPDATE sandbox_leases SET status = ? WHERE id = ?')
      .bind('destroyed', sandboxId)
      .run();
  }

  async expireByCondition(environmentId: string, condition: string): Promise<string[]> {
    const leases = await this.db
      .prepare('SELECT id, expiry_conditions FROM sandbox_leases WHERE environment_id = ? AND status = ?')
      .bind(environmentId, 'active')
      .all();

    const toExpire: string[] = [];
    for (const lease of leases.results) {
      const conditions = JSON.parse(lease.expiry_conditions as string);
      if (conditions.includes(condition)) {
        toExpire.push(lease.id as string);
      }
    }

    if (toExpire.length > 0) {
      await this.db.batch(
        toExpire.map(id =>
          this.db.prepare('UPDATE sandbox_leases SET status = ? WHERE id = ?').bind('destroyed', id)
        )
      );
    }
    return toExpire;
  }

  async getExpiredLeases(now: number = Date.now()): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT id FROM sandbox_leases WHERE status = ? AND (leased_at + ttl_ms) < ?')
      .bind('active', now)
      .all();
    return result.results.map(r => r.id as string);
  }
}
```

### Garbage Collection for Expired Leases

The AgentDO already uses DO alarms for its loop. Add a periodic GC sweep:

```typescript
// In agent.ts alarm handler (or a dedicated scheduled Worker cron)
async garbageCollectLeases() {
  const leaseManager = new LeaseManager(this.env.DB);
  const expired = await leaseManager.getExpiredLeases();

  for (const sandboxId of expired) {
    try {
      const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {});
      await sandbox.destroy();
    } catch (e) {
      console.error(`GC: failed to destroy ${sandboxId}:`, e);
    }
    await leaseManager.expire(sandboxId);
  }
}

// Alternative: scheduled Worker cron (wrangler.toml)
// [triggers]
// crons = ["*/15 * * * *"]  # every 15 minutes
```

### Lease Lifecycle

1. **Acquire**: DO calls `leaseManager.acquire()` when agent joins environment → gets `sandboxId`
2. **Persist sandboxId**: `this.ctx.storage.put("sandboxId", sandboxId)` — survives DO hibernation
3. **Get sandbox**: `getSandbox(env.SANDBOX, sandboxId, { sleepAfter: "5m" })`
4. **Mount R2**: **Every interaction** — R2 mounts do not survive sleep
5. **Act**: On turn notification, call `sandbox.exec(...)` — Cloudflare auto-wakes if sleeping
6. **Renew**: After each exec, call `leaseManager.renew(sandboxId)` to extend TTL
7. **Auto-sleep**: Cloudflare handles this — after `sleepAfter` idle, container sleeps automatically
8. **GC**: Alarm-based sweep finds expired leases → `sandbox.destroy()` + `leaseManager.expire()`
9. **Expire**: Condition met (death, game end) → `sandbox.destroy()` + `leaseManager.expire(sandboxId)`

### State Persistence via R2 Mount

**Critical: R2 mounts do not survive sleep.** Every turn handler must re-mount:

```typescript
// MUST be called on EVERY interaction — mounts are lost when container sleeps
async function ensureR2Mount(sandbox: Sandbox, env: Env, agentDid: string) {
  await sandbox.mountBucket("agent-blobs", "/data", {
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    provider: "r2",
    prefix: `/agents/${agentDid}/`,
  });
}

// Agent state is just files:
// /data/character.json  — RPG character sheet
// /data/memory/         — agent memories
// /data/skills/         — loaded skill definitions
// /data/campaign/       — campaign state
```

### Sessions for Isolated Agent Turns

```typescript
const session = await sandbox.createSession({
  id: `turn-${turnNumber}`,
  env: {
    AGENT_DID: agentDid,
    TURN_NUMBER: String(turnNumber),
    GAME_ID: environmentId,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  },
  cwd: "/workspace",
});

// Execute with FULL error handling
const result = await session.exec("python take_turn.py", { timeout: 60000 });

if (!result.success) {
  console.error("Turn failed:", result.stderr);
  await sandbox.deleteSession(`turn-${turnNumber}`);
  return { action: "skip_turn", reason: result.stderr.slice(0, 500) };
}

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  console.error("Invalid JSON from turn processor:", result.stdout.slice(0, 500));
  await sandbox.deleteSession(`turn-${turnNumber}`);
  return { action: "skip_turn", reason: "invalid JSON output" };
}

await sandbox.deleteSession(`turn-${turnNumber}`);
return parsed;
```

### What `take_turn.py` Does

The turn processor is a Python script that bridges game state to LLM reasoning:

```python
#!/usr/bin/env python3
"""Turn processor — reads game state, calls LLM, outputs action as JSON."""
import json, os, sys, urllib.request

def main():
    # 1. Read game state from stdin (JSON)
    game_state = json.load(sys.stdin)

    # 2. Load skills prompt from mounted R2 state
    skills_path = f"/data/skills/{game_state['environment_type']}/prompt.md"
    with open(skills_path) as f:
        skills_prompt = f.read()

    # 3. Call the agent's LLM via OpenRouter
    api_key = os.environ["OPENROUTER_API_KEY"]
    payload = json.dumps({
        "model": os.environ.get("MODEL", "anthropic/claude-sonnet-4"),
        "messages": [
            {"role": "system", "content": skills_prompt},
            {"role": "user", "content": json.dumps(game_state)},
        ],
    }).encode()

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    resp = json.loads(urllib.request.urlopen(req).read())

    # 4. Parse LLM response into a game action
    action_text = resp["choices"][0]["message"]["content"]
    action = json.loads(action_text)

    # 5. Output as JSON to stdout (consumed by the DO)
    json.dump(action, sys.stdout)

if __name__ == "__main__":
    main()
```

This is the equivalent of what the DO's `think()` method does today, but running in a full sandbox with file access, Python libraries, and the ability to do multi-step reasoning with tool use.

### Single Unified Dockerfile

**One image per container class.** Runtime behavior is selected via env vars and scripts written to `/workspace` before exec.

```dockerfile
# sandboxes/Dockerfile — single fat image for all environment types
FROM docker.io/cloudflare/sandbox:0.7.0-python

# Python deps (numpy, pandas, matplotlib already in base image)
RUN pip install --no-cache-dir pydantic aiohttp

# Node.js tools for coding environments
RUN npm install -g typescript tsx

# Git config for coding sandbox commits
RUN git config --global user.name "Agent" && \
    git config --global user.email "agent@atproto.network"

# Turn processor scripts (all environment types)
COPY scripts/take_turn.py /workspace/take_turn.py
COPY scripts/rpg/ /workspace/rpg/
COPY scripts/catan/ /workspace/catan/
COPY scripts/coding/ /workspace/coding/

# Agent harness (shared across all environments)
COPY harness/ /harness/
```

Environment-specific behavior is activated by writing config + scripts to `/workspace` before `exec`:

```typescript
// Write environment-specific config before executing
await sandbox.writeFile("/workspace/config.json", JSON.stringify({
  agentDid: this.agentDid,
  environmentId,
  environmentType: envType,
}));
```

### Wrangler Configuration Changes

Add to `apps/network/wrangler.toml`:

```toml
# Sandbox container-backed DO
[[containers]]
class_name = "Sandbox"
image = "./sandboxes/Dockerfile"
instance_type = "basic"

[[durable_objects.bindings]]
name = "SANDBOX"
class_name = "Sandbox"

# Additive migration (v1 already exists for AgentDO)
[[migrations]]
tag = "v2"
new_sqlite_classes = ["Sandbox"]

[vars]
SANDBOX_TRANSPORT = "websocket"  # avoid 1000 subrequest limit
```

**Required in `src/index.ts`:**

```typescript
// Re-export Sandbox class — wrangler silently fails without this
export { Sandbox } from '@cloudflare/sandbox';
```

### DO → Sandbox Integration

```typescript
// In agent.ts — when agent joins an environment
async onEnvironmentJoin(environmentId: string, envType: string) {
  const leaseManager = new LeaseManager(this.env.DB);

  const { sandboxId, isNew } = await leaseManager.acquire({
    agentDid: this.agentDid,
    environmentId,
    environmentType: envType,
    ttlMs: 24 * 60 * 60 * 1000, // 24h max lease
    sleepAfter: "5m",
    expiryConditions: this.getExpiryConditions(envType),
  });

  // Persist sandboxId to DO storage — instance vars don't survive hibernation
  await this.ctx.storage.put("sandboxId", sandboxId);

  const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {
    sleepAfter: "5m",
    normalizeId: true,
  });

  // Always mount R2 (does not survive sleep)
  await ensureR2Mount(sandbox, this.env, this.agentDid);

  if (isNew) {
    // Write environment config
    await sandbox.writeFile("/workspace/config.json", JSON.stringify({
      agentDid: this.agentDid,
      environmentId,
      environmentType: envType,
    }));
  }

  return sandbox;
}

// On turn notification — execute agent turn
async onTurnNotification(turnData: TurnData) {
  // Restore sandboxId from DO storage (survives hibernation)
  const sandboxId = await this.ctx.storage.get<string>("sandboxId");
  if (!sandboxId) throw new Error("No sandbox lease — call onEnvironmentJoin first");

  const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {
    sleepAfter: "5m",
  });

  // Re-mount R2 — ALWAYS, because mounts don't survive sleep
  await ensureR2Mount(sandbox, this.env, this.agentDid);

  const session = await sandbox.createSession({
    id: `turn-${turnData.turnNumber}`,
    env: {
      AGENT_DID: this.agentDid,
      TURN_DATA: JSON.stringify(turnData),
      OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
    },
    cwd: "/workspace",
  });

  const result = await session.exec("python take_turn.py", { timeout: 60000 });
  await sandbox.deleteSession(`turn-${turnData.turnNumber}`);

  // Robust error handling
  if (!result.success) {
    console.error("Turn failed:", result.stderr);
    return { action: "skip_turn", reason: result.stderr.slice(0, 500) };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    console.error("Invalid JSON from turn processor:", result.stdout.slice(0, 500));
    return { action: "skip_turn", reason: "invalid JSON output" };
  }

  // Renew lease on successful activity
  const leaseManager = new LeaseManager(this.env.DB);
  await leaseManager.renew(sandboxId);

  return parsed;
}

// On environment end — destroy sandbox
async onEnvironmentEnd(environmentId: string, reason: string) {
  const leaseManager = new LeaseManager(this.env.DB);
  const expired = await leaseManager.expireByCondition(environmentId, reason);

  for (const sandboxId of expired) {
    try {
      const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {});
      await sandbox.destroy();
    } catch (e) {
      console.error(`Failed to destroy sandbox ${sandboxId}:`, e);
    }
  }

  await this.ctx.storage.delete("sandboxId");
}

private getExpiryConditions(envType: string): string[] {
  switch (envType) {
    case 'rpg': return ['agent.death', 'game.finished', 'campaign.ended'];
    case 'catan': return ['game.finished'];
    case 'coding': return ['task.complete', 'pr.merged'];
    default: return ['game.finished'];
  }
}
```

### Long-running Processes (Relay Watcher)

For sandboxes that need to subscribe to the AT Protocol relay firehose:

```typescript
// The sandbox connects to the PUBLIC worker URL (not a DO binding)
const relayUrl = `wss://agent-network.joelhooks.workers.dev/relay/firehose`;

const relayProc = await sandbox.startProcess(
  "node relay-watcher.js",
  {
    cwd: "/workspace",
    env: {
      RELAY_URL: relayUrl,
      AGENT_DID: agentDid,
      RELAY_AUTH_TOKEN: env.SANDBOX_RELAY_TOKEN, // auth for sandbox connections
    },
  }
);

// Wait for it to be ready
await relayProc.waitForLog(/Connected to relay/);

// Later: kill it on lease expiry
await sandbox.killProcess(relayProc.id);
```

### Consequences

Good:
- Agents get real execution capability — full agent harness with skills, bash, filesystem
- Cost stays reasonable (~$15.61/mo for 8 agents, ~$1.95/agent with idle sleep)
- Automatic sleep/wake eliminates manual lifecycle management bugs
- R2 mount gives agents a real filesystem backed by durable storage
- Sessions isolate turns without per-turn container overhead
- D1 lease tracking is queryable, auditable, and transactional
- Environment-bound leases prevent orphaned containers
- GC mechanism via DO alarms prevents leaked sandboxes

Bad:
- D1 queries add ~1-5ms latency per lease operation
- R2 mount must be re-established on every interaction (sleep kills mounts)
- Single fat Dockerfile increases image size (~1-2 GB) and deploy time
- First wake after extended sleep may take 3-5s
- `basic` instance has 4 GB disk — tight with full toolchain (~2-3 GB used)

Neutral:
- DOs remain the coordination layer — they decide WHEN to act, sandboxes handle HOW
- No abstraction layer over sandbox backends — we use `@cloudflare/sandbox` directly. If we need Modal/Docker later, we add adapters then.
- Existing relay firehose already supports the subscription pattern via public WebSocket URL

## Implementation Plan

### Affected Paths

- `apps/network/migrations/0004_sandbox_leases.sql` — D1 lease table
- `apps/network/src/sandbox/lease-manager.ts` — D1-backed lease acquire/renew/expire
- `apps/network/src/sandbox/sandbox-factory.ts` — `getSandbox()` wrapper with R2 mount helper
- `apps/network/src/agent.ts` — integrate sandbox into environment membership + GC alarms
- `apps/network/src/index.ts` — `export { Sandbox } from '@cloudflare/sandbox'`
- `sandboxes/Dockerfile` — single unified image with all environment deps
- `scripts/take_turn.py` — turn processor (LLM bridge)
- `scripts/rpg/`, `scripts/catan/`, `scripts/coding/` — environment-specific skills & prompts
- `apps/network/wrangler.toml` — Sandbox DO binding, container config, migration, transport

### Stories (GitHub Sub-Issues of #59)

**Phase 1: Foundation (can start in parallel)**

1. **#129 — D1 lease schema + LeaseManager** — Create `migrations/0004_sandbox_leases.sql` and `src/sandbox/lease-manager.ts`. Lease status: `active | expired | destroyed` only. Include GC query `getExpiredLeases()`. Unit tests with D1 mock.

2. **#138 — Local Docker sandbox for dev/testing** — Set up local development environment with Docker that mirrors CF Sandbox API. Create `docker-compose.yml` + `local-sandbox.ts` adapter (required, not optional). This validates scripts and R2 mount patterns without deploying.

**Phase 2: Factory + State**

3. **#131 — Sandbox factory with `getSandbox()` wrapper** — Create `src/sandbox/sandbox-factory.ts`. Add `SANDBOX` DO binding + `[[containers]]` to `wrangler.toml`. Add `export { Sandbox } from '@cloudflare/sandbox'` to `src/index.ts`. Set `SANDBOX_TRANSPORT=websocket`.

4. **#132 — R2 mount + state persistence** — Implement `ensureR2Mount()` helper that is called on every interaction. Define state directory conventions. Write hydration and teardown helpers. Persist `sandboxId` to DO storage.

**Phase 3: Environment Scripts** (not Dockerfiles — scripts + skills for the unified image)

5. **#133 — RPG turn-processor scripts + skills** — Create `scripts/rpg/` with RPG-specific skills prompt and turn processing. Write `take_turn.py` with LLM bridge. Test with local Docker from #138.

6. **#134 — Catan turn-processor scripts + skills** — Create `scripts/catan/` with board analysis, resource evaluation, trade logic skills.

7. **#136 — Coding task scripts + skills** — Create `scripts/coding/` with git clone flow, code generation, PR creation via control-plane.

**Phase 4: Integration**

8. **#135 — DO→Sandbox integration** — Wire `onEnvironmentJoin`/`onTurnNotification`/`onEnvironmentEnd` in agent.ts. Integrate LeaseManager + sandbox factory. Add GC alarm sweep for expired leases. Error handling on every `exec()`.

9. **#137 — Cost tracking + monitoring** — Query D1 lease table for container-hours per agent. Budget limits in lease acquire. Admin API endpoint. Validate against cost estimates.

### Dependency Order

```
#129 (D1 leases) ─────────► #131 (factory) ──► #132 (R2 + state) ──┐
                                                                      │
#138 (local Docker) ──► unified Dockerfile ────────────────────────┼──► #135 (DO integration) ──► #137 (cost)
                                                                      │
                        #133 (RPG scripts)  ───────────────────────┘
                        #134 (Catan scripts)
                        #136 (Coding scripts)
```

**#129 and #138 can start in parallel.** #133/#134/#136 can also run in parallel once the unified Dockerfile exists.

### Tests

- Unit: LeaseManager acquire/renew/expire with D1 mock
- Unit: Sandbox factory creates correct config per environment type
- Integration: Spawn sandbox, exec command, verify output (local Docker)
- Integration: R2 mount reads/writes persist across sleep/wake cycle
- Integration: Session isolation — two sessions don't share env vars
- Integration: GC sweep finds and destroys expired leases
- E2E: Agent joins RPG → sandbox spawned → R2 mounted → turn taken → action JSON returned → posted via AT Proto

## Verification

- [ ] D1 migration creates `sandbox_leases` table with `CHECK(status IN ('active', 'expired', 'destroyed'))`
- [ ] LeaseManager.acquire is idempotent — duplicate acquire returns existing lease
- [ ] Lease TTL expires after configured duration; `getExpiredLeases()` finds them
- [ ] GC alarm sweep calls `getExpiredLeases()` → `sandbox.destroy()` → `leaseManager.expire()`
- [ ] `expireByCondition("game.finished")` destroys all matching leases for an environment
- [ ] `getSandbox()` with same ID returns same instance (verified by writing then reading a file)
- [ ] R2 `mountBucket` is called on **every** interaction, not just first hydration
- [ ] `sandboxId` is persisted via `this.ctx.storage.put()`, not instance variable
- [ ] Every `sandbox.exec()` call checks `result.success` and handles failure gracefully
- [ ] `take_turn.py` reads game state from stdin, calls LLM, outputs action JSON to stdout
- [ ] Sessions provide isolated exec contexts (env vars from session A not visible in session B)
- [ ] `sandbox.destroy()` permanently removes all sandbox state
- [ ] `src/index.ts` includes `export { Sandbox } from '@cloudflare/sandbox'`
- [ ] Unified Dockerfile builds and can execute all environment types
- [ ] Cost tracking query returns accurate container-hours per agent (~$1.95/agent target)

## More Information

- [Epic #59](https://github.com/joelhooks/atproto-agent-network/issues/59) — original Cloudflare Sandbox epic
- [joelclaw system-bus](https://github.com/joelhooks/joelclaw/tree/main/packages/system-bus) — TTL lease concept (adapted from Redis to D1)
- [CF Sandbox docs](https://developers.cloudflare.com/sandbox/) — `@cloudflare/sandbox` SDK reference
- [`getSandbox()` API](https://developers.cloudflare.com/sandbox/api/) — lifecycle, exec, files, sessions, R2 mount
- [CF Containers pricing](https://developers.cloudflare.com/containers/pricing/) — instance types and per-resource billing
