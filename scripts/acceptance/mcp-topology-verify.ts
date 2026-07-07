/**
 * Acceptance gate: mcp-topology-verify.
 *
 * The DETERMINISTIC falsifier for the per-plugin MCP topology (one MCP
 * server per MCP-owning plugin, per harness, keyed by `pluginServerKey`,
 * never a shared aggregated shim). The six invariants (A-F) are implemented
 * once, in `src/doctor/mcp-topology-checks.ts` — this script is a thin CLI
 * over that shared module, the acceptance-gate surface next to `prism
 * doctor`'s `topology.*` runtime-backpressure surface. See that module's own
 * header comment for the full assertion catalog and scope boundary.
 *
 * It reads INSTALLED harness configs — either the real machine's harness
 * roots or `--root <harness>=<path>` overrides for sandboxed use — plus the
 * compiled plugin inventory (the plugin.json corpus passed via `--plugins
 * <dir>`, one level of `plugin.json`-bearing subdirectories, mirroring
 * `discoverPluginPaths`).
 *
 * Two run modes:
 *
 *   bun scripts/acceptance/mcp-topology-verify.ts
 *     Self-contained acceptance mode (the `acceptance:mcp-topology` script).
 *     Compiles `examples/prism-harness-qa` for real, via the real compile
 *     pipeline, into a sandboxed PRISM_HOME + per-harness temp roots
 *     (`createPrismSandbox`), then verifies the topology invariants against
 *     that real compiled output. Deterministic, CI-safe, never touches a
 *     real harness root.
 *
 *   bun scripts/acceptance/mcp-topology-verify.ts --plugins <dir> \
 *       [--harness <id> ...] [--root <harness>=<path> ...]
 *     Diagnostic mode. Verifies the topology invariants against REAL
 *     installed harness configs (or `--root` overrides for sandboxed use),
 *     treating every `plugin.json`-bearing subdirectory of `<dir>` as the
 *     installed plugin set.
 *
 * Output: a PASS/FAIL line + violation detail per harness, followed by one
 * JSON report `{ schema, harnesses: [{ harness, root, serversFound,
 * violations }], pass }`. Exit 0 iff `pass`.
 */

import { Effect, Layer } from "effect";
import { resolve } from "node:path";
import { compilePluginForTarget } from "../../src/compile/pipeline.js";
import { getHarness } from "../../src/harnesses.js";
import { discoverPluginPaths } from "../../src/plugin-inventory.js";
import { HarnessRoots, type HarnessRootsEnv } from "../../src/services/prism-env.js";
import { createPrismSandbox } from "../../src/testing/prism-sandbox.js";
import type { HarnessId } from "../../src/types.js";
import { SHIM_HARNESS_IDS, type ShimHarnessId } from "@skastr0/prism-sdk/mcp/wire-naming";
import { verifyTopology, type TopologyReport } from "../../src/doctor/mcp-topology-checks.js";

// Re-exported so downstream callers (this script's own test file, other
// acceptance/diagnostic tooling) keep a single stable import path — the
// assertion engine itself lives in the shared doctor module.
export {
  isShimHarnessId,
  loadPluginInventory,
  verifyHarnessTopology,
  verifyTopology,
  TOPOLOGY_FINDING_CODES,
  type HarnessTopologyReport,
  type McpTopologyAssertion,
  type McpTopologyViolation,
  type PluginInventory,
  type PluginRecord,
  type TopologyReport,
  type VerifyTopologyOptions,
} from "../../src/doctor/mcp-topology-checks.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SELF_TEST_PLUGIN_PATH = resolve(REPO_ROOT, "examples", "prism-harness-qa");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const printReport = (report: TopologyReport): void => {
  for (const harnessReport of report.harnesses) {
    const pass = harnessReport.violations.length === 0;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${harnessReport.harness} — ${harnessReport.serversFound} server(s), ${harnessReport.violations.length} violation(s) @ ${harnessReport.root}`,
    );
    for (const violation of harnessReport.violations) {
      const server = violation.serverKey ? ` server=${violation.serverKey}` : "";
      const plugin = violation.plugin ? ` plugin=${violation.plugin}` : "";
      console.log(`  ! [${violation.assertion}] ${violation.code}${server}${plugin} — ${violation.message}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
};

const flagValues = (args: readonly string[], name: string): string[] => {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1] !== undefined) out.push(args[index + 1]!);
  }
  return out;
};

const parseRootOverrides = (raw: readonly string[]): Map<HarnessId, string> => {
  const overrides = new Map<HarnessId, string>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new Error(`mcp-topology-verify: --root must be '<harness>=<path>', got '${entry}'`);
    }
    overrides.set(entry.slice(0, eq) as HarnessId, resolve(entry.slice(eq + 1)));
  }
  return overrides;
};

const runDiagnosticMode = async (
  pluginsDir: string,
  harnesses: readonly ShimHarnessId[],
  rootOverrides: ReadonlyMap<HarnessId, string>,
): Promise<TopologyReport> => {
  const pluginPaths = await discoverPluginPaths(resolve(pluginsDir));
  const roots: HarnessRootsEnv = {
    resolve: (harness) => rootOverrides.get(harness) ?? getHarness(harness).globalConfigPath,
  };
  return verifyTopology({ pluginPaths, harnesses, roots });
};

const runSelfTestMode = async (harnesses: readonly ShimHarnessId[]): Promise<TopologyReport> => {
  const sandbox = await createPrismSandbox();
  try {
    for (const harness of harnesses) {
      await Effect.runPromise(
        compilePluginForTarget({
          pluginPath: SELF_TEST_PLUGIN_PATH,
          target: harness,
          scope: "global",
          prismHome: sandbox.prismHome,
          dryRun: false,
          mcpLifecycle: "none",
        }).pipe(Effect.provide(Layer.succeed(HarnessRoots, sandbox.roots))),
      );
    }
    return await verifyTopology({
      pluginPaths: [SELF_TEST_PLUGIN_PATH],
      harnesses,
      roots: sandbox.roots,
    });
  } finally {
    await sandbox.cleanup();
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const pluginsDir = flagValues(args, "--plugins").at(-1);
  const harnessArgs = flagValues(args, "--harness");
  const harnesses = (harnessArgs.length > 0 ? harnessArgs : [...SHIM_HARNESS_IDS]) as ShimHarnessId[];
  const rootOverrides = parseRootOverrides(flagValues(args, "--root"));

  const report =
    pluginsDir !== undefined
      ? await runDiagnosticMode(pluginsDir, harnesses, rootOverrides)
      : await runSelfTestMode(harnesses);

  printReport(report);
  process.exitCode = report.pass ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
