/**
 * Doctor-level proof for the `topology.*` finding family
 * (`src/doctor/mcp-topology-checks.ts` wired into `runDoctor` via
 * `--plugins <dir>`). Unlike `finding-catalog.test.ts` and
 * `doctor-contract.test.ts` (which drive the generic table of harness-config
 * findings), this exercises the topology check family end-to-end through
 * `runDoctor` itself — proving both the clean path (a compiler-correct
 * install reports zero `topology.*` findings) and the backpressure path (a
 * seeded violation is detected and reported under the new family).
 */

import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import { generatedToolNameForBinding } from "../compile/generated-plugin.js";
import { loadPlugin } from "../compile/load.js";
import { resolveOwnedMcpBindingsForTarget } from "../compile/pipeline.js";
import { runDoctor } from "../doctor.js";
import { withDoctorWorld } from "./test-fixtures.js";

const writeFixturePlugin = async (
  pluginsRoot: string,
  options: { readonly name: string; readonly ownTools?: readonly string[] },
): Promise<void> => {
  const pluginPath = join(pluginsRoot, options.name);
  await mkdir(pluginPath, { recursive: true });
  await writeFile(
    join(pluginPath, "plugin.json"),
    `${JSON.stringify(
      { name: options.name, version: "0.1.0", targets: { tools: ["codex-cli"] } },
      null,
      2,
    )}\n`,
  );
  if (options.ownTools && options.ownTools.length > 0) {
    await mkdir(join(pluginPath, "tools"), { recursive: true });
    for (const tool of options.ownTools) {
      await writeFile(
        join(pluginPath, "tools", `${tool}.tool.ts`),
        [
          `export default {`,
          `  name: ${JSON.stringify(tool)},`,
          `  description: "Fixture tool '${tool}'",`,
          `  input: {},`,
          `  output: {},`,
          `  handle: async () => ({}),`,
          `};`,
          ``,
        ].join("\n"),
      );
    }
  }
};

test("doctor --plugins reports zero topology findings for a compiler-correct install", async () => {
  await withDoctorWorld(async (world) => {
    const pluginsRoot = join(world.sandbox.root, "plugins");
    const pluginPath = join(pluginsRoot, "widget");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"] });

    // Ground the expected allowlist through the SAME compiler predicate the
    // topology engine itself uses (`resolveOwnedMcpBindingsForTarget`) —
    // never a hand-guessed wire name.
    const registry = await Effect.runPromise(loadPlugin(pluginPath));
    const ownedBindings = await Effect.runPromise(
      resolveOwnedMcpBindingsForTarget(registry, "codex-cli", "global"),
    );
    const expectedAllowlist = ownedBindings.map((binding) =>
      renderPluginAllowlist("codex-cli", "widget", generatedToolNameForBinding("widget", binding)),
    );

    const serverKey = pluginServerKey("widget");
    await world.writeText(
      join(world.rootFor("codex-cli"), "config.toml"),
      [
        `[mcp_servers."${serverKey}"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = ${JSON.stringify(expectedAllowlist)}`,
        `[mcp_servers."${serverKey}".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await runDoctor({
      harnesses: ["codex-cli"],
      scope: "global",
      prismHome: world.sandbox.prismHome,
      roots: world.sandbox.roots,
      fix: false,
      pluginsDir: pluginsRoot,
    });

    const topologyFindings = report.findings.filter((finding) => finding.family === "topology.invariant");
    expect(topologyFindings).toEqual([]);
  });
});

test("doctor --plugins accepts the production-default CLI topology with no MCP server", async () => {
  await withDoctorWorld(async (world) => {
    const pluginsRoot = join(world.sandbox.root, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"] });
    const previous = process.env.PRISM_TOOLS_MCP_EMIT;

    delete process.env.PRISM_TOOLS_MCP_EMIT;
    try {
      const report = await runDoctor({
        harnesses: ["codex-cli"],
        scope: "global",
        prismHome: world.sandbox.prismHome,
        roots: world.sandbox.roots,
        fix: false,
        pluginsDir: pluginsRoot,
      });

      const topologyCodes = report.findings
        .filter((finding) => finding.family === "topology.invariant")
        .map((finding) => finding.code);
      expect(topologyCodes).not.toContain("topology.owner-missing-server");
      expect(topologyCodes).not.toContain("topology.mcp-disabled-server");
    } finally {
      if (previous === undefined) delete process.env.PRISM_TOOLS_MCP_EMIT;
      else process.env.PRISM_TOOLS_MCP_EMIT = previous;
    }
  });
});

test("doctor --plugins detects a seeded topology violation (the retired aggregated shim key)", async () => {
  await withDoctorWorld(async (world) => {
    const pluginsRoot = join(world.sandbox.root, "plugins");
    await writeFixturePlugin(pluginsRoot, { name: "widget", ownTools: ["foo"] });

    // Seed assertion A's violation: the retired aggregated shim key, still
    // naming 'widget' as its sole owner.
    await world.writeText(
      join(world.rootFor("codex-cli"), "config.toml"),
      [
        `[mcp_servers."prism-mcp-shim"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."prism-mcp-shim".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await runDoctor({
      harnesses: ["codex-cli"],
      scope: "global",
      prismHome: world.sandbox.prismHome,
      roots: world.sandbox.roots,
      fix: false,
      pluginsDir: pluginsRoot,
    });

    const topologyCodes = report.findings
      .filter((finding) => finding.family === "topology.invariant")
      .map((finding) => finding.code);
    expect(topologyCodes).toContain("topology.legacy-shim-key");
    // The catalog contract stays in force: every emitted code is registered.
    for (const code of topologyCodes) {
      expect(code.startsWith("topology.")).toBe(true);
    }
  });
});

test("doctor without --plugins emits zero topology findings (opt-in, unchanged pre-existing behavior)", async () => {
  await withDoctorWorld(async (world) => {
    await world.writeText(
      join(world.rootFor("codex-cli"), "config.toml"),
      [
        `[mcp_servers."prism-mcp-shim"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = []`,
        `[mcp_servers."prism-mcp-shim".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await runDoctor({
      harnesses: ["codex-cli"],
      scope: "global",
      prismHome: world.sandbox.prismHome,
      roots: world.sandbox.roots,
      fix: false,
    });

    const topologyFindings = report.findings.filter((finding) => finding.family === "topology.invariant");
    expect(topologyFindings).toEqual([]);
  });
});
