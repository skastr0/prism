# Architecture Brief: TS-012 End-to-end refresh/apply/prune matrix expansion

## Goal
Expand TS-007 acceptance matrix to cover all harnesses and prove create/idempotent/cleanup invariants.

## Key seams
- `scripts/acceptance/lib/matrix.ts` from TS-007
- `src/refresh.ts` :: `refreshPlugin`
- `src/sync/apply.ts` :: applies `SyncPlan`
- `src/state/store.ts` :: snapshots and prune

## Recommended approach
1. Extend `scripts/acceptance/lib/matrix.ts` with fixture helpers for remaining harnesses.
2. Add per-harness overlay slices in `examples/prism-harness-qa/harness/` for direct-file and config-patch harnesses.
3. Add gates in `scripts/acceptance/` for:
   - direct-file family: codex-cli, factory-droid, openclaw, hermes (skills-only), cursor (rules+skills)
   - config-patch family: opencode, codex-cli, kimi-code, grok, amp, pi
   - plugin-bundle family: claude-code, antigravity-cli, grok, factory-droid, kimi-code, pi
   - generated-MCP family: cursor, hermes
4. Each gate asserts: first run creates, second run converges, plugin removal prunes all owned artifacts.
5. Register gates in `scripts/acceptance/run-all.ts` with expected PASS/FAIL.

## Risks
- Some harnesses share surfaces (e.g., codex-cli direct commands + config patch). Keep rows focused.
- Compile-phase MCP surfaces can be slow; keep lifecycle disabled.
- Expected failures should be documented, not hidden.

## Verdict
Proceed, but land the high-priority MCP/native-plugin glyphs first; this is breadth, not depth.
