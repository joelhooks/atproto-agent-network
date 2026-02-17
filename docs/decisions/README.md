# Architecture Decision Records (ADR)

An Architecture Decision Record (ADR) captures an important architecture decision along with its context and consequences.

## Conventions

- Directory: `docs/decisions`
- Naming:
  - Prefer numbered files when starting fresh: `0001-choose-database.md`
  - If the repo already uses slug-only names, keep that: `choose-database.md`
- Status values: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded`

## Workflow

- Create a new ADR as `proposed`.
- Discuss and iterate.
- When the team commits: mark it `accepted` (or `rejected`).
- If replaced later: create a new ADR and mark the old one `superseded` with a link.

## ADRs

- [Adopt architecture decision records](0001-adopt-architecture-decision-records.md) (accepted, 2026-02-14)
- [Refactor RPG monolith into interface-driven modules](0002-refactor-rpg-monolith-into-interface-driven-modules.md) (proposed, 2026-02-14)
- [Sandbox leasing for agent environments](0003-sandbox-leasing-for-agent-environments.md) (proposed, 2026-02-16)