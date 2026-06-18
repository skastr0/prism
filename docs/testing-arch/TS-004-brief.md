# Architecture Second-Opinion Brief: TS-004

**Glyph:** TS-004 — Add property-based tests for reference resolution and trait merging  
**Project:** prism (forge orbit)  
**Reviewers:** Grok CLI, Claude Code CLI (unavailable/timed out), local architecture review  
**Date:** 2026-06-18

---

## Core design questions

1. **Where do we draw the PBT boundary?** The combinatorial risk lives in `resolve.ts` (dep-alias routing, trait access union, tool-group expansion), `protocol-tools.ts` (trait tool slot merge), `runtime/schema-bridge.ts` (schema-to-tool-schema compatibility), and `state/store.ts` (snapshot GC). These are mostly pure, deterministic functions, so they are good PBT targets. The full `resolveAgent`/`compose`/`lower` pipeline is slower and harder to shrink; it should be covered by golden/contract tests (TS-002, TS-003) rather than property tests.

2. **Valid-model vs. adversarial generators.** Arbitraries must respect compile-language invariants (typed refs, schema-bridge-acceptable ASTs, fail-closed errors) or they will only prove “invalid input throws.” The clean split is:
   - **Valid-model generators** test refinement laws (e.g., trait slot merge is idempotent, access union is commutative, schema bridge round-trips within supported subset).
   - **Adversarial generators** intentionally break invariants (cyclic deps, unknown aliases, unsupported schema unions) and assert the *expected* `CompileError` tag.

3. **Tooling choice.** `fast-check` is the pragmatic pick: mature shrinking, Bun-compatible, and no first-class Effect PBT exists for Schema today. Effect test utilities can complement it for `Effect.gen` pipelines, but the generators themselves should be plain arbitraries over the in-memory source models.

---

## Recommended approach

Layer property tests smallest-seam-first, reusing the existing `emptyRegistry` pattern and in-memory roots from `state.test.ts`:

| Layer | Target file(s) | Properties |
|---|---|---|
| 1 | `src/compile/refs.ts` | Dep-alias resolution: bare refs stay local; prefixed refs route through `registry.deps`; unknown prefix yields `UnknownDependencyError`. |
| 2 | `src/compile/protocol-tools.ts` | Trait tool slot merge is associative/idempotent; conflicting logical names from different traits fail closed; unknown slot/tool refs fail closed. |
| 3 | `src/compile/resolve.ts` | `resolveAgentCapabilities` access union is commutative; duplicate traits are rejected; required tools/skills surface iff present. |
| 4 | `src/compile/runtime/schema-bridge.ts` | `toolArgsFromSchema` accepts only the documented subset; unsupported unions throw the expected diagnostic. |
| 5 | `src/state/store.ts` | GC drops manifests for dead roots, removes stale owned entries, keeps live region entries, and is idempotent. |

Introduce a shared fixture module first: `src/compile/testing/registry-fixtures.ts` (or `src/compile/test-fixtures.ts` if it stays test-only). It should export typed builders for `PluginRegistry`, dep graphs, traits, canonical tools, toolspaces, modelspaces, skillspaces, and `Effect.Schema` nodes that the bridge accepts. Pin seeds via env var and cap iterations (`numRuns: 100` default) so CI stays fast and flakes are reproducible.

Grok’s review concurs: start with fixtures, keep layers separate, and avoid whole-pipeline PBT.

---

## Risks and failure modes

- **Unreadable shrunk fixtures.** Mitigate with tagged generators and custom shrink strategies that keep fixtures close to real source shapes.
- **Unbounded dep graphs / timeouts.** Cap graph depth and fan-out in arbitraries; treat deep recursion as an expected failure case.
- **Conflating expected errors with bugs.** Every property must classify outcomes: `ok`, `expected-fail` (known error tag), or `bug`.
- **Coupling failures in monolithic `resolve.ts`.** If a property fails, the large `resolve.ts` surface makes root-cause harder. Layer-1/2 tests above isolate the seam first.
- **Snapshot GC relies on filesystem state.** GC properties need tempdirs; reuse the sandbox pattern from `state.test.ts` and ensure the tmp-fence in `commitSnapshot` does not reject sandboxed roots.
- **Schema-bridge subset drift.** If authors add new Effect Schema features, PBT may falsely pass until the bridge is updated. Keep an explicit “unsupported schema” adversarial generator to catch this.

---

## Dependencies on other TS glyphs

- **TS-001** (harness simulation layer): not a hard blocker, but its in-memory harness stubs would make higher-layer properties cheaper.
- **TS-003** (compiler phase contract tests): the boundary between contract tests and property tests should be explicit—TS-003 owns deterministic examples; TS-004 owns cross-product invariants.
- **TS-005** (MCP bundle round-trip tests): trait tool slot merging feeds MCP bundle generation; PBT here reduces regressions that TS-005 would catch later.
- **TS-008** (state store property and migration tests): overlaps on snapshot GC. Either merge the GC properties into TS-008 and keep TS-004 focused on compile resolution, or coordinate so TS-004 covers GC laws and TS-008 covers migration/schema evolution.
- **PQ-088** (wire guarded suite/acceptance gates into CI): PBT is only useful if CI runs it. Need to add a `bun test` invocation to the guarded suite or CI workflow before/alongside this glyph.

---

## Concrete first file or function to create/modify

Create **`src/compile/testing/registry-fixtures.ts`** (or extend `src/compile/test-fixtures.ts`) with:
- `arbitraryRegistry(options)`: builds a `PluginRegistry` with controlled dep depth.
- `arbitraryTraitWithTools()`: trait + canonical tool + optional slot schemas.
- `arbitrarySchemaBridgeNode()`: Effect Schema ASTs inside the bridge-supported subset.

Then add the first property test file: **`src/compile/refs.property.test.ts`** verifying dep-alias routing and unknown-prefix errors. It is the smallest seam, has no filesystem or Effect-async coupling, and establishes the generator patterns for the rest of the stack.

---

## Reviewer notes

- **Grok CLI:** Provided a substantive architecture review (after MCP connection noise). Recommended layered PBT, `fast-check`, shared registry fixtures, and explicit classification of expected failures.
- **Claude Code CLI:** Timed out on two attempts (120s and 180s). No substantive answer obtained.
