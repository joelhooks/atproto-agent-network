---
name: Epic
about: Parent issue containing multiple subtasks
title: 'Epic: '
labels: 'type/epic'
assignees: ''
---

## Epic: [Title]

**Phase:** 
**Estimated Duration:** 
**HITL Gate:** Yes / No

---

## Agent Workflow (How This Epic Ships)

This epic should be decomposed into `type/task` issues that are executable by agents end-to-end.

**Task lifecycle labels:**
- `agent/ready`: good task spec; safe to claim
- `agent/claimed`: an agent is actively working it
- `agent/review`: done, needs human review
- `agent/blocked`: blocked on human input

**Rules:**
- A task is not `agent/ready` unless it includes: acceptance criteria, validation command(s), file targets, and any HITL/security gates.
- Closed tasks must not retain `agent/*` labels.
- If a task is superseded, close it and link the replacement issue in the close comment.

## Goal

[What does completing this epic achieve?]

## Context

[Why are we doing this? What problem does it solve?]

---

## Subtasks

Track progress by checking boxes as tasks complete:

### Foundation
- [ ] #XX — [Task title]
- [ ] #XX — [Task title]

### Core Implementation  
- [ ] #XX — [Task title]
- [ ] #XX — [Task title]

### Integration
- [ ] #XX — [Task title]

---

## Acceptance Criteria

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

## Security Gate Checklist (if applicable)

- [ ] No plaintext in storage
- [ ] Encryption verified
- [ ] Key management secure
- [ ] Access controls implemented

---

## Dependencies

**Blocked by:**
- [ ] #XX — [Epic/task that must complete first]

**Blocks:**
- [ ] #XX — [Epic/task waiting on this]

---

## Definition of Done

- [ ] All subtasks completed and closed
- [ ] All tests passing
- [ ] Security gate passed (if applicable)
- [ ] Documentation updated
- [ ] Retrospective created
- [ ] All closed subtasks have agent lifecycle labels cleared (`agent/*`)

## Notes

[Any additional context, decisions, or references]

---

## Progress Log

<!-- Add updates as work progresses -->

**[Date]** — [Update]
