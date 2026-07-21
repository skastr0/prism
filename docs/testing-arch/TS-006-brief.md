# Architecture Second-Opinion Brief: TS-006 — Add doctor diagnostic contract tests

## Core design questions

1. **What is the contract surface?** `src/doctor.ts` emits `prism.doctor.finding.v1` records with `family`, `code`, `severity`, optional `fix`, and contextual fields (`harness`, `plugin`, `root`, `path`, `data`). There are roughly 44 distinct codes across eight families. The glyph asks for positive, negative, and fix-path coverage for each, which is a conformance problem more than a unit-testing problem.

2. **Where should the tests live relative to existing suites?** `src/doctor.test.ts` already has ad-hoc coverage; `src/state/state.test.ts` and `src/sync/sync.test.ts` cover the underlying engine. TS-006 should not duplicate those engines. It should prove that doctor *surfaces* the right finding under the right disk state and that `--fix` resolves it.

3. **How do we keep fixtures maintainable across 44 codes?** Hand-writing 100+ individual tests is brittle. A catalog-driven approach that iterates over every finding code is more likely to stay complete as new codes are added.

4. **How do we test fix-paths deterministically?** `--fix` calls `refreshPlugin`, `compilePluginForTarget`, and MCP lifecycle helpers. Those must be isolated from real harness homes and, where necessary, from real daemons.

## Recommended approach

Build a **catalog-driven conformance suite** in `src/doctor/`, not isolated hand-written tests.

1. **Create `src/doctor/finding-catalog.ts`** as the spine. It exports a typed registry keyed by `family` + `code` with `severity`, optional `fix`, and harness scope. Add a meta-test that greps every `finding({ code: ... })` call in `src/doctor.ts` and fails CI if a code lacks a catalog entry.

2. **Create `src/doctor/test-fixtures.ts`** with composable builders over a tmpdir `DoctorWorld` (mirroring the existing `beforeEach` pattern of overriding `HOME` and setting a sandbox `prismHome`):
   - `withSnapshot(entries)`
   - `withCodexToml(content)` / `withOpenCodeJson(content)` / `withClaudePlugin(path, mcp?, hooks?)`
   - `withMcpBundle(toolNames)`
   - `withPlugin(...)`

3. **Drive tests with `test.each(catalog)`**. For each entry:
   - **Positive**: `setupTrigger(ctx)` → `runDoctor({ fix: false })` → assert the code is present.
   - **Negative**: `setupClean(ctx)` → assert the code is absent.
   - **Fix** (when `fix` is set): trigger → `runDoctor({ fix: true })` → assert the code is gone on a subsequent no-fix run, and state is repaired (`readSnapshot`, target file content).

4. **Keep the boundary clear**: these are acceptance-style tests over real `runDoctor` and disk state. Leave pure helpers (region parsing, `markerLine`, hash comparisons) to existing unit tests in `state/` and `sync/`.

5. **Fix-path assertion strategy**: assert durable state, not internal refresh logs. For `fix: "manual"` codes, assert `--fix` *does not* clear them. For `fix: "refresh"` / `"gc"`, assert idempotent second runs converge to an empty finding list.

## Risks and failure modes

- **Fragile assertions on report ordering or full objects**: doctor returns many findings at once. Assert on code *sets* (`toContain`), not `toMatchSnapshot` or exact arrays, unless the fixture is intentionally minimal.
- **Duplicating `state/` and `sync/` tests**: avoid re-proving GC, snapshot serialization, or region math here. Focus on the finding-to-state mapping.
- **Slow compile-heavy fixtures**: default to install-phase minimal plugins. Only use `createCanonicalCompileFixture` for findings that genuinely require compile-phase output (e.g., `config.claude-hook-command-missing`).
- **MCP daemon flakiness**: findings under `mcp.health` and any fix that calls `getMcpStatus` should stub or short-circuit the lifecycle layer so tests do not depend on background HTTP daemons.
- **Cross-test pollution**: each case must get its own tmpdir and its own `HOME`/`prismHome`. Reuse the existing `beforeEach`/`afterEach` pattern; do not share a global harness home.
- **Catalog drift**: without the meta-test, new doctor findings will be added without tests. The catalog + meta-test is the fail-closed guard the glyph actually needs.

## Dependencies on other TS glyphs

- **TS-001** (harness simulation layer) is a prerequisite for the cleanest implementation. The current tmpdir + `HOME` override works, but a shared `DoctorWorld`/`HarnessSimulator` would reduce per-test boilerplate and is the natural place for the fixture builders to live. If TS-001 is sequenced first, TS-006 should reuse its simulator rather than inventing a parallel one.
- **TS-005** (MCP bundle round-trip tests) owns the MCP bundle correctness surface. TS-006 should consume its bundle fixtures but not re-prove bundle generation.
- **TS-008** (state store property and migration tests) owns snapshot/GC invariants. TS-006 should assert that doctor surfaces `snapshot.*-dropped` findings after GC, not that GC itself is correct.
- **TS-007** (acceptance matrix) is the broader harness-level acceptance suite. TS-006 is the in-process contract-test layer that feeds into that matrix; doctor contract tests should run in CI, acceptance harness-level tests should run less frequently.

## Concrete first file or function to create/modify

Create **`src/doctor/finding-catalog.ts`** first. It is the smallest possible artifact that forces enumeration of every finding code, establishes the test harness contract, and lets the meta-test fail CI when coverage drifts. Only after the catalog exists should the team write the builders and the `test.each` loop in `src/doctor/doctor-contract.test.ts` (or refactor the existing `src/doctor.test.ts` to use the catalog).

---
*Reviewers consulted: Grok CLI, Claude Code CLI. Both recommend a catalog-driven conformance suite centered on a finding registry plus composable tmpdir fixtures.*
