# Architecture Second-Opinion Brief: TS-002

**Glyph:** TS-002 — Add golden snapshot tests per harness lowerer  
**Project:** prism (forge orbit)  
**Date:** 2026-06-18  
**Reviewers:** Kimi Code (lead), Grok CLI (second opinion), Claude Code CLI (unavailable / timed out)

---

## Core design questions

1. **What is the unit under test?** Lowerers are pure planners that translate a composed bundle into harness-specific desired state (`DesiredFile[]` + `DesiredRegion[]`). Golden snapshots should freeze that planner output, not post-sync disk state or runtime behavior.
2. **Which outputs belong in a golden file?** Whole generated artifacts (agent markdown, plugin manifests, skill bodies) plus structured config regions (plugin-array entries, model blocks, hook registrations). Bundled `.mjs` bytes and MCP runtime artifacts should be excluded or represented by hash.
3. **Where should goldens live?** The proposed `src/compile/lowerers/__snapshots__/<harness>/` is workable but collides with two other meanings of "snapshot" in this codebase: Bun inline snapshots and Prism's snapshot manifests under `~/.prism/state/roots/`. Prefer `src/compile/golden/<harness>/` or `src/compile/lowerers/__golden__/<harness>/`.
4. **How do we keep goldens stable?** Normalization is mandatory: sort files/regions by key, replace absolute paths with placeholders, mask ports/timestamps/Bun version stamps, and canonicalize JSON whitespace.

## Recommended approach

- Snapshot the `LowerOutput` contract produced by each lowerer's `planLowering`/`planPluginForTarget` entry point, driven by one canonical fixture plugin that exercises skills, commands, agents, orbits, tools, and hooks.
- Store one normalized JSON envelope per harness under `src/compile/golden/<harness>/<scenario>.json`, with optional exploded text files for large markdown content so PR diffs stay reviewable.
- Provide an explicit update command (e.g., `GOLDEN_UPDATE=1 bun test src/compile/golden/...` or `bun run test:golden:update`). Never auto-update in CI.
- Add the golden check to `test:guarded` so pull requests fail on unexpected lowerer drift.
- Reuse `createCanonicalCompileFixture` from `src/compile/test-fixtures.ts`, but extend its target matrix to cover all requested harnesses, not only `opencode` + `claude-code`.

## Risks and failure modes

1. **Volatility without normalization:** absolute paths, ports, timestamps, and bundler banners will churn on every run.
2. **Over-capture:** snapshotting bundled `.mjs` or hook-wrapper binaries makes the suite brittle. Keep byte-level determinism in existing gates such as PQ-081 and `acceptance:mcp-determinism`.
3. **Shared-fixture blast radius:** one canonical plugin means a single source change can update every harness golden. Acceptable if scenarios are minimal and each diff is reviewed as intentional format drift.
4. **Semantic ambiguity:** a passing golden only proves output did not change, not that it is correct. Pair with the existing lowerer unit tests for behavioral assertions.
5. **CI noise:** if normalization is incomplete, golden failures become the default experience and erode trust in the gate.

## Dependencies on other TS glyphs

- **TS-001** (harness simulation layer): strongly recommended. It lets lowerers run against temp roots instead of real `~/.codex`, `~/.claude`, etc. Without it, the golden generator is unsafe or incomplete for global-only harnesses.
- **TS-003** (compiler phase contract tests): overlaps at the compose/resolve boundary. Agree on a canonical fixture shape so TS-002 and TS-003 do not maintain two divergent fixture worlds.
- **TS-005** (MCP bundle round-trip tests): owns runtime bundle correctness. TS-002 should reference hashes, not duplicate TS-005's byte-level assertions.
- **TS-007** (acceptance test matrix): consumes the same fixtures. Keep golden tests fast (lowerer-boundary only) and let TS-007 cover end-to-end refresh/apply/prune behavior.

## Concrete first file or function to create/modify

Create `src/compile/golden/normalize-lower-output.ts` containing a single `normalizeLowerOutput(output, harnessId)` function. It must deterministically serialize `DesiredFile[]` + `DesiredRegion[]`, mask volatile values, and sort collections. No snapshot directory or per-harness test will be stable until this function exists.

## Verdict

Proceed, but rename the snapshot directory to avoid confusion with Prism's snapshot manifests, and make normalization the very first deliverable. The proposed AC is sound if the snapshots freeze desired state at the lowerer boundary rather than merged disk or runtime bytes.
