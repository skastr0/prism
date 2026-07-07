import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRootsEnv } from "../../src/services/prism-env.js";
import type { HarnessId } from "../../src/types.js";
import type { ShimHarnessId } from "@skastr0/prism-sdk/mcp/wire-naming";
import { verifyTopology } from "./mcp-topology-verify";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-topology-verify-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** A minimal `plugin.json` + `tools/*.tool.ts` corpus entry — enough for `loadPluginInventory` to read without exercising the full compile pipeline. */
const writeFixturePlugin = async (
  pluginsRoot: string,
  options: { readonly name: string; readonly ownTools?: readonly string[]; readonly targetsTools?: readonly HarnessId[] },
): Promise<string> => {
  const pluginPath = join(pluginsRoot, options.name);
  await mkdir(pluginPath, { recursive: true });
  await writeFile(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify(
      { name: options.name, version: "0.1.0", targets: { tools: options.targetsTools ?? [] } },
      null,
      2,
    )}\n`,
  );
  if (options.ownTools && options.ownTools.length > 0) {
    await mkdir(join(pluginPath, "tools"), { recursive: true });
    for (const tool of options.ownTools) {
      await writeFile(
        join(pluginPath, "tools", `${tool}.tool.ts`),
        `export default { name: ${JSON.stringify(tool)} };\n`,
      );
    }
  }
  return pluginPath;
};

const singleHarnessRoots = (harness: ShimHarnessId, root: string): HarnessRootsEnv => ({
  resolve: (id) => {
    if (id !== harness) throw new Error(`unexpected harness root lookup for '${id}' in a single-harness fixture`);
    return root;
  },
});

const findViolationCodes = (
  report: Awaited<ReturnType<typeof verifyTopology>>,
  harness: ShimHarnessId,
): string[] => report.harnesses.find((entry) => entry.harness === harness)?.violations.map((v) => v.code) ?? [];

// ---------------------------------------------------------------------------
// A — naming
// ---------------------------------------------------------------------------

test("assertion A detects the legacy shim key, the legacy hash key, and a shim substring in a server key", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"], targetsTools: ["codex-cli"] });

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.toml"),
      [
        `[mcp_servers."prism-mcp-shim"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."prism-mcp-shim".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
        `[mcp_servers."p_deadbeef"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."p_deadbeef".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
        `[mcp_servers."my-shim-thing"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."my-shim-thing".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "widget")],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.legacy-shim-key");
    expect(codes).toContain("topology.legacy-hash-key");
    expect(codes).toContain("topology.shim-substring-in-key");
    expect(codes.filter((code) => code === "topology.unrecognized-server-key")).toHaveLength(3);
    expect(report.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B — owned-only
// ---------------------------------------------------------------------------

test("assertion B detects a non-single PRISM_SHIM_PLUGINS owner and an allowlist that is not the owner's own tools", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"], targetsTools: ["codex-cli"] });
    await writeFixturePlugin(pluginsRoot, {
      name: "widget2",
      ownTools: ["real_tool"],
      targetsTools: ["codex-cli"],
    });

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.toml"),
      [
        `[mcp_servers."widget"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."widget".env]`,
        `PRISM_SHIM_PLUGINS = "widget,extra"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
        `[mcp_servers."widget2"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = ["bogus_tool"]`,
        `[mcp_servers."widget2".env]`,
        `PRISM_SHIM_PLUGINS = "widget2"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "widget"), join(pluginsRoot, "widget2")],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.plugins-env-not-single-owner");
    expect(codes).toContain("topology.allowlist-mismatch");
    expect(report.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C — no consumer servers / no 0-tool servers
// ---------------------------------------------------------------------------

test("assertion C detects a server for a non-owning consumer plugin and a zero-tool owner server", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "consumer", targetsTools: ["codex-cli"] });
    await writeFixturePlugin(pluginsRoot, {
      name: "owner3",
      ownTools: ["real_tool"],
      targetsTools: ["codex-cli"],
    });

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.toml"),
      [
        `[mcp_servers."consumer"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."consumer".env]`,
        `PRISM_SHIM_PLUGINS = "consumer"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
        `[mcp_servers."owner3"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."owner3".env]`,
        `PRISM_SHIM_PLUGINS = "owner3"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "consumer"), join(pluginsRoot, "owner3")],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.consumer-has-server");
    expect(codes).toContain("topology.zero-tool-server");
    expect(report.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D — no duplication
// ---------------------------------------------------------------------------

test("assertion D detects a duplicated owner server across two generated bundle dirs and a duplicated tool name", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, {
      name: "widget",
      ownTools: ["shared_tool"],
      targetsTools: ["kimi-code"],
    });

    const root = join(dir, "harnesses", "kimi-code");
    const kimiServer = (enabledTools: readonly string[]): string =>
      JSON.stringify(
        {
          name: "prism-generated-widget",
          version: "0.1.0",
          mcpServers: {
            widget: {
              enabled: true,
              command: "prism",
              args: ["mcp", "shim"],
              env: {
                PRISM_SHIM_PLUGINS: "widget",
                PRISM_SHIM_HARNESS: "kimi-code",
                PRISM_SHIM_NAMING: "per-plugin",
              },
              enabledTools: enabledTools,
            },
          },
        },
        null,
        2,
      );
    await mkdir(join(root, "plugins", "managed", "prism-generated-widget-a"), { recursive: true });
    await writeFile(
      join(root, "plugins", "managed", "prism-generated-widget-a", "kimi.plugin.json"),
      kimiServer(["shared_tool"]),
    );
    await mkdir(join(root, "plugins", "managed", "prism-generated-widget-b"), { recursive: true });
    await writeFile(
      join(root, "plugins", "managed", "prism-generated-widget-b", "kimi.plugin.json"),
      kimiServer(["shared_tool", "shared_tool"]),
    );

    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "widget")],
      harnesses: ["kimi-code"],
      roots: singleHarnessRoots("kimi-code", root),
    });

    const codes = findViolationCodes(report, "kimi-code");
    expect(codes).toContain("topology.duplicate-owner-server");
    expect(codes).toContain("topology.duplicate-fq-tool-name");
    expect(codes).toContain("topology.duplicate-tool-in-allowlist");
    expect(report.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E — coverage
// ---------------------------------------------------------------------------

test("assertion E detects an owner plugin targeting a harness with no server present", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"], targetsTools: ["codex-cli"] });

    const root = join(dir, "harnesses", "codex-cli");
    // No config.toml at all — the harness root exists but is unconfigured.
    await mkdir(root, { recursive: true });

    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "widget")],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.owner-missing-server");
    expect(report.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F — no dead transports
// ---------------------------------------------------------------------------

test("assertion F detects a prism-looking server carrying a dead HTTP url transport", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"], targetsTools: ["codex-cli"] });

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.toml"),
      [
        `[mcp_servers."widget"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `url = "http://127.0.0.1:4321"`,
        `enabled_tools = ["foo"]`,
        `[mcp_servers."widget".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "widget")],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.dead-http-transport");
    expect(report.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Baseline — a real compile must pass with zero violations (no false
// positives). This is exercised as a `bun run` acceptance check rather than
// a `bun:test` case: `compilePluginForTarget`'s process-wide authoring-runtime
// cache (`src/compile/authoring-runtime.ts`'s `cachedRuntimePath`) hits a
// pre-existing "Unseekable reading file" Bun bundler failure when a SECOND
// compile call reuses that cached temp path from within `bun test`'s runner
// — reproduced with an unrelated pre-existing compile test file too, so it
// is not specific to this script. `bun run scripts/acceptance/mcp-topology-verify.ts`
// (the `acceptance:mcp-topology` script, self-test mode) exercises this
// exact path via a plain `bun run` and passes deterministically.
// ---------------------------------------------------------------------------
