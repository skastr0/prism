/**
 * Acceptance gate: matrix-direct-file-install (TS-012).
 *
 * Covers install-phase direct-file surfaces for harnesses that do not require
 * compile-phase MCP lifecycle:
 *   - factory-droid: commands + AGENTS.md region
 *   - openclaw: skills-only
 *   - cursor: generated local plugin commands + skills + .cursorrules region
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
  harnesses: ["factory-droid", "openclaw", "cursor"],
  scope: "global",
  surfaces: [
    HARNESS_SURFACE_MATRIX["factory-droid"],
    HARNESS_SURFACE_MATRIX.openclaw,
    HARNESS_SURFACE_MATRIX.cursor,
  ],
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
    gate: "matrix-direct-file-install",
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
