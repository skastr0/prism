# Architecture Second-Opinion Brief: TS-003 — Add Compiler Phase Contract Tests

## Core Design Questions

Glyph TS-003 asks for per-phase contract tests across Prism's compile pipeline: Load, Resolve, Compose, and Lower. The central design question is where to draw the test seams so that a regression in one phase fails one focused test file instead of every end-to-end compile test.

The four phases already have stable boundary types:

- **Load** (`src/compile/load.ts`): `loadPlugin(root) -> Effect<PluginRegistry, CompileError>` — filesystem-driven discovery, TS import, normalization.
- **Resolve** (`src/compile/resolve.ts`): `resolveAgent(agent, registry, target) -> Effect<ResolvedAgent, CompileError>` — cross-plugin refs, trait/slot validation, target-aware tool/model/skill resolution.
- **Compose** (`src/compile/compose.ts`): `composeAgent(resolved) -> ComposedAgent` — pure, target-agnostic markdown/metadata assembly.
- **Lower** (`src/compile/lowerers/*.ts`): `planLowering({agents, orbits, tools, target}) -> LowerOutput` — desired-state emission per harness.

The key question is whether tests should call each boundary function directly or drive the whole pipeline and snapshot intermediate artifacts. A secondary question is how to share fixtures without duplicating the existing lowerer tests (`opencode-lowerer.test.ts`, etc.) or the acceptance scripts (`scripts/acceptance/mcp-determinism.ts`).

## Recommended Approach

**Test each phase's public boundary function directly.** This matches the pipeline's existing module boundaries and avoids re-deriving regressions through unrelated phases. Existing tests already cover two phases reasonably well:

- `load.test.ts` covers Load.
- `*-lowerer.test.ts` files cover Lower per harness.

The gap is in the middle: Resolve and Compose currently have no dedicated contract tests and are only exercised transitively through `pipeline.test.ts` and lowerer tests.

Create two new test files:

1. `src/compile/resolve.test.ts` — test `resolveAgent`, `validateOrbit`, and `instantiateOrbit` against in-memory registries and a small loaded fixture.
2. `src/compile/compose.test.ts` — test `composeAgent` with hand-constructed `ResolvedAgent` inputs (pure, no filesystem).

Extract shared builders into a new `src/compile/test-support.ts` (or extend `src/compile/test-fixtures.ts`) for `makeRegistry`, `makeAgent`, and `makeResolvedAgent`. The lowerer tests' existing `createComposedAgent` factory should migrate here once Compose needs it. Keep Load's disk fixtures where they are — only Load needs temp directories.

`pipeline.test.ts` should remain the integration/wiring test that proves the phases compose; do not use it as the primary regression-isolation surface.

## Risks and Failure Modes

- **Over-specifying internals.** Asserting deep equality on `PluginRegistry` maps or `ResolvedTrait` internals couples tests to refactoring. Prefer output-type invariants: error `_tag`/`field`, binding `kind`, sorted lists, and section presence/order.
- **Markdown snapshot brittleness.** `ComposedAgent.body` is prose; full string snapshots break on copy edits. Assert structural invariants (title split, section order, trait instructions present) instead of exact text.
- **Target leakage into target-agnostic phases.** Compose must not assert OpenCode-specific config keys — those belong in lowerer tests. Resolve is legitimately target-aware, so skill-name validation and target-block selection are correct there.
- **Duplicating lowerer coverage.** Phase-contract tests should stop at the boundary type the next phase consumes. Do not re-assert `DesiredFile` paths or `opencode.json` region keys in Resolve or Compose tests.
- **Filesystem flakiness.** Resolve and Compose tests should be in-memory. Load keeps disk; the transformed-plugin-root cache and module imports make it the slowest, most fragile phase to fixture.
- **False confidence from in-memory-only resolve tests.** Keep at least one Resolve test that goes through `loadPlugin` to catch normalization/module-loading gaps.

## Dependencies on Other TS Glyphs

TS-003 sits in a test-infrastructure thread. Its implementation should not change source code, but it may depend on or unblock:

- **TS-001 / TS-002** (if they define test-hygiene or fixture conventions for the forge orbit): align shared helper names and temp-root lifecycle with any project-wide testing standards.
- **Any glyph touching `src/compile/resolve.ts` or `src/compile/compose.ts`**: phase-contract tests will become the preferred place to add regression coverage for future resolve/compose changes; new feature glyphs should add a contract test here rather than expanding `pipeline.test.ts`.
- **Acceptance-script work** (e.g., MCP determinism): contract tests are fast unit-level guards; acceptance scripts remain the slow cross-cwd/reproducibility gate. Do not merge the two layers.

The Tower `glyph list` call for the forge orbit timed out during review, so specific upstream TS glyph IDs could not be enumerated; this brief should be updated once that list is available.

## Concrete First File to Create/Modify

**Create `src/compile/resolve.test.ts` first.** Resolve is the largest gap: it contains the most logic (cross-plugin refs, trait binding, slot validation, model/skill/tool target resolution) and is currently only tested transitively. Establishing Resolve tests first also creates the `makeRegistry`/`makeAgent` builders that `compose.test.ts` will reuse.

Start with these seams:

- `resolveAgent(agent, registry, target)` from `src/compile/resolve.ts`
- `validateOrbit(orbit, registry)` and `instantiateOrbit(orbit)` for orbit-phase contracts
- Error constructors from `src/compile/errors.ts` to assert typed failures (`UnknownReferenceError`, `AgentValidationError`, `MissingTargetResolutionError`, etc.)

If a shared builder file is needed before the second phase test, extract helpers from `load.test.ts` and `opencode-lowerer.test.ts` into `src/compile/test-support.ts` as part of the Resolve test PR.
