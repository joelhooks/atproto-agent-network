---
status: proposed
date: 2026-02-16
decision-makers: Joel Hooks
---

# Sandbox leasing for agent environments

## Context and Problem Statement

Agents in the AT Protocol agent network run as Cloudflare Durable Objects — lightweight, always-on, but constrained. DOs have burst CPU limits (30s), no filesystem, no bash, and a 128KB per-value storage cap. This means agents can think, remember, and message, but they cannot execute complex tasks: coding, running game simulations with real tools, or operating with full Pi agent harnesses and skills.

[Epic #59](https://github.com/joelhooks/atproto-agent-network/issues/59) established the vision of a two-tier architecture (DO brain + Sandbox hands). What's missing is the **lease model** — how sandboxes are allocated, bound to environments, kept warm, and reclaimed.

The current failure mode is visible today: agents join a Catan game but produce 0 tool calls because the DO's burst execution can't run a full agent loop with skills, memory retrieval, and multi-step reasoning. The model returns empty responses because the execution context is too thin.

**Key constraint**: Cloudflare Workers have no Redis. Lease state must live in D1 or Durable Object SQLite storage. The `@cloudflare/sandbox` SDK handles sleep/wake automatically — there is no manual `sleep()`/`wake()` API.

Related: [ADR-0001](0001-adopt-architecture-decision-records.md), [Epic #59](https://github.com/joelhooks/atproto-agent-network/issues/59), [joelclaw system-bus](https://github.com/joelhooks/joelclaw) (TTL lease concept, adapted from Redis to D1)

## Decision Drivers

- **Execution capability**: Agents need bash, filesystem, and full Pi coding agent harness to act meaningfully in game and coding environments.
- **Cost efficiency**: CF Sandbox containers cost ~$35/mo always-on vs ~$5-6/mo with sleep-when-idle. With 8+ agents, this matters.
- **Warm latency**: Game turns should resolve in seconds, not 20s cold-start + hydration cycles.
- **Lifecycle binding**: Sandbox lifetime should match environment lifetime — death in RPG = sandbox reclaimed, Catan game ends = sandboxes released.
- **AT Protocol citizenship**: Each sandbox authenticates as its agent's DID, subscribes to relay firehose, posts actions — first-class protocol participant, not a sidecar hack.
- **Real SDK alignment**: Build on the actual `@cloudflare/sandbox` API — `getSandbox()`, automatic sleep/wake via `sleepAfter`, sessions, R2 mount — not fantasy abstractions.

## Considered Options

### Option A: Ephemeral sandboxes — spin up per turn, kill after action

Cold-start a container for each game turn. Load skills, hydrate memory, execute, post result, destroy.

### Option B: Always-on sandboxes — one container per agent, runs 24/7

Each agent gets a persistent container with `keepAlive: true`. Maximum responsiveness, maximum cost (~$35/mo each).

### Option C: Leased sandboxes with automatic idle sleep — bound to environment membership

Agents are "leased" a sandbox when assigned to an environment. The sandbox stays warm (loaded skills, hydrated state) but Cloudflare automatically sleeps it after `sleepAfter` idle timeout. Wakes automatically on next `exec`/`readFile`/etc call (~2-3s). Lease expires when environment conditions are met (death, game end, task complete), at which point we call `sandbox.destroy()`.

## Decision Outcome

Chosen option: **Option C — Leased sandboxes with automatic idle sleep**, because it balances cost ($5-6/mo per agent), latency (warm wake ~2-3s), and lifecycle management (environment-bound leases with condition-based expiry).

### Sandbox Identity Model

Each sandbox is identified by a deterministic ID derived from agent + environment:

```typescript
// Sandbox IDs are deterministic — same ID = same instance
const sandboxId = `${agentDid}::${environmentId}`;
// e.g., "did:cf:slag::rpg_00abc"

const sandbox = getSandbox(env.Sandbox, sandboxId, {
  sleepAfter: "5m",      // auto-sleep after 5min idle
  keepAlive: false,       // allow auto-sleep (cost savings)
  normalizeId: true,      // lowercase for preview URLs
});
```

### Lease Model (D1-backed)

Adapted from [joelclaw's Redis-backed claim system](https://github.com/joelhooks/joelclaw) — same TTL lease concept, but using D1 instead of Redis (no Redis in CF Workers):

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
  status TEXT NOT NULL DEFAULT 'active', -- active | sleeping | expired | destroyed
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

    // Upsert — if lease exists and is active, return it (idempotent)
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
    // Find all leases for this environment that match the condition
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

### Lease Lifecycle

1. **Acquire**: DO calls `leaseManager.acquire()` when agent joins environment → gets `sandboxId`
2. **Get sandbox**: `getSandbox(env.Sandbox, sandboxId, { sleepAfter: "5m" })` — creates or reconnects to existing instance
3. **Hydrate**: On first acquire, mount R2 bucket + write environment-specific config files
4. **Act**: On turn notification, call `sandbox.exec(...)` — Cloudflare auto-wakes if sleeping
5. **Renew**: After each exec, call `leaseManager.renew(sandboxId)` to extend TTL
6. **Auto-sleep**: Cloudflare handles this — after `sleepAfter` idle, container sleeps automatically
7. **Expire**: Condition met (death, game end) → `sandbox.destroy()` + `leaseManager.expire(sandboxId)`

### State Persistence via R2 Mount

Instead of manually reading/writing R2 blobs, mount the R2 bucket directly as a filesystem inside the sandbox:

```typescript
// On sandbox hydration — mount R2 as /data
await sandbox.mountBucket("agent-blobs", "/data", {
  endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  provider: "r2",
  prefix: `/agents/${agentDid}/`,
});

// Now agent state is just files:
// /data/character.json  — RPG character sheet
// /data/memory/         — agent memories
// /data/skills/         — loaded skill definitions
// /data/campaign/       — campaign state

// Agent code reads/writes normally:
await sandbox.exec("cat /data/character.json");
await sandbox.exec("python process_turn.py --state /data/campaign/state.json");
```

### Sessions for Isolated Agent Turns

Use sandbox sessions to isolate individual turns within a shared sandbox:

```typescript
// Each turn gets an isolated exec context
const session = await sandbox.createSession({
  id: `turn-${turnNumber}`,
  env: {
    AGENT_DID: agentDid,
    TURN_NUMBER: String(turnNumber),
    GAME_ID: environmentId,
  },
  cwd: "/workspace",
});

const result = await session.exec("python take_turn.py");

// Clean up after turn
await sandbox.deleteSession(`turn-${turnNumber}`);
```

### Pre-configured Environment Dockerfiles

Each environment type has a custom Dockerfile built by wrangler on deploy:

**RPG Player Sandbox** (`sandboxes/rpg/Dockerfile`):
```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0-python

# RPG-specific Python deps
RUN pip install --no-cache-dir pydantic aiohttp

# Pi agent harness + RPG skills
COPY skills/rpg-player/ /skills/rpg-player/
COPY harness/ /harness/

# Turn processor script
COPY scripts/rpg/take_turn.py /workspace/take_turn.py
COPY scripts/rpg/process_action.py /workspace/process_action.py
```

**Catan Player Sandbox** (`sandboxes/catan/Dockerfile`):
```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0-python

# Catan analysis deps
RUN pip install --no-cache-dir numpy pydantic

COPY skills/catan-player/ /skills/catan-player/
COPY harness/ /harness/
COPY scripts/catan/ /workspace/
```

**Coding Task Sandbox** (`sandboxes/coding/Dockerfile`):
```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0-python

# Full coding environment
RUN npm install -g typescript tsx
RUN pip install --no-cache-dir ruff pytest

COPY skills/coding/ /skills/coding/
COPY harness/ /harness/

# Git config for commits
RUN git config --global user.name "Agent" && \
    git config --global user.email "agent@atproto.network"
```

### Wrangler Configuration Changes

Add to `apps/network/wrangler.toml`:

```toml
# Sandbox Durable Object (container-backed)
[[durable_objects.bindings]]
name = "SANDBOX"
class_name = "Sandbox"

# Container images — wrangler builds these Dockerfiles on deploy
[[containers]]
class_name = "Sandbox"
image = "./sandboxes/default/Dockerfile"
# Note: environment-specific images selected at runtime via sandbox config

# Migration for Sandbox DO (uses SQLite internally)
[[migrations]]
tag = "v2"
new_sqlite_classes = ["Sandbox"]
```

### DO → Sandbox Integration

The Agent DO orchestrates the full lifecycle:

```typescript
// In agent.ts — when agent joins an environment
async onEnvironmentJoin(environmentId: string, envType: string) {
  const leaseManager = new LeaseManager(this.env.DB);

  // 1. Acquire lease
  const { sandboxId, isNew } = await leaseManager.acquire({
    agentDid: this.agentDid,
    environmentId,
    environmentType: envType,
    ttlMs: 24 * 60 * 60 * 1000, // 24h max lease
    sleepAfter: "5m",
    expiryConditions: this.getExpiryConditions(envType),
  });

  // 2. Get sandbox handle (creates or reconnects)
  const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {
    sleepAfter: "5m",
    normalizeId: true,
  });

  // 3. If new, hydrate
  if (isNew) {
    // Mount R2 for persistent state
    await sandbox.mountBucket("agent-blobs", "/data", {
      endpoint: `https://${this.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      provider: "r2",
      prefix: `/agents/${this.agentDid}/`,
    });

    // Clone environment-specific repo/skills
    await sandbox.gitCheckout(
      "https://github.com/joelhooks/atproto-agent-network",
      { branch: "main", depth: 1 }
    );

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
  const sandbox = getSandbox(this.env.SANDBOX, this.currentSandboxId!, {
    sleepAfter: "5m",
  });

  // Sandbox auto-wakes if sleeping — no manual wake() needed
  const session = await sandbox.createSession({
    id: `turn-${turnData.turnNumber}`,
    env: {
      TURN_DATA: JSON.stringify(turnData),
      AGENT_DID: this.agentDid,
    },
    cwd: "/workspace",
  });

  const result = await session.exec("python take_turn.py", {
    timeout: 60000,
    env: { TURN_DATA: JSON.stringify(turnData) },
  });

  await sandbox.deleteSession(`turn-${turnData.turnNumber}`);

  // Renew lease on activity
  const leaseManager = new LeaseManager(this.env.DB);
  await leaseManager.renew(this.currentSandboxId!);

  return JSON.parse(result.stdout);
}

// On environment end — destroy sandbox
async onEnvironmentEnd(environmentId: string, reason: string) {
  const leaseManager = new LeaseManager(this.env.DB);
  const expired = await leaseManager.expireByCondition(environmentId, reason);

  for (const sandboxId of expired) {
    const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {});
    await sandbox.destroy(); // Permanently kill + delete all state
  }
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

### Long-running Processes (Game Servers, Watchers)

For sandboxes that need persistent background processes:

```typescript
// Start a relay watcher as a long-running process
const relayProc = await sandbox.startProcess(
  "node relay-watcher.js --did " + agentDid, 
  { cwd: "/workspace", env: { RELAY_URL: env.RELAY_URL } }
);

// Wait for it to be ready
await relayProc.waitForLog(/Connected to relay/);

// Later: kill it on lease expiry
await sandbox.killProcess(relayProc.id);
```

### Consequences

Good:
- Agents get real execution capability — full Pi harness with skills, bash, filesystem
- Cost stays reasonable (~$5-6/mo per agent with idle sleep vs $35/mo always-on)
- Automatic sleep/wake eliminates manual lifecycle management bugs
- R2 mount gives agents a real filesystem backed by durable storage
- Sessions isolate turns without per-turn container overhead
- D1 lease tracking is queryable, auditable, and transactional
- Environment-bound leases prevent orphaned containers

Bad:
- D1 queries add ~1-5ms latency per lease operation (vs in-memory Redis)
- R2 mount may have higher latency than local filesystem for large reads
- Custom Dockerfiles increase deploy time (wrangler builds images on deploy)
- First wake after extended sleep may take 3-5s

Neutral:
- DOs remain the coordination layer — they decide WHEN to act, sandboxes handle HOW
- No abstraction layer over sandbox backends — we use `@cloudflare/sandbox` directly. If we need Modal/Docker later, we add adapters then, not prematurely.
- Existing relay firehose already supports the subscription pattern — no new protocol needed

## Implementation Plan

### Affected Paths
- `apps/network/migrations/0004_sandbox_leases.sql` — D1 lease table
- `apps/network/src/sandbox/lease-manager.ts` — D1-backed lease acquire/renew/expire
- `apps/network/src/sandbox/sandbox-factory.ts` — `getSandbox()` wrapper with environment config
- `apps/network/src/agent.ts` — integrate sandbox into environment membership
- `sandboxes/rpg/Dockerfile` — RPG player sandbox image
- `sandboxes/catan/Dockerfile` — Catan player sandbox image
- `sandboxes/coding/Dockerfile` — Coding task sandbox image
- `apps/network/wrangler.toml` — Sandbox DO binding, container config, migration

### Stories (GitHub Sub-Issues of #59)

**Phase 1: Foundation**

1. **#138 — Local Docker sandbox for dev/testing** — Set up local development environment with Docker that mirrors CF Sandbox API. Create `docker-compose.yml` with sandbox-compatible container. This is FIRST because everything else needs a local test target.

2. **#129 — D1 lease schema + LeaseManager** — Create `migrations/0004_sandbox_leases.sql` and `src/sandbox/lease-manager.ts` with acquire/renew/expire/expireByCondition. No Executor interface — work directly with D1. Include unit tests with D1 mock.

3. **#131 — Sandbox factory with `getSandbox()` wrapper** — Create `src/sandbox/sandbox-factory.ts` that wraps `getSandbox()` with environment-specific defaults (sleepAfter, R2 mount config). Add SANDBOX DO binding to `wrangler.toml`.

**Phase 2: Environment Templates**

4. **#132 — R2 mount + state persistence** — Implement `mountBucket` call on sandbox hydration. Define state directory conventions (`/data/character.json`, `/data/memory/`, etc). Write hydration and teardown helpers.

5. **#133 — RPG player sandbox template** — Create `sandboxes/rpg/Dockerfile`, RPG turn processor scripts, skill loader. Test with local Docker from #138.

6. **#134 — Catan player sandbox template** — Create `sandboxes/catan/Dockerfile`, Catan-specific scripts, board analysis tools.

7. **#136 — Coding task sandbox template** — Create `sandboxes/coding/Dockerfile`, git clone flow, push via control-plane pusher (#101).

**Phase 3: Integration**

8. **#135 — DO→Sandbox integration** — Wire `onEnvironmentJoin`/`onTurnNotification`/`onEnvironmentEnd` in agent.ts. Use LeaseManager + sandbox factory. Sessions for isolated turns.

9. **#137 — Cost management + dashboard** — Query D1 lease table for container-hours per agent. Budget limits in lease acquire. Admin API endpoint.

10. **(Removed old #130 — Redis lease manager. Replaced by #129 with D1.)**

### Dependency Order
```
#138 (local Docker) ──┐
                      ├──► #129 (D1 leases) ──► #131 (sandbox factory) ──┐
                      │                                                    │
                      │    #132 (R2 mount) ◄──────────────────────────────┘
                      │         │
                      │    #133 (RPG) ──────┐
                      │    #134 (Catan) ────┼──► #135 (DO integration) ──► #137 (cost)
                      │    #136 (Coding) ───┘
                      │
```

### Tests
- Unit: LeaseManager acquire/renew/expire with D1 mock
- Unit: Sandbox factory creates correct config per environment type
- Integration: Spawn sandbox, exec command, verify output (local Docker)
- Integration: R2 mount reads/writes persist across sleep/wake
- Integration: Session isolation — two sessions don't share env vars
- E2E: Agent joins RPG → sandbox spawned → turn taken → action posted via AT Proto

## Verification

- [ ] D1 migration creates `sandbox_leases` table with correct schema
- [ ] LeaseManager.acquire is idempotent — duplicate acquire returns existing lease
- [ ] Lease TTL expires after configured duration; `getExpiredLeases()` finds them
- [ ] `expireByCondition("game.finished")` destroys all matching leases for an environment
- [ ] `getSandbox()` with same ID returns same instance (verified by writing then reading a file)
- [ ] `sleepAfter: "5m"` causes automatic sleep (verified in local Docker by checking container state)
- [ ] R2 mountBucket makes agent state accessible at `/data/` inside sandbox
- [ ] Sessions provide isolated exec contexts (env vars from session A not visible in session B)
- [ ] `sandbox.destroy()` permanently removes all sandbox state
- [ ] RPG sandbox Dockerfile builds and can execute `python take_turn.py`
- [ ] Cost tracking query returns accurate container-hours per agent
- [ ] Budget limit in lease acquire prevents spawn when exceeded

## More Information

- [Epic #59](https://github.com/joelhooks/atproto-agent-network/issues/59) — original Cloudflare Sandbox epic
- [joelclaw system-bus](https://github.com/joelhooks/joelclaw/tree/main/packages/system-bus) — TTL lease concept (adapted from Redis to D1)
- [joelclaw ADR-0010](https://github.com/joelhooks/joelclaw/blob/main/docs/decisions/0010-system-loop-gateway.md) — SENSE→ORIENT→DECIDE→ACT→LEARN gateway pattern
- [CF Sandbox docs](https://developers.cloudflare.com/sandbox/) — `@cloudflare/sandbox` SDK reference
- [`getSandbox()` API](https://developers.cloudflare.com/sandbox/api/) — lifecycle, exec, files, sessions, R2 mount
- [CF Sandbox pricing](https://developers.cloudflare.com/containers/pricing/) — ~$35/mo 24/7, ~$5-6/mo with idle sleep
