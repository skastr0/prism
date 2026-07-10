/**
 * Global bun test preload (wired via bunfig.toml [test].preload).
 *
 * Guarantees test isolation from the real `~/.prism`:
 *  1. Creates a fresh mkdtemp PRISM_HOME for the whole test process and sets
 *     the env var before any test module is imported. `resolvePrismHome()`
 *     reads `process.env.PRISM_HOME` lazily at call time (no import-time
 *     cache), so setting the env here is sufficient for in-process code, and
 *     CLI subprocess tests merge `process.env` so spawned prism CLIs inherit
 *     the sandbox unless a test overrides it with its own temp home.
 *  2. Hard-fails the run if PRISM_HOME still resolves to the real `~/.prism`.
 *  3. Re-asserts after every test that no test left PRISM_HOME pointing at
 *     the real `~/.prism` (catches env clobbering mid-suite).
 *
 * NOTE: A HOME guard is intentionally deferred. Existing tests compute expected
 * harness-root paths with `os.homedir()`, and Bun's implementation ignores
 * runtime `process.env.HOME` changes, so sandboxing HOME here would diverge
 * from those expectations. New tests should use `withPrismSandbox` from
 * `src/testing/prism-sandbox.ts` instead of mutating HOME.
 */

import { afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePrismHome } from "../src/prism-home.js";

const realPrismHome = resolve(join(homedir(), ".prism"));

const sandboxPrismHome = mkdtempSync(
  join(realpathSync(tmpdir()), "prism-test-home-"),
);
process.env.PRISM_HOME = sandboxPrismHome;

// Production defaults: MCP harness emit OFF, CLI tools surface ON.
// Lowerer/MCP goldens and acceptance suites still assert shim config and
// predate CLI inject regions — opt them into the legacy MCP surface unless a
// test overrides explicitly.
if (process.env.PRISM_TOOLS_MCP_EMIT === undefined) {
  process.env.PRISM_TOOLS_MCP_EMIT = "1";
}
if (process.env.PRISM_TOOLS_CLI_EMIT === undefined) {
  process.env.PRISM_TOOLS_CLI_EMIT = "0";
}

const assertSandboxed = (phase: string): void => {
  const resolved = resolve(resolvePrismHome());
  if (resolved === realPrismHome || resolved.startsWith(`${realPrismHome}/`)) {
    throw new Error(
      `Test hygiene violation (${phase}): PRISM_HOME resolves to the real '${realPrismHome}'. ` +
        "Tests must never touch real Prism state; set PRISM_HOME to a temp directory.",
    );
  }
};

assertSandboxed("preload");

afterEach(() => {
  assertSandboxed("afterEach");
});

process.on("exit", () => {
  rmSync(sandboxPrismHome, { recursive: true, force: true });
});
