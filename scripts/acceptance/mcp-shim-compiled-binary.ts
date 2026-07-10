/**
 * Acceptance gate: mcp-shim-compiled-binary (UDS-000 wave 2.5 regression net;
 * migrated to UDS-only in the WS6 manual-TCP-daemon retirement).
 *
 * Builds the REAL standalone `prism` binary (`bun build --compile`, current
 * platform only — cross-target coverage is `bun run build`'s job, not this
 * gate's) and runs `refresh` against a minimal MCP-owner plugin fixture,
 * asserting exit 0, the generated `.mcp.json` artifact, and the canonical
 * UDS-only server bundle. It also proves `prism mcp status` works against
 * the real binary over the UDS registry (no crash, reports a state) --
 * there is no more TCP transport to select, so there is nothing left to loop
 * over per-transport.
 *
 * This is the exact gap every other gate missed: `runtime-deps.test.ts`
 * exercises `udsRegistryBundleImportPath`/`udsSingletonBundleImportPath`'s
 * resolution logic directly (interpreted), and `mcp-bundle.test.ts` builds
 * MCP server bundles via `Bun.build` — but neither ever runs the *compiled*
 * `prism` binary itself, which is the only place a relative
 * `import.meta.resolve` from an embedded module resolves differently than
 * from a real source-tree file. Only compiling and running the standalone
 * binary reproduces the "Could not resolve" `Bun.build` failure this wave's
 * fixes target -- and, for WS6, the "Streamable HTTP MCP transport requires
 * a resolved port before URL rendering" failure the manual-TCP-daemon
 * retirement fixes.
 *
 * Sandboxed against a SHORT `/tmp`-rooted HOME (never `os.tmpdir()`'s
 * `/var/folders/...`, which already eats most of the 100-byte
 * `sockaddr_un.sun_path` budget `uds-path.ts` enforces) — `HOME` covers both
 * `resolvePrismHome()`'s default (`~/.prism`) and the claude-code harness's
 * global root (`~/.claude/`), so one override sandboxes both.
 *
 * Usage: bun scripts/acceptance/mcp-shim-compiled-binary.ts
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { constants, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile as compilePrismBinary, type Target } from "../compile.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HARNESS = "claude-code";
const PLUGIN_NAME = "shim-smoke";

interface SubGate {
  readonly gate: string;
  readonly pass: boolean;
  readonly expected: "PASS";
  readonly detail: string;
}

const run = async (
  cmd: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const currentBinaryTarget = (): Target => {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    (process.arch !== "x64" && process.arch !== "arm64")
  ) {
    throw new Error(`unsupported binary acceptance target ${process.platform}-${process.arch}`);
  }
  return { platform: process.platform, arch: process.arch };
};

/** Minimal MCP-owner plugin: one tool bound to claude-code, nothing else. */
const writeFixturePlugin = async (pluginRoot: string): Promise<void> => {
  await writeFile(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: "0.1.0",
        targets: { tools: [HARNESS] },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(pluginRoot, "tools"), { recursive: true });
  await writeFile(
    join(pluginRoot, "tools", "echo.tool.ts"),
    // \`import type\` for "prism" is erased by Bun's transpiler before
    // runtime module resolution ever runs -- no real "prism" package needs
    // to exist in node_modules (mirrors examples/prism-harness-qa).
    `import { Schema } from "effect";
import type { ToolSource } from "prism";

export default {
  name: "echo",
  description: "Echo for the compiled-binary shim smoke gate.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  handle(input) {
    return { message: input.message };
  },
} satisfies ToolSource;
`,
  );
};

const mcpConfigPath = (home: string): string =>
  join(home, ".claude", "skills", `prism-generated-${PLUGIN_NAME}`, ".mcp.json");

const canonicalBundlePath = (home: string): string =>
  join(home, ".prism", "runtime", "mcp", PLUGIN_NAME, "server.mjs");

const runShimSmoke = async (options: {
  readonly binaryPath: string;
  readonly pluginRoot: string;
  readonly packageRoot: string;
  readonly work: string;
}): Promise<{ readonly gates: SubGate[]; readonly failures: string[] }> => {
  const { binaryPath, pluginRoot } = options;
  const home = await mkdtemp(join(options.work, "h-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    // The standalone binary has no real node_modules of its own next to it
    // (unlike a real npm install, where the platform package ships one
    // specifically for this): point runtime-deps.ts's resolver at a real
    // package root instead, matching how the npm wrapper passes this same
    // env var (see packages/npm/prism/bin/prism.js).
    PRISM_RUNTIME_DEPS_PACKAGE_ROOT: options.packageRoot,
    // This gate asserts harness MCP artifacts. Default MCP emit is off (CLI
    // tools surface); force it on so the shim path stays covered.
    PRISM_TOOLS_MCP_EMIT: "1",
  };
  const gates: SubGate[] = [];
  const failures: string[] = [];

  const refreshResult = await run(
    [binaryPath, "refresh", pluginRoot, "--harness", HARNESS, "--scope", "global"],
    { cwd: pluginRoot, env },
  );

  const exitOk = refreshResult.exitCode === 0;
  gates.push({
    gate: "mcp-shim-compiled-binary:refresh-exit-0",
    pass: exitOk,
    expected: "PASS",
    detail: exitOk
      ? "refresh exited 0"
      : `refresh exited ${refreshResult.exitCode}; stderr: ${refreshResult.stderr.trim().slice(0, 2_000) || refreshResult.stdout.trim().slice(0, 2_000)}`,
  });
  if (!exitOk) {
    failures.push(`refresh failed (exit ${refreshResult.exitCode})`);
  }

  const configPath = mcpConfigPath(home);
  const configExists = await pathExists(configPath);
  gates.push({
    gate: "mcp-shim-compiled-binary:mcp-json-artifact",
    pass: configExists,
    expected: "PASS",
    detail: configExists ? `${configPath} written` : `${configPath} missing`,
  });
  if (!configExists) failures.push(".mcp.json artifact missing");

  const bundlePath = canonicalBundlePath(home);
  const bundleExists = await pathExists(bundlePath);
  gates.push({
    gate: "mcp-shim-compiled-binary:server-bundle-built",
    pass: bundleExists,
    expected: "PASS",
    detail: bundleExists
      ? `${bundlePath} built (uds-registry/uds-singleton resolved from the compiled binary)`
      : `${bundlePath} missing`,
  });
  if (!bundleExists) failures.push("canonical server.mjs bundle missing");

  // `mcp status` is pure observability over the UDS registry -- it must
  // never crash even when nothing has ever spawned a daemon for this plugin
  // (refresh only compiles the bundle; the shim resolve-or-spawns a daemon
  // lazily on first tool call). A clean "stopped" report proves the status
  // path works end to end from the compiled binary.
  const statusResult = await run(
    [binaryPath, "mcp", "status", pluginRoot, "--harness", HARNESS, "--scope", "global"],
    { cwd: pluginRoot, env },
  );
  const statusOk = statusResult.exitCode === 0 && /^stopped\s/.test(statusResult.stdout.trim());
  gates.push({
    gate: "mcp-shim-compiled-binary:mcp-status-uds",
    pass: statusOk,
    expected: "PASS",
    detail: statusOk
      ? `mcp status reported: ${statusResult.stdout.trim()}`
      : `mcp status exited ${statusResult.exitCode}; stdout: ${statusResult.stdout.trim().slice(0, 500)}; stderr: ${statusResult.stderr.trim().slice(0, 500)}`,
  });
  if (!statusOk) failures.push("mcp status failed or did not report a clean state over UDS");

  return { gates, failures };
};

const main = async (): Promise<void> => {
  const work = await mkdtemp("/tmp/prism-shim-smoke-");
  let gates: SubGate[] = [];
  let failures: string[] = [];

  try {
    const pluginRoot = join(work, "plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFixturePlugin(pluginRoot);
    // The fixture's `import { Schema } from "effect"` needs a real
    // node_modules to resolve against when the compiled binary loads the
    // tool source (mirrors mcp-determinism.ts's own fixture setup).
    await symlink(join(REPO_ROOT, "node_modules"), join(work, "node_modules"), "dir");

    // A real npm-installed platform package ships its own node_modules
    // (effect/zod/mcp-sdk/typescript/@skastr0/prism-sdk/...) right next to
    // the binary; a bare `bun build --compile` output has none. Simulate
    // the shipped-package shape so `resolveRuntimePackageImportPath` (see
    // runtime-deps.ts) has a real root to resolve against, exactly as the
    // npm wrapper does via `PRISM_RUNTIME_DEPS_PACKAGE_ROOT` (see
    // packages/npm/prism/bin/prism.js).
    const packageRoot = join(work, "binary-package-root");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `{"name":"prism-binary-acceptance","type":"module"}\n`,
    );
    await symlink(join(REPO_ROOT, "node_modules"), join(packageRoot, "node_modules"), "dir");

    const binaryPath = join(work, "bin", "prism");
    await mkdir(join(work, "bin"), { recursive: true });
    await compilePrismBinary(currentBinaryTarget(), binaryPath);

    const result = await runShimSmoke({ binaryPath, pluginRoot, packageRoot, work });
    gates = result.gates;
    failures = result.failures;
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  for (const gate of gates) {
    console.log(`${gate.pass ? "PASS" : "FAIL"}  ${gate.gate} — ${gate.detail}`);
  }

  const regressions = gates.filter((gate) => !gate.pass);
  const summary = {
    gate: "mcp-shim-compiled-binary",
    pass: regressions.length === 0,
    gates,
    details: {
      plugin: PLUGIN_NAME,
      harness: HARNESS,
      transport: "uds-only",
      ...(failures.length > 0 ? { failures } : {}),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = regressions.length === 0 ? 0 : 1;
};

await main();
