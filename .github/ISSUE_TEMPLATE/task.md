---
name: Task
about: Agent-ready task with full context for Ralph loop execution
title: ''
labels: 'type/task'
assignees: ''
---

## Task: [Title]

**Parent Epic:** #
**Package:** `packages/` or `apps/`
**Skill:** `.agents/skills/[skill-name]`
**GitHub Issue:** #[number] (required for commits)

---

## Agent Lifecycle (Label + Status Rules)

**Starting state (triage):**
- Label: `agent/ready` means any agent can pick this up.
- If this needs human input before work can start, use `agent/blocked` and add `hitl/*` label(s).

**When an agent claims the task:**
1. Remove `agent/ready`
2. Add `agent/claimed`
3. (Optional) Assign the issue to the agent identity (if used)

**When the agent is done and wants review:**
1. Remove `agent/claimed`
2. Add `agent/review`
3. Ensure there is a PR link (or a note explaining why there isn't)

**When the task is blocked mid-flight:**
1. Add `agent/blocked`
2. Add `hitl/decision` or `hitl/architecture` or `hitl/security-gate`
3. Post a single comment with the exact question(s) and what was tried

**On close:**
- Remove any of: `agent/ready`, `agent/claimed`, `agent/review`, `agent/blocked`
- If closed without merge, explain why (superseded, wontfix, duplicate) and link the replacement issue.

---

## Context

[Brief description of what this task accomplishes and why it matters]

## TDD Instructions

### 1. Write Tests First (RED)

```bash
# Create test file
touch packages/[pkg]/src/[feature].test.ts
```

**Test cases to implement:**
- [ ] Test case 1: [description]
- [ ] Test case 2: [description]
- [ ] Test case 3: [description]

```typescript
// Example test structure
describe('[Feature]', () => {
  test('[case 1]', () => {
    // Arrange
    // Act
    // Assert
  })
})
```

### 2. Implement (GREEN)

**Files to create/modify:**
- [ ] `packages/[pkg]/src/[file].ts`

**Implementation notes:**
- [Key consideration 1]
- [Key consideration 2]

### 3. Refactor (REFACTOR)

- [ ] Extract common patterns
- [ ] Add JSDoc comments
- [ ] Ensure no lint errors: `bun run typecheck`

---

## Acceptance Criteria

- [ ] All tests pass: `bun test packages/[pkg]`
- [ ] Types check: `bun turbo typecheck`
- [ ] No regressions in existing tests
- [ ] [Specific criterion 1]
- [ ] [Specific criterion 2]

## Security Checklist (if applicable)

- [ ] No secrets in code
- [ ] No plaintext where encryption expected
- [ ] Input validation present
- [ ] Error messages don't leak internals

---

## Definition of Done

- [ ] Tests written first (TDD)
- [ ] Implementation complete
- [ ] All tests pass
- [ ] Types check
- [ ] PR opened with description (or explicit rationale for no PR)
- [ ] Update affected issues (link to this)
- [ ] Close with reason explaining what was done

## Agent Notes

**Before starting:**
1. Read the skill: `.agents/skills/[skill-name]/SKILL.md`
2. Read existing code in the package
3. Run existing tests to verify baseline

**During work:**
- Commit after each test passes
- Keep commits small and focused
- Use conventional commits: `feat:`, `test:`, `fix:`
- Every commit must reference the issue number:
  - Title: `feat(pkg): summary (#N)` is fine
  - Body: must include `Closes #N` (mandatory)

**After completing:**
- Run full test suite: `bun turbo test`
- Update this issue with any learnings
- Update parent epic checkbox
