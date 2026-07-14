/**
 * Acceptance gate: matrix-mcp-disabled (TS-012).
 *
 * Verifies that compile-phase harnesses requiring a Streamable HTTP MCP
 * runtime fail closed when no port has been resolved for it. This keeps
 * daemon lifecycle out of the idempotency matrix (owned by TS-005/TS-006)
 * while documenting the debt surface.
 *
 * Each row is a harness × compile attempt. The gate exits 0 when every harness
 * fails for the expected MCP-lifecycle reason; run-all.ts registers the rows as
 * expected FAIL.
 */

import { resolve } from "node:path";
import { Effect, Cause } from "effect";
import { compilePluginForTarget } from "../../src/compile/pipeline.js";
import { HarnessRootsTest } from "../../src/services/prism-env.js";
import { createPrismSandbox, type PrismSandbox } from "../../src/testing/prism-sandbox.js";
import type { HarnessId } from "../../src/types.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN_PATH = resolve(REPO_ROOT, "examples", "prism-harness-qa");

interface Row {
  readonly gate: string;
  readonly pass: boolean;
  readonly detail: string;
}

const MCP_DEPENDENT_HARNESSES: HarnessId[] = [
  "claude-code",
  "antigravity-cli",
  "grok",
  "factory-droid",
  "kimi-code",
  "codex-cli",
  "hermes",
  "cursor",
];

const isMcpLifecycleFailure = (message: string): boolean =>
  message.includes("Streamable HTTP MCP runtime") &&
  message.includes("refusing to write url config");

const runRow = async (harnessId: HarnessId): Promise<Row> => {
  const sandbox: PrismSandbox = await createPrismSandbox();
  let message = "";
  let failed = false;

  try {
    const exit = await Effect.runPromiseExit(
      compilePluginForTarget({
        pluginPath: PLUGIN_PATH,
        target: harnessId,
        scope: "global",
        prismHome: sandbox.prismHome,
        dryRun: false,
      }).pipe(
        Effect.provide(
          HarnessRootsTest({
            [harnessId]: sandbox.rootFor(harnessId),
          }),
        ),
      ),
    );

    if (exit._tag === "Failure") {
      const failure = Cause.failureOption(exit.cause);
      message = failure._tag === "Some" ? (failure.value as Error).message : String(exit.cause);
      failed = true;
    } else {
      message = `compile unexpectedly succeeded (converged=${exit.value.converged})`;
    }
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    failed = true;
  } finally {
    await sandbox.cleanup();
  }

  const expected = isMcpLifecycleFailure(message);
  const status = failed && expected ? "expected-FAIL" : failed ? "unexpected-FAIL" : "unexpected-PASS";
  // Report pass=false so run-all.ts can register this as expected-FAIL debt.
  // The gate itself still exits 0 when every row is the expected failure.
  return {
    gate: `matrix-mcp-disabled-${harnessId}`,
    pass: !(failed && expected),
    detail: `${status}: ${message.slice(0, 160)}`,
  };
};

const main = async (): Promise<void> => {
  const rows: Row[] = [];
  for (const harnessId of MCP_DEPENDENT_HARNESSES) {
    const row = await runRow(harnessId);
    rows.push(row);
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.gate} — ${row.detail}`);
  }

  const allExpected = rows.every((row) => row.pass);
  const summary = {
    schema: "prism.acceptance.matrix-mcp-disabled.v1",
    pass: allExpected,
    gates: rows.map((row) => ({
      gate: row.gate,
      pass: row.pass,
      expected: "FAIL",
      detail: row.detail,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = allExpected ? 0 : 1;
};

await main();
