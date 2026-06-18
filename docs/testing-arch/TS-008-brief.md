# Architecture Second-Opinion Brief: TS-008

## Core design questions

1. **What does "snapshot format migration" mean when only version 1 exists?**  
   `packages/prism-core/src/snapshot.ts` already declares a "versioned union" and promises forward migration in code, but the union has only one member. TS-008 must decide whether to build the migration seam now (an identity function for v1 plus a rejection path for unknown versions) or to defer it until a second version is designed.

2. **Where does migration belong?**  
   The decode boundary is in `prism-core`, while persistence is in `src/state/store.ts`. Migration could live in either layer. The question is whether `store.ts` should see only the latest shape, or whether it should own the "read old → write new" transformation.

3. **What is the boundary between state-store tests and sync-engine tests?**  
   `src/sync/sync.test.ts` already covers owned/shared regions, degraded ownership, crash convergence, prune scoping, and backup-on-drift. TS-008 must avoid turning the state store tests into a second sync-engine test suite.

4. **What is the backup/restore contract?**  
   `src/state/run-backups.ts` captures first-bytes per (runId, target) under `PRISM_HOME/backups/<runId>/...`, but there is no restore API. TS-008 must decide whether to test only the capture contract or to add and test restore semantics.

5. **How exhaustive should GC fence detection tests be?**  
   `store.ts:regionEntryPresent` treats marker regions specially (detects missing fences) but returns `true` for JSON regions by design. TS-008 must decide whether to test every region-ref variant or to pin the two distinct behaviors.

## Recommended approach

1. **Build the migration seam now, even though only v1 exists.**
   - Add `migrateSnapshotManifest(unknown) → Either<ParseError, SnapshotManifest>` in `packages/prism-core/src/snapshot.ts`.
   - Keep it as the identity for v1 today; reserve a shape for v2→v1 when that version is designed.
   - Wire it into `readSnapshot` and `gcSnapshots` so the store never sees non-latest shapes.
   - This honors the existing comment in `snapshot.ts` and makes the tests meaningful instead of testing a phantom migration.

2. **Keep migration in `prism-core`, not `store.ts`.**
   - Migration is a pure, fs-free shape transform; it belongs next to the schema.
   - `store.ts` should remain a dumb persistence layer: decode → migrate → quarantine on Left.

3. **State-store tests focus on entry contract; sync tests own convergence.**
   - Test that committed entries are keyed by `targetPath` alone (the 646-zombie regression), that `regionKey` is present iff `mode === "region"`, that `plugin` is diagnostic-only, and that deterministic sorting produces byte-identical re-commits.
   - Add one seam test showing that a `planSync` decision produces the expected snapshot entry shape, but do not replay patch-regions or backup scenarios here.

4. **Test backup capture, not restore.**
   - `run-backups.ts` has no restore helper. TS-008 should test first-bytes-win, missing-target skip, path layout, and prune retention.
   - If restore semantics are desired, add a `restoreFromRunBackup` helper first; otherwise testing restore would require reaching into private paths and would be brittle.

5. **GC fence tests cover the two behavioral classes.**
   - Marker regions: test present fence (entry kept) and absent fence (entry dropped).
   - JSON regions: add one test that asserts a missing JSON key is **not** dropped, documenting the current intentional short-circuit.
   - Version skew: write `version: 2` or missing `version` to disk and assert it is quarantined like corrupt JSON.

## Risks and failure modes

- **Duplicating sync tests in state tests.** If TS-008 replays too many plan/apply scenarios, the suite becomes slow and the failure signals blur. Keep the state suite small and persistence-focused.
- **Testing migration before a real second version exists.** Property-based generation of "older shapes" would mostly fuzz schema noise. Instead, test the decode boundary explicitly and reserve the migration seam.
- **Assuming JSON GC behaves like marker GC.** `regionEntryPresent` returns `true` for JSON regions today; a test that expects key-absence to drop the entry would fail and mislead.
- **Testing restore without a restore API.** This creates brittle path-reach tests and does not prove a real restore workflow.
- **Scope creep into doctor diagnostics.** `src/doctor.test.ts` already covers dead-root GC and stale-entry drops. TS-008 should stay at the `store.ts`/`run-backups.ts` unit level.

## Dependencies on other TS glyphs

- **TS-001 (harness simulation layer):** Not a blocker. Existing `mkdtemp` + temp-PRISM_HOME patterns in `state.test.ts` and `sync.test.ts` are sufficient.
- **TS-006 (doctor diagnostic contract tests):** Overlaps on GC/drift findings, but TS-008 stays at the store unit level while TS-006 stays at the diagnostic/report level. Coordinate so the same GC edge case is not tested twice at different granularities.
- **TS-007 (acceptance matrix):** TS-008 provides lower-level confidence in state correctness that acceptance tests can rely on; it does not depend on it.
- **Future snapshot version work:** Any glyph that introduces a v2 manifest format must extend the `migrateSnapshotManifest` seam added here.

## Concrete first file or function to create/modify

**First change:** Create `packages/prism-core/src/snapshot.test.ts` and add `migrateSnapshotManifest` to `packages/prism-core/src/snapshot.ts`.

- The function starts as a thin wrapper around the existing v1 decode: `unknown → Either<ParseError, SnapshotManifest>`.
- The new test file proves v1 encode→decode round-trip, wrong/missing version → Left, and sorted determinism.
- **Second change:** Wire `migrateSnapshotManifest` into `src/state/store.ts` (`readSnapshot` and `gcSnapshots`) and add version-skew quarantine tests to `src/state/state.test.ts`.
- **Third change:** Add focused tests to `src/state/state.test.ts` for ownership entry shape and GC fence behaviors, and verify `src/state/run-backups.ts` first-bytes-win and prune retention (already partially covered; extend if gaps remain).

This sequence keeps the change small, test-driven, and aligned with the existing architecture.
