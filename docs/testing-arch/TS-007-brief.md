# Architecture Second-Opinion Brief: TS-007

**Glyph:** TS-007 — Expand acceptance test matrix across all harnesses  
**Orbit:** forge  
**Date:** 2026-06-18  
**Reviewers:** Kimi Code (lead), Grok CLI; Claude Code CLI timed out and produced no opinion.

---

## Core Design Questions

1. **What does "all harnesses" mean?** Twelve registry IDs exist, but surface kinds differ sharply (direct-file, config-patch, plugin-bundle, generated-MCP, skills-only). A uniform assertion set will over-claim for some harnesses and under-test others.
2. **How do we sandbox install-phase global roots?** `--compile-root` isolates compile output, but install-phase `refresh` still resolves `~/.claude`, `~/.codex`, etc. via `expandPath(harness.globalConfigPath)`. Global-only harnesses (openclaw, hermes, kimi-code) cannot be tested safely without a test-only root override.
3. **Which plan object is the source of truth for AC3?** `refresh --dry-run`, `prism plan`, and doctor's compile self-check emit related but not identical envelopes. The matrix needs one canonical plan/report shape (likely `SyncPlan` / refresh JSON) and should compare that, not just file trees.
4. **What is cleanup?** It is not deleting a plugin directory; it is refreshing after removing a plugin from the corpus and asserting that Prism-owned files, shared-file regions, and `PRISM_HOME/runtime/mcp/<plugin>/` are pruned.

## Recommended Approach

Treat the matrix as three layers:

- **L0:** capability-to-lowerer contract validation, already partly in lowerer tests / `LOWERER_CAPABILITIES`.
- **L1:** sync-engine invariants per surface kind (create/skip/repair/prune/blocked) using temp roots.
- **L2:** one parameterized acceptance gate that runs harness × fixture × invariant and feeds the `run-all.ts` debt table.

Build one in-repo fixture plugin (extend `examples/prism-harness-qa`) with per-harness target slices instead of relying on `~/Projects/prism-plugins`. Seed synthetic user roots per family (codex `config.toml`, opencode `opencode.json`, etc.), run with `--mcp-lifecycle none`, and assert first on the JSON plan/report (`converged`, op counts, zero writes on run 2). Use byte-level git diff only for config-patch harnesses. Shard CI by surface family and allow expected-FAIL rows so the matrix can land incrementally.

## Risks and Failure Modes

- **No install root override** forces tests to hit real home dirs or stay `--compile-only`, missing half of AC1.
- **External corpus** (`~/Projects/prism-plugins`) makes CI flaky and cold compiles slow.
- **MCP serve in the matrix** introduces port/pid churn that breaks idempotency; keep daemon tests in their own gates.
- **Harness-specific formatting** causes false positives until region editors (WS5) are fully stable.
- **Cleanup needs multi-plugin state**; single-plugin refresh cannot prove uninstall correctness.
- **Parallel runs** must use separate temp `PRISM_HOME`s; the advisory lock currently serializes on a shared home.

## Dependencies on Other TS Glyphs

- **TS-001 (harness simulation layer / root-injection service):** Strong prerequisite. Without a `HarnessRoots` service or equivalent root override, AC1 is unsafe or incomplete for global-only harnesses.
- **TS-008 (state store property tests):** Provides lower-level confidence in snapshot/prune correctness that the matrix can assume.
- **TS-005 (MCP bundle round-trip):** Owns daemon/runtime correctness; the matrix should disable MCP lifecycle and rely on TS-005 for bundle behavior.
- **TS-006 (doctor diagnostic contract tests):** Good secondary verifier for drift/GC findings but should not be the primary assertion layer.
- **TS-002 / TS-003 (golden lowerer + compiler phase contract):** Supply canonical fixtures; align fixture shape so the matrix does not maintain a third fixture world.

## Concrete First File or Function to Create/Modify

1. **Modify `src/harnesses.ts:resolveHarnessRoot()`** to consume an injectable `HarnessRoots` service (per TS-001) instead of calling `expandPath(harness.globalConfigPath)` directly. This is the keystone seam for safe install-phase testing.
2. **Create `scripts/acceptance/lib/matrix.ts`:** a shared harness fixture spec, temp-root lifecycle, plan comparator, and cleanup assertion used by every new gate.

Start with one row (codex-cli + opencode) to prove the lib, then expand the `GATE_SCRIPTS` table in `scripts/acceptance/run-all.ts`.

---

**Verdict:** TS-007 is valuable but overclaims unless AC1 is narrowed to compile-capable harnesses or TS-001's root-injection seam lands first. Build the shared matrix library and root override before adding rows.
