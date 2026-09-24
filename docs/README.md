# Prism docs

Start with the [root README](../README.md#quick-start). These documents go deeper: workflows first, then installing agents, skills, and tools into each harness.

## Workflows

- [`workflows.md`](workflows.md) — **the full DSL reference**: `defineTask`/`defineWorkflow`/`phase` field by field, workers, permissions, model resolution, finish criteria, cache, and the run CLI
- [`workflow-orbs.md`](workflow-orbs.md) — orb test matrix, live Amp/Claude/Jev smoke commands, and scheduling versus pause/wake boundaries
- [`workflow-data-governance.md`](workflow-data-governance.md) — what the run store persists, and how it is governed
- [`workflow-scheduling.md`](workflow-scheduling.md) — run a workflow on a schedule

## Installing into harnesses

- [`tools-architecture.md`](tools-architecture.md) — tools: define once, call from any harness with `prism tools invoke`
- [`third-party-skills.md`](third-party-skills.md) — pin skills from other Git repos
- [`lowerer-capability-matrix.md`](lowerer-capability-matrix.md) — per-harness support matrix: which surfaces each harness gets, and which targets are live-proven versus compile-verified
- [`sdk-contract.md`](sdk-contract.md) — the `@skastr0/prism-sdk` public contract: compile manifest, refs, snapshot, stable JSON
- [`artifact-contracts.md`](artifact-contracts.md) — generated artifact shapes per surface kind
- [`hook-contract.md`](hook-contract.md) — hook events, matchers, and degradation semantics
- [`skillspaces.md`](skillspaces.md) — skill targeting across harnesses

## Operations & release

- [`release-train.md`](release-train.md) — how releases cut and publish
- [`workflow-production-readiness-audit-2026-07-21.md`](workflow-production-readiness-audit-2026-07-21.md) — workflow hardening audit and release rules
- [`hooks-harness-audit.md`](hooks-harness-audit.md) — hook behavior audited per harness
- [`agent-skill-integration-tests.md`](agent-skill-integration-tests.md) — integration-test coverage for agent/skill surfaces
