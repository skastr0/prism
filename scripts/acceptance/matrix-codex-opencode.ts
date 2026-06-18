/**
 * Acceptance gate: matrix-codex-opencode (TS-007 first row).
 *
 * Runs the install-phase acceptance matrix for codex-cli and opencode using the
 * in-repo `examples/prism-harness-qa` fixture plugin, with per-harness overlay
 * slices. The test:
 *
 *   1. Creates a temp sandbox with isolated PRISM_HOME and per-harness roots.
 *   2. Runs `refreshPlugin` once and asserts creates/patches and convergence.
 *   3. Runs `refreshPlugin` again and asserts zero writes (full idempotency).
 *   4. Vacuums each harness root (empty desired state, full-world prune) and
 *      asserts all Prism-owned files and snapshot entries are removed.
 *
 * Compile-phase surfaces are intentionally excluded from this row; MCP daemon
 * lifecycle has dedicated gates (TS-005/TS-006).
 *
 * Usage: bun scripts/acceptance/matrix-codex-opencode.ts
 */

import { resolve } from "node:path";
import {
  assertRun1Creates,
  assertRun2Converged,
  formatMatrixSummary,
  HARNESS_SURFACE_MATRIX,
  runMatrixRow,
  vacuumAndAssertCleanup,
  type CleanupAssertion,
  type MatrixFixtureSpec,
  type PlanAssertion,
  type MatrixRunResult,
} from "./lib/matrix.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN_PATH = resolve(REPO_ROOT, "examples", "prism-harness-qa");

const FIXTURE: MatrixFixtureSpec = {
  pluginPath: PLUGIN_PATH,
  pluginName: "prism-harness-qa",
  harnesses: ["codex-cli", "opencode"],
  scope: "global",
  surfaces: [HARNESS_SURFACE_MATRIX["codex-cli"], HARNESS_SURFACE_MATRIX.opencode],
};

const record = (
  all: Array<PlanAssertion | CleanupAssertion>,
  assertion: PlanAssertion | CleanupAssertion,
): void => {
  all.push(assertion);
  console.log(`${assertion.pass ? "PASS" : "FAIL"}  ${assertion.name} — ${assertion.detail}`);
};

const main = async (): Promise<void> => {
  const assertions: Array<PlanAssertion | CleanupAssertion> = [];
  let result: MatrixRunResult | undefined;
  let cleanupAssertions: CleanupAssertion[] = [];

  try {
    result = await runMatrixRow({ fixture: FIXTURE });

    for (const assertion of assertRun1Creates(result.run1)) {
      record(assertions, assertion);
    }
    for (const assertion of assertRun2Converged(result.run2)) {
      record(assertions, assertion);
    }

    cleanupAssertions = await vacuumAndAssertCleanup({ fixture: FIXTURE, sandbox: result.sandbox });
    for (const assertion of cleanupAssertions) {
      record(assertions, assertion);
    }

    await result.sandbox.cleanup();
  } catch (error) {
    record(assertions, {
      name: "gate-no-crash",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const failed = assertions.filter((a) => !a.pass);
  const summary = formatMatrixSummary({
    gate: "matrix-codex-opencode",
    fixture: FIXTURE,
    run1: result ? assertRun1Creates(result.run1) : [],
    run2: result ? assertRun2Converged(result.run2) : [],
    cleanup: cleanupAssertions,
    pass: failed.length === 0,
  });

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();
