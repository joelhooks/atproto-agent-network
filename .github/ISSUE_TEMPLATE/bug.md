---
name: Bug
about: Something is broken
title: 'Bug: '
labels: 'type/bug'
assignees: ''
---

## Bug: [Title]

**Package:** `packages/` or `apps/`
**Severity:** Critical / High / Medium / Low
**Reproducible:** Always / Sometimes / Rarely

---

## Description

[What is broken?]

## Expected Behavior

[What should happen?]

## Actual Behavior

[What actually happens?]

---

## Reproduction Steps

1. 
2. 
3. 

## Environment

- **Node/Bun version:** 
- **OS:** 
- **Branch:** 
- **Commit:** 

---

## Error Output

```
[Paste error messages, stack traces, or logs here]
```

---

## TDD Fix Approach

### 1. Write Regression Test (RED)

```bash
# Create or update test file
touch packages/[pkg]/src/[feature].test.ts
```

**Test case to add:**
```typescript
test('should [expected behavior]', () => {
  // Reproduce the bug condition
  // Assert expected behavior
})
```

### 2. Fix (GREEN)

**Files likely affected:**
- [ ] `packages/[pkg]/src/[file].ts`

### 3. Verify Fix

```bash
# Run the regression test
bun test packages/[pkg]/src/[feature].test.ts

# Run full suite to check for regressions
bun turbo test
```

---

## Acceptance Criteria

- [ ] Bug is reproduced in a test (test fails before fix)
- [ ] Fix implemented
- [ ] Test passes after fix
- [ ] No regressions in other tests
- [ ] Root cause documented

## Root Cause

[After fixing, document what caused the bug]

---

## Related Issues

- #XX — [Related issue]
