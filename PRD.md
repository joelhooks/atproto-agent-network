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

### Meta Issues (Gardening)
| Purpose | Issue |
|---------|-------|
| Sprint Retrospective | [#20](https://github.com/joelhooks/atproto-agent-network/issues/20) |
| Sprint Planning | [#21](https://github.com/joelhooks/atproto-agent-network/issues/21) |
| Backlog Grooming | [#22](https://github.com/joelhooks/atproto-agent-network/issues/22) |
| Update Affected Issues | [#23](https://github.com/joelhooks/atproto-agent-network/issues/23) |

---

## Current Sprint: Testing Foundation

**Goal:** Vitest + CI working across monorepo  
**Estimated:** 1.5 hours  
**HITL Gate:** None (proceed when green)

### Stories (in execution order)

| # | Story | Issue | Validation | Files |
|---|-------|-------|------------|-------|
| 1 | Install Vitest | [#24](https://github.com/joelhooks/atproto-agent-network/issues/24) | `bun test` runs | `package.json`, `vitest.config.ts` |
| 2 | First unit test | [#25](https://github.com/joelhooks/atproto-agent-network/issues/25) | identity.test passes | `packages/core/src/identity.test.ts` |
| 3 | Workspace config | [#26](https://github.com/joelhooks/atproto-agent-network/issues/26) | package tests work | `vitest.workspace.ts` |
| 4 | Turbo test task | [#27](https://github.com/joelhooks/atproto-agent-network/issues/27) | `bun turbo test` | `turbo.json` |
| 5 | CI workflow | [#18](https://github.com/joelhooks/atproto-agent-network/issues/18) | `.github/workflows/ci.yml` exists | CI runs on push |

### Next Sprint: Crypto Primitives

| # | Story | Issue | Validation |
|---|-------|-------|------------|
| 1 | generateX25519Keypair | [#28](https://github.com/joelhooks/atproto-agent-network/issues/28) | crypto.test passes |
| 2 | generateEd25519Keypair | [#29](https://github.com/joelhooks/atproto-agent-network/issues/29) | crypto.test passes |
| 3 | exportPublicKey | [#30](https://github.com/joelhooks/atproto-agent-network/issues/30) | multibase export works |
| 4 | deriveSharedSecret | [#31](https://github.com/joelhooks/atproto-agent-network/issues/31) | ECDH derivation works |

**HITL Gate:** Security review required before Phase 1 completion.

---

## Standard Operating Procedure (SOP)

### 1. Starting a Work Session

```bash
cd ~/Code/joelhooks/atproto-agent-network

# 1. Check current state
gh issue list --label "agent/ready" --limit 10
cat prd.json | jq '.stories[0:3]'

# 2. Read context
cat PRD.md          # This file
cat AGENTS.md       # Development guide
cat PI-POC.md       # Implementation plan (if doing Phase 1+)

# 3. Claim next story
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
│  │         │ - Touch test file                                   │
│  │         │ - Write test cases from issue checklist             │
│  │         │ - Run: bun test <file> → MUST FAIL                  │
│  └────┬────┘                                                     │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────┐                                                     │
│  │  GREEN  │ Minimal code to pass                               │
│  │         │ - Implement ONLY what tests require                 │
│  │         │ - No premature optimization                         │
│  │         │ - Run: bun test <file> → MUST PASS                  │
│  │         │ - Commit: git commit -m "test(...): ..."            │
│  └────┬────┘                                                     │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────┐                                                     │
│  │REFACTOR │ Clean up                                            │
│  │         │ - Extract patterns                                  │
│  │         │ - Add JSDoc                                         │
│  │         │ - Run: bun turbo typecheck                          │
│  │         │ - Commit: git commit -m "refactor(...): ..."        │
│  └─────────┘                                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Commit Convention

```bash
# Tests
git commit -m "test(core): add identity.ts tests"

# Implementation
git commit -m "feat(core): implement generateX25519Keypair"

# Refactor
git commit -m "refactor(core): extract key encoding helpers"

# Close issue
git commit -m "feat(core): complete crypto primitives

Closes #28, #29, #30, #31"
```

### 3. Validation Commands

Each story in `prd.json` has a `validationCommand`. Run it before marking done:

```bash
# Example: Check prd.json for validation
cat prd.json | jq '.stories[] | select(.id == "install-vitest") | .validationCommand'

# Run it
eval $(cat prd.json | jq -r '.stories[] | select(.id == "install-vitest") | .validationCommand')
```

### 4. Completing a Story

```bash
# 1. Run validation
bun turbo test
bun turbo typecheck

# 2. Create PR (if not already done)
gh pr create --title "feat(core): [description]" --body "Closes #X

## Changes
- [what changed]

## Tests
- [new test files]
"

# 3. Update issue labels
gh issue edit <number> --remove-label "agent/claimed" --add-label "agent/review"

# 4. Update parent epic checkbox
gh issue view <parent-epic> --json body  # Check current state
gh issue comment <parent-epic> --body "✅ Completed #X - [summary]"
```

### 5. Gardening (After Each Sprint)

After completing a sprint, run gardening tasks:

```bash
# 1. Update affected issues (#23)
gh issue list --label "agent/blocked"
# For each: check if now unblocked
gh issue edit <number> --remove-label "agent/blocked" --add-label "agent/ready"

# 2. Backlog grooming (#22)
gh issue list --state open --limit 50 --json number,title,labels,createdAt

# 3. Create retrospective (#20 template)
gh issue create --title "[Retro] Sprint: Testing Foundation" \
  --label "loop/retro" --label "loop/meta" \
  --body "## What went well
- 

## What went poorly
- 

## Process improvements
- 

## Next sprint adjustments
- "

# 4. Plan next sprint (#21 template)
cat prd.json | jq '.sprints[1]'  # Next sprint
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

### Loop/Meta
| Label | Meaning |
|-------|---------|
| `loop/meta` | Project maintenance, not code |
| `loop/retro` | Retrospective |
| `loop/planning` | Sprint planning |
| `loop/grooming` | Backlog maintenance |
| `loop/testing` | Testing infrastructure |

### Type
| Label | Meaning |
|-------|---------|
| `type/epic` | Contains subtasks |
| `type/task` | Individual work item |
| `type/bug` | Something broken |
| `type/security` | Security-related |

### Phase
| Label | Phase |
|-------|-------|
| `phase/1-single-agent` | Encrypted single agent |
| `phase/2-semantic-memory` | Vectorize + search |
| `phase/3-multi-agent` | Agent coordination |
| `phase/4-federation` | Sharing + federation |
| `phase/5-polish` | Docs + UX |

### HITL Gates
| Label | Meaning |
|-------|---------|
| `hitl/security-gate` | Requires security review |

---

## HITL Checkpoints

**Do not proceed past these without Oracle approval:**

### Phase 1 Gate
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
    "maxIterations": 12,
    "validationTimeout": 60,
    "autoCommit": true,
    "commitPrefix": "feat|test|chore",
    "branchPrefix": "feat/",
    "onStoryComplete": {
      "updateParentCheckbox": true,
      "addPRLink": true
    },
    "retrospective": {
      "enabled": true,
      "afterSprint": true,
      "issueTemplate": 20
    },
    "gardening": {
      "updateBlockedIssues": true,
      "closeParentWhenChildrenDone": true
    }
  }
}
```

### Running the Loop

```bash
# Initialize Ralph (if not done)
ralph_init --workdir ~/Code/joelhooks/atproto-agent-network --projectName atproto-agent-network

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
├── prd.json             # Machine-readable stories
├── progress.txt         # Ralph loop progress log
│
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── task.md      # Agent-ready task template
│   │   ├── epic.md      # Epic template
│   │   └── bug.md       # Bug report template
│   └── workflows/
│       └── ci.yml       # CI pipeline
│
├── .agents/
│   └── skills/          # Skills for this project
│       ├── cloudflare-do/
│       ├── pi-agent/
│       ├── envelope-encryption/
│       ├── d1-patterns/
│       ├── vectorize-search/
│       └── zap-cli/
│
├── packages/
│   ├── core/            # Types, crypto, lexicons
│   ├── agent/           # Pi wrapper, encrypted memory
│   ├── cli/             # zap CLI
│   └── dashboard/       # React dashboard
│
└── apps/
    └── network/         # Cloudflare Workers + DO
```

---

## Skills Reference

Load a skill before working on its domain:

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
# View ready issues
gh issue list --label "agent/ready"

# Claim issue
gh issue edit 24 --remove-label "agent/ready" --add-label "agent/claimed"

# Complete issue
gh issue edit 24 --remove-label "agent/claimed" --add-label "agent/review"

# Run tests
bun turbo test

# Type check
bun turbo typecheck

# Create PR
gh pr create --title "feat(core): ..." --body "Closes #24"

# View sprint
cat prd.json | jq '.sprints[0]'

# Next story
cat prd.json | jq '.stories[] | select(.id == "<next-id>")'
```

---

*Last updated: 2026-02-07*
