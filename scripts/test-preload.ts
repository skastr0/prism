/**
 * Global bun test preload (wired via bunfig.toml [test].preload).
 *
 * Makes plain `bun test` self-sufficient on a clean checkout: rebuilds the
 * untracked build outputs the suite imports when their inputs changed (see
 * scripts/test-build-artifacts.ts).
 *
 * Gives the run a private TMPDIR under /tmp, removed on exit. Bun 1.3.14's
 * bundler resolver keeps every long directory-entry name it reads for the life
 * of the process, and each in-process `Bun.build` re-reads the ancestors of its
 * entry. With test fixtures under a shared $TMPDIR holding ~100k entries (other
 * projects' leftovers), each build leaked ~40MB and the suite segfaulted around
 * its 70th build. A fresh, small parent keeps that cost proportional to this
 * run's own temp dirs. Bun 1.4.2 no longer leaks.
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
import { ensureTestBuildArtifacts } from "./test-build-artifacts.js";

await ensureTestBuildArtifacts();

// Imported after the build: src modules resolve @skastr0/prism-sdk from dist.
const { resolvePrismHome } = await import("../src/prism-home.js");

const realPrismHome = resolve(join(homedir(), ".prism"));

const sandboxTmp = mkdtempSync(
  join(realpathSync(process.platform === "win32" ? tmpdir() : "/tmp"), "prism-test-run-"),
);
process.env.TMPDIR = sandboxTmp;

const sandboxPrismHome = mkdtempSync(join(sandboxTmp, "prism-test-home-"));
process.env.PRISM_HOME = sandboxPrismHome;

// CLI tools surface is the only tools path. Tests may override
// PRISM_TOOLS_CLI_EMIT; harness MCP emit is retired.
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
  rmSync(sandboxTmp, { recursive: true, force: true });
});
