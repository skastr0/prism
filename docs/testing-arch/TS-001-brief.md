# Architecture Second-Opinion Brief: TS-001

**Glyph:** TS-001 — Build harness simulation layer for isolated Prism tests  
**Orbit:** forge  
**Date:** 2026-06-18  
**Reviewers:** Kimi Code (lead), Grok CLI, Claude Code CLI

---

## Core Design Questions

1. **What is the simulation layer actually simulating?** It is not emulating OpenCode, Codex, or Claude behavior. It is a *root-redirection sandbox*: a temporary filesystem universe where `PRISM_HOME`, per-harness global roots, and (when needed) project roots all point under one temp parent.
2. **Where does the isolation seam belong?** Two roots need redirecting:
   - `PRISM_HOME` — already moving toward a service (`PrismHome` tag in `src/services/prism-env.ts`).
   - Harness roots — still resolved through `resolveHarnessRoot()` → `expandPath()` → `process.env.HOME` plus hardcoded `~/.config/opencode` defaults. This is the unguarded seam.
3. **Should this be a programmatic helper, a CLI flag, or both?** All three reviewers agree: a *programmatic helper is the spine*, with env-injection (`PRISM_HOME`, and a future harness-root service) for CLI subprocess tests. A `--prism-home` flag is redundant public surface and should be rejected.

## Recommended Approach

Build a small, test-only **sandbox context** plus a mirror **HarnessRoots** service.

- Add a `HarnessRoots` service next to `PrismHome` in `src/services/prism-env.ts` (or a sibling file). The service maps a harness to its base directory; the default live layer keeps today's `expandPath(harness.globalConfigPath)` behavior, while a test layer returns a temp subdirectory.
- Thread `HarnessRoots` through `resolveHarnessRoot()` in `src/harnesses.ts` so the same code paths work in tests and production without env mutation.
- Create `src/testing/prism-sandbox.ts` that:
  - `mkdtemp` one parent temp directory,
  - creates children for `prism-home` and per-harness roots,
  - returns a `withPrismSandbox(fn)` lifecycle helper that injects the service/test layers (and restores them),
  - tears down after the test.
- Provide thin assertion helpers (file-tree, content, snapshot) as a sibling module, but keep the DSL minimal on day one.
- Port **`src/refresh.test.ts` first** — it is the smallest end-to-end proof of refresh + snapshots + prune. Defer the heavier `src/compile/pipeline.test.ts` migration until the API is stable.

This treats the glyph as **WS2 completion work** (finish injecting the harness-root seam) rather than inventing a parallel simulation framework.

## Risks and Failure Modes

1. **Partial sandbox leak.** If `PRISM_HOME` is redirected but harness roots are not, global-scope refresh/doctor writes real `~/.config/*`. The `commitSnapshot` tmp-fence catches PRISM_HOME pollution but not harness-root pollution.
2. **Env mutation under parallel tests.** Relying on `process.env.HOME` swapping is fragile. The service-injection path avoids global mutation entirely.
3. **Dual resolution paths.** Some call sites take explicit `prismHome`; others call `resolvePrismHome()` with default args. The sandbox must document and eventually unify which surfaces are fully sandboxable.
4. **Snapshot tmp-fence violation.** `commitSnapshot()` throws if the harness root is temp but `PRISM_HOME` is not. Sandbox must put both under the same temp parent.
5. **Non-deterministic snapshot comparisons.** Backup timestamps, corrupt-file suffixes, MCP ports, and absolute paths must be normalized before assertions or tests will flake.
6. **Orphan manifests.** Snapshot keys are `sha256(root)`. Unique temp roots per run can leave manifests if cleanup fails; sandbox teardown should delete the entire temp parent.
7. **Scope creep into real CLI binary testing.** Testing the literal `prism` CLI binary end-to-end requires fixing ~10 direct `resolvePrismHome()` call sites in `src/cli.ts`. That is a separate, larger glyph; TS-001 should stay at the function layer.
8. **Migration trap.** Porting `pipeline.test.ts` first maximizes churn for minimal architectural gain because it already bypasses refresh/doctor and calls compile APIs directly.

## Dependencies on Other TS Glyphs

- **TS-??? (PrismHome service / WS2):** The simulation layer depends on the same service-injection pattern. If PrismHome is not yet fully threaded through CLI entry points, the sandbox can still operate at the library-function layer.
- **TS-??? (CLI harness-root injection):** End-to-end binary-level tests are blocked until `resolveHarnessRoot()` and `src/cli.ts` stop reading `process.env.HOME` directly.
- **TS-??? (test-preload hardening):** Once the sandbox exists, `scripts/test-preload.ts` should gain a `HOME` guard in addition to its existing `PRISM_HOME` guard.

## Concrete First File or Function to Create/Modify

**Create:** `src/services/prism-env.ts` (or a new sibling `harness-roots.ts`) — add the `HarnessRoots` service interface with `Live` and `Test` layers.

**Modify first:** `src/harnesses.ts` function `resolveHarnessRoot()` — consume `HarnessRoots` instead of `expandPath(harness.globalConfigPath)` directly.

This is the keystone seam. Without closing it, no isolation helper can honestly guarantee it will not touch real harness configs.

---

**Verdict:** TS-001 is the right direction but should be reframed from "harness simulator" to "finish root-injection services + add a sandbox helper." Start with the `HarnessRoots` service, not a new test framework.
