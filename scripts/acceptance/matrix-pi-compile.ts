/**
 * Acceptance gate: matrix-pi-compile (TS-012).
 *
 * Covers Pi compile-phase package output. Pi uses native extension APIs for
 * generated tools, so MCP lifecycle stays disabled. Global-scope Pi agents are
 * emitted to a sibling of the configured Pi root; cleanup still reaches them
 * through the snapshot manifest.
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
  harnesses: ["pi"],
  compileTargets: ["pi"],
  scope: "global",
  surfaces: [HARNESS_SURFACE_MATRIX.pi],
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
    gate: "matrix-pi-compile",
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
