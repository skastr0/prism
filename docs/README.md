# Prism docs

Start with the [root README](../README.md) for the product tour. These documents go deeper on specific contracts and subsystems.

## Architecture & contracts

- [`tools-architecture.md`](tools-architecture.md) — the tool model: canonical tools, trait permissions, tool-owned slots, and why the compiler never re-renders your Effect schemas
- [`lowerer-capability-matrix.md`](lowerer-capability-matrix.md) — per-harness support matrix: which surfaces each harness gets, and which targets are live-proven versus compile-verified
- [`sdk-contract.md`](sdk-contract.md) — the `@skastr0/prism-sdk` public contract: compile manifest, refs, snapshot, stable JSON
- [`artifact-contracts.md`](artifact-contracts.md) — generated artifact shapes per surface kind
- [`hook-contract.md`](hook-contract.md) — hook events, matchers, and degradation semantics
- [`skill-permission-traits.md`](skill-permission-traits.md) — how skills and permissions compose through traits
- [`skillspaces.md`](skillspaces.md) — skill targeting across harnesses

## Workflows

- [`workflows.md`](workflows.md) — **the full DSL reference**: `defineTask`/`defineWorkflow`/`phase` field by field, workers, permissions, model resolution, finish criteria, cache, and the run CLI
- [`workflow-data-governance.md`](workflow-data-governance.md) — what the run store persists, and how it is governed
- [`workflow-production-readiness-audit-2026-07-21.md`](workflow-production-readiness-audit-2026-07-21.md) — the open production-hardening audit: verified rows, open blockers, release rules

## Operations & release

- [`release-train.md`](release-train.md) — how releases cut and publish
- [`hooks-harness-audit.md`](hooks-harness-audit.md) — hook behavior audited per harness
- [`agent-skill-integration-tests.md`](agent-skill-integration-tests.md) — integration-test coverage for agent/skill surfaces
