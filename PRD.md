# PRD.md — ⚡ AT Protocol Agent Network

> **The single source of truth for Ralph loop execution.**
> 
> This document links directly to GitHub issues, contains SOP instructions, and defines the autonomous development workflow.

**Repository:** https://github.com/joelhooks/atproto-agent-network  
**Project Board:** https://github.com/users/joelhooks/projects/1

---

## Quick Links

### Epics
| Phase | Epic | Status | Security Gate |
|-------|------|--------|---------------|
| 0 | [#13 Testing Infrastructure](https://github.com/joelhooks/atproto-agent-network/issues/13) | 🟡 In Progress | — |
| 1 | [#1 Encrypted Single Agent](https://github.com/joelhooks/atproto-agent-network/issues/1) | ⬜ Blocked on #13 | No plaintext in D1 |
| 2 | [#2 Semantic Memory](https://github.com/joelhooks/atproto-agent-network/issues/2) | ⬜ Future | Search on embeddings only |
| 3 | [#3 Multi-Agent](https://github.com/joelhooks/atproto-agent-network/issues/3) | ⬜ Future | E2E agent encryption |
| 4 | [#4 Federation](https://github.com/joelhooks/atproto-agent-network/issues/4) | ⬜ Future | Private-by-default sharing |
| 5 | [#5 Polish](https://github.com/joelhooks/atproto-agent-network/issues/5) | ⬜ Future | — |

### Container Issues (DO NOT CLAIM DIRECTLY)
| Issue | Contains | Status |
|-------|----------|--------|
| [#7 X25519 Key Generation](https://github.com/joelhooks/atproto-agent-network/issues/7) | #28, #29, #30, #31 | Work on children |
| [#14 Setup Vitest](https://github.com/joelhooks/atproto-agent-network/issues/14) | #24, #25, #26, #27 | Work on children |

### Meta Issues (Gardening)
| Purpose | Issue |
|---------|-------|
| Sprint Retrospective | [#20](https://github.com/joelhooks/atproto-agent-network/issues/20) |
| Sprint Planning | [#21](https://github.com/joelhooks/atproto-agent-network/issues/21) |
| Backlog Grooming | [#22](https://github.com/joelhooks/atproto-agent-network/issues/22) |
| Update Affected Issues | [#23](https://github.com/joelhooks/atproto-agent-network/issues/23) |

---

## 🤖 Ralph Loop Rules

### Issue Categories

| Type | Label | Agent Behavior |
|------|-------|----------------|
| **Leaf task** | `type/task` + `agent/ready` | ✅ Claim and execute |
| **Container** | `type/container` | ❌ Never claim — work on children |
| **Epic** | `type/epic` | ❌ Never claim — tracking only |
| **Meta** | `loop/meta` | ✅ Execute during gardening phase |

### Story Selection Algorithm

```
1. Query: gh issue list --label "agent/ready" --state open
2. Filter: Exclude type/container, type/epic
3. Sort: By priority in prd.json (lower = higher priority)
4. Check: dependsOn satisfied (all deps closed or in prd.json before this)
5. Select: First issue passing all checks
```

### Validation Failures

If validation fails:
1. **Retry once** with fix attempt
2. **On 2nd failure:** Add `agent/blocked` label
3. **Comment with:** Failure log + what was tried
4. **Move to:** Next story in queue
5. **If all stories blocked:** Ping Oracle with full status

### Story Skip Conditions

Skip a story if:
- Missing `agent/ready` label
- Has `agent/blocked` label  
- Has `type/container` or `type/epic` label
- Has unmet `dependsOn` (check via prd.json)
- Parent epic is closed

### Branch Strategy

```bash
# Each story gets a branch from main
git checkout main && git pull
git checkout -b feat/<issue-number>-<short-name>

# Work on branch
# ... commits ...

# Push and create PR
git push -u origin HEAD
gh pr create --title "feat(pkg): <title>" --body "Closes #<number>"
```

### Dependency Resolution

Stories in `prd.json` have `dependsOn` arrays:

```json
{
  "id": "envelope-encryption",
  "dependsOn": ["derive-shared-secret"]
}
```

**Resolution rules:**
1. Check if dependency story is marked `passes: true` in prd.json
2. OR check if dependency issue is closed on GitHub
3. If neither, story is blocked

---

## Sprints

### Sprint 0: Bootstrap
| Story | Issue | Validation | Est. |
|-------|-------|------------|------|
| Setup monorepo | [#6](https://github.com/joelhooks/atproto-agent-network/issues/6) | `bun turbo build --dry-run` | 10m |

### Sprint 1: Testing Foundation
| Story | Issue | Validation | Est. |
|-------|-------|------------|------|
| Install Vitest | [#24](https://github.com/joelhooks/atproto-agent-network/issues/24) | `bun test --passWithNoTests` | 15m |
| First unit test | [#25](https://github.com/joelhooks/atproto-agent-network/issues/25) | `bun test identity.test` | 20m |
| Workspace config | [#26](https://github.com/joelhooks/atproto-agent-network/issues/26) | Package tests work | 15m |
| Turbo test task | [#27](https://github.com/joelhooks/atproto-agent-network/issues/27) | `bun turbo test` | 15m |
| Test utilities | [#15](https://github.com/joelhooks/atproto-agent-network/issues/15) | Fixtures work | 25m |
| CI workflow | [#18](https://github.com/joelhooks/atproto-agent-network/issues/18) | `.github/workflows/ci.yml` | 20m |
| Pre-commit hooks | [#19](https://github.com/joelhooks/atproto-agent-network/issues/19) | Hooks trigger | 15m |

### Sprint 2: Crypto Primitives
| Story | Issue | Validation | Est. |
|-------|-------|------------|------|
| generateX25519Keypair | [#28](https://github.com/joelhooks/atproto-agent-network/issues/28) | crypto.test passes | 30m |
| generateEd25519Keypair | [#29](https://github.com/joelhooks/atproto-agent-network/issues/29) | crypto.test passes | 20m |
| exportPublicKey | [#30](https://github.com/joelhooks/atproto-agent-network/issues/30) | multibase works | 30m |
| deriveSharedSecret | [#31](https://github.com/joelhooks/atproto-agent-network/issues/31) | ECDH works | 20m |
| Envelope encryption | [#8](https://github.com/joelhooks/atproto-agent-network/issues/8) | encrypt/decrypt roundtrip | 45m |

**🚨 HITL Gate:** Security review required after this sprint.

### Sprint 3: Encrypted Storage
| Story | Issue | Validation | Est. |
|-------|-------|------------|------|
| D1 schema | [#9](https://github.com/joelhooks/atproto-agent-network/issues/9) | Schema valid | 30m |
| Pi agent wrapper | [#10](https://github.com/joelhooks/atproto-agent-network/issues/10) | Agent tests pass | 45m |
| EncryptedMemory | [#11](https://github.com/joelhooks/atproto-agent-network/issues/11) | Memory tests pass | 60m |
| Wire up AgentDO | [#12](https://github.com/joelhooks/atproto-agent-network/issues/12) | Integration works | 60m |

**🚨 HITL Gate:** Phase 1 complete — verify no plaintext in D1.

### Sprint 4: Advanced Testing
| Story | Issue | Validation | Est. |
|-------|-------|------------|------|
| Integration harness | [#16](https://github.com/joelhooks/atproto-agent-network/issues/16) | D1 mock works | 45m |
| E2E harness | [#17](https://github.com/joelhooks/atproto-agent-network/issues/17) | Miniflare works | 60m |

---

## Standard Operating Procedure (SOP)

### 1. Starting a Work Session

```bash
cd ~/Code/joelhooks/atproto-agent-network

# 1. Pull latest
git checkout main && git pull

# 2. Check current state
gh issue list --label "agent/ready" --limit 10
cat prd.json | jq '.stories | map(select(.passes != true)) | .[0:3]'

# 3. Read context
cat PRD.md          # This file
cat AGENTS.md       # Development guide

# 4. Claim next ready story (NOT container/epic)
gh issue edit <number> --remove-label "agent/ready" --add-label "agent/claimed"
```

### 2. TDD Execution (The Loop)

Every story follows **RED → GREEN → REFACTOR**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        TDD CYCLE                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────┐                                                     │
│  │   RED   │ Write failing test first                           │
│  │         │ - Copy test code from issue body                    │
│  │         │ - Run: bun test <file> → MUST FAIL                  │
│  └────┬────┘                                                     │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────┐                                                     │
│  │  GREEN  │ Minimal code to pass                               │
│  │         │ - Copy implementation from issue body               │
│  │         │ - Adapt as needed                                   │
│  │         │ - Run: bun test <file> → MUST PASS                  │
│  └────┬────┘                                                     │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────┐                                                     │
│  │REFACTOR │ Clean up                                            │
│  │         │ - Run: bun turbo typecheck                          │
│  │         │ - Commit: git commit -m "feat(...): ..."            │
│  └─────────┘                                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Validation

Each story in `prd.json` has a `validationCommand`:

```bash
# Get validation command for a story
cat prd.json | jq -r '.stories[] | select(.issue == 24) | .validationCommand'

# Run it
eval "$(cat prd.json | jq -r '.stories[] | select(.issue == 24) | .validationCommand')"
```

### 4. Completing a Story

```bash
# 1. Run full validation
bun turbo test
bun turbo typecheck

# 2. Commit with issue reference
git add -A
git commit -m "feat(pkg): description

Closes #<number>"

# 3. Push and create PR
git push -u origin HEAD
gh pr create --title "feat(pkg): description" --body "Closes #<number>

## Changes
- Added tests for X
- Implemented X

## Validation
\`\`\`
<paste validation output>
\`\`\`
"

# 4. Update issue labels
gh issue edit <number> --remove-label "agent/claimed" --add-label "agent/review"

# 5. Update parent epic/container
gh issue comment <parent> --body "✅ Completed #<number> - <summary>"
```

### 5. Gardening (After Each Sprint)

```bash
# 1. Check for newly unblocked issues
gh issue list --label "agent/blocked"
# For each: check if deps are now met
gh issue edit <number> --remove-label "agent/blocked" --add-label "agent/ready"

# 2. Update prd.json (mark completed stories)
# Edit prd.json, set "passes": true for completed stories

# 3. Create retrospective
gh issue create --title "[Retro] Sprint: <name>" \
  --label "loop/retro" --label "loop/meta" \
  --body "## What went well
- 

## What went poorly
- 

## Process improvements
- "
```

---

## Label Reference

### Agent Workflow
| Label | Meaning | Color |
|-------|---------|-------|
| `agent/ready` | Ready for agent to claim | 🟢 Green |
| `agent/claimed` | Agent is working on it | 🟡 Yellow |
| `agent/blocked` | Waiting on dependency | 🔴 Red |
| `agent/review` | Awaiting human review | 🟣 Purple |

### Issue Type
| Label | Meaning | Claimable? |
|-------|---------|------------|
| `type/task` | Individual work item | ✅ Yes |
| `type/container` | Has subtasks | ❌ No |
| `type/epic` | Phase-level tracking | ❌ No |
| `type/bug` | Something broken | ✅ Yes |
| `type/security` | Security-related | ✅ Yes (careful) |

### Loop/Meta
| Label | Meaning |
|-------|---------|
| `loop/meta` | Project maintenance |
| `loop/retro` | Retrospective |
| `loop/planning` | Sprint planning |
| `loop/grooming` | Backlog maintenance |
| `loop/testing` | Testing infrastructure |

### HITL Gates
| Label | Meaning |
|-------|---------|
| `hitl/security-gate` | Requires security review before proceeding |

---

## HITL Checkpoints

**Do not proceed past these without Oracle approval:**

### Phase 1 Gate (After Sprint 3)
- [ ] All memories encrypted (verify with D1 query)
- [ ] No plaintext in any table
- [ ] Key generation tests pass
- [ ] Encryption/decryption round-trip works

### Phase 2 Gate
- [ ] Search works on embeddings only
- [ ] Decryption only on explicit retrieval
- [ ] No content in Vectorize metadata

### Phase 3 Gate
- [ ] E2E encryption between agents
- [ ] Key exchange protocol verified
- [ ] No shared secrets in logs

### Phase 4 Gate
- [ ] Sharing requires explicit opt-in
- [ ] Public records clearly marked
- [ ] Revocation works

---

## Ralph Loop Configuration

From `prd.json`:

```json
{
  "loopConfig": {
    "maxIterations": 20,
    "validationTimeout": 120,
    "autoCommit": true,
    "onStoryFail": {
      "maxRetries": 2,
      "addBlockedLabel": true,
      "commentWithLog": true
    }
  }
}
```

### Running the Loop

```bash
# Check status
ralph_status --workdir ~/Code/joelhooks/atproto-agent-network

# Run single iteration
ralph_iterate --workdir ~/Code/joelhooks/atproto-agent-network

# Run full loop (background)
ralph_loop --workdir ~/Code/joelhooks/atproto-agent-network --maxIterations 5
```

---

## File Structure

```
atproto-agent-network/
├── PRD.md               # THIS FILE - execution source of truth
├── AGENTS.md            # Development guide
├── PI-POC.md            # Implementation plan
├── prd.json             # Machine-readable stories (Ralph reads this)
├── progress.txt         # Ralph loop progress log
│
├── .github/
│   └── workflows/
│       └── ci.yml       # CI pipeline
│
├── .agents/
│   └── skills/          # Project-specific skills
│
├── packages/
│   ├── core/            # Types, crypto, lexicons
│   └── agent/           # Pi wrapper, encrypted memory
│
└── apps/
    └── network/         # Cloudflare Workers + DO
```

---

## Skills Reference

```bash
# Read skill before implementing
cat .agents/skills/<skill-name>/SKILL.md
```

| Skill | When | Issue Tags |
|-------|------|------------|
| `envelope-encryption` | Crypto work | `type/security`, `pkg/core` |
| `cloudflare-do` | Durable Objects | `pkg/network` |
| `pi-agent` | Agent runtime | `pkg/agent` |
| `d1-patterns` | Database | `pkg/network` |
| `vectorize-search` | Embeddings | Phase 2+ |
| `zap-cli` | Observability | `pkg/cli` |

---

## Quick Commands

```bash
# View ready issues (excludes containers/epics)
gh issue list --label "agent/ready" -L 20 | grep -v "type/container\|type/epic"

# Claim issue
gh issue edit <N> --remove-label "agent/ready" --add-label "agent/claimed"

# Complete issue  
gh issue edit <N> --remove-label "agent/claimed" --add-label "agent/review"

# Check story in prd.json
cat prd.json | jq '.stories[] | select(.issue == <N>)'

# Run validation for story
eval "$(cat prd.json | jq -r '.stories[] | select(.issue == <N>) | .validationCommand')"
```

---

*Last updated: 2026-02-07*
