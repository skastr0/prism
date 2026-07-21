import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { generatedToolNameForBinding } from "../../src/compile/generated-plugin.js";
import { loadPlugin } from "../../src/compile/load.js";
import { resolveOwnedMcpBindingsForTarget } from "../../src/compile/pipeline.js";
import type { HarnessRootsEnv } from "../../src/services/prism-env.js";
import type { HarnessId } from "../../src/types.js";
import {
  pluginServerKey,
  renderPluginAllowlist,
  type ShimHarnessId,
} from "@skastr0/prism-sdk/mcp/wire-naming";
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

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

// Resolved off THIS file's own location (via `import.meta`) rather than
// `process.cwd()` — this script runs fine from a worktree that carries no
// local `node_modules` of its own, where a cwd-joined path would 404 (Bun's
// own resolver walks up through parent `node_modules` directories; a
// hand-joined path does not).
const effectImportPath = import.meta.resolve("effect");
const prismImportPath = new URL("../../src/index.ts", import.meta.url).href;

/**
 * A `plugin.json` + `tools/*.tool.ts` corpus entry. `loadPluginInventory`
 * now recomputes ownership through the real compiler predicate
 * (`resolveOwnedMcpBindingsForTarget` -> `loadPlugin` + `resolveAgent` +
 * `bindingsOwnedByPlugin`), so a fixture tool must be a real, loadable
 * `ToolSource` (`description`/`input`/`output`/`handle` all present, `handle`
 * a function, `name` matching the file stem) — a bare `{ name }` stub fails
 * `parseCanonicalTool`'s strict decode and makes the whole plugin fail to
 * load, which is indistinguishable from "owns nothing".
 */
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

test("assertion E accepts zero servers when harness MCP emission is disabled", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    await writeFixturePlugin(pluginsRoot, {
      name: "widget",
      ownTools: ["foo"],
      targetsTools: ["codex-cli"],
    });

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    const report = await verifyTopology({
      pluginPaths: [join(pluginsRoot, "widget")],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
      mcpEmitEnabled: false,
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).not.toContain("topology.owner-missing-server");
    expect(codes).not.toContain("topology.mcp-disabled-server");
    expect(report.pass).toBe(true);
  });
});

test("assertion E rejects a residual generated server when harness MCP emission is disabled", async () => {
  await withTempDir(async (dir) => {
    const pluginsRoot = join(dir, "plugins");
    const pluginPath = await writeFixturePlugin(pluginsRoot, {
      name: "widget",
      ownTools: ["foo"],
      targetsTools: ["codex-cli"],
    });
    const registry = await Effect.runPromise(loadPlugin(pluginPath));
    const ownedBindings = await Effect.runPromise(
      resolveOwnedMcpBindingsForTarget(registry, "codex-cli", "global"),
    );
    const allowlist = ownedBindings.map((binding) =>
      renderPluginAllowlist(
        "codex-cli",
        "widget",
        generatedToolNameForBinding("widget", binding),
      ),
    );

    const root = join(dir, "harnesses", "codex-cli");
    await writeText(
      join(root, "config.toml"),
      [
        `[mcp_servers."widget"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = ${JSON.stringify(allowlist)}`,
        `[mcp_servers."widget".env]`,
        `PRISM_SHIM_PLUGINS = "widget"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [pluginPath],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
      mcpEmitEnabled: false,
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.mcp-disabled-server");
    expect(codes).not.toContain("topology.owner-missing-server");
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

// ---------------------------------------------------------------------------
// Owner detection — dispatch-only owners (forge-shaped: zero canonical
// tools, an MCP presence carried entirely by a trait's synthetic
// contract-dispatch binding over a FOREIGN plugin's tool) must be
// recognized as owners; a plugin that merely CONSUMES a foreign tool
// (a plain, unfilled-slot permission binding) must stay a non-owner.
//
// These fixtures never call `compilePluginForTarget` (the risky path the
// baseline comment above documents) — they call the exact same compiler
// predicate the fix wires the verifier through (`loadPlugin` +
// `resolveOwnedMcpBindingsForTarget`), which is the lightweight source-load
// path already exercised by every `writeFixturePlugin`-based test above.
// ---------------------------------------------------------------------------

/** `provider/tools/<name>.tool.ts` — real slots when `slotted` is set, so a trait can fill them and produce a synthetic binding. */
const writeProviderTool = async (
  providerPath: string,
  name: string,
  options: { readonly slotted?: boolean } = {},
): Promise<void> => {
  await writeText(
    join(providerPath, "tools", `${name}.tool.ts`),
    [
      `import { Schema } from ${JSON.stringify(effectImportPath)};`,
      `import { defineTool${options.slotted ? ", schemaSlot" : ""} } from ${JSON.stringify(prismImportPath)};`,
      ``,
      `export default {`,
      `  name: ${JSON.stringify(name)},`,
      `  description: "Fixture provider tool '${name}'",`,
      `  input: Schema.Struct({ summary: Schema.String }),`,
      `  output: Schema.Struct({ acknowledged: Schema.Boolean }),`,
      options.slotted
        ? [
            `  slots: {`,
            `    details: schemaSlot({ description: "Dispatcher-specific submission details" }),`,
            `  },`,
          ].join("\n")
        : "",
      `  async handle(input, context) {`,
      `    return { acknowledged: true };`,
      `  },`,
      `};`,
      ``,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
};

const writeProviderPlugin = async (root: string, name: string, toolName: string, slotted: boolean): Promise<string> => {
  const providerPath = join(root, name);
  await writeText(
    join(providerPath, "plugin.json"),
    `${JSON.stringify({ name, version: "0.1.0" }, null, 2)}\n`,
  );
  await writeProviderTool(providerPath, toolName, { slotted });
  return providerPath;
};

const writeIdentity = async (pluginPath: string, name: string): Promise<void> => {
  await writeText(
    join(pluginPath, "identities", `${name}.identity.md`),
    `---\ndescription: Fixture identity '${name}'\n---\n\n# ${name}\n\nFixture identity body.\n`,
  );
};

test("owner detection recognizes a dispatch-only owner (zero canonical tools, one synthetic dispatch binding over a foreign tool)", async () => {
  await withTempDir(async (dir) => {
    const depsRoot = join(dir, "dispatcher", "deps");
    await writeProviderPlugin(depsRoot, "provider", "submit_work", true);

    const dispatcherPath = join(dir, "dispatcher");
    await writeText(
      join(dispatcherPath, "plugin.json"),
      `${JSON.stringify(
        {
          name: "dispatcher",
          version: "0.1.0",
          deps: { provider: "./deps/provider" },
          targets: { agents: ["codex-cli"], tools: ["codex-cli"] },
        },
        null,
        2,
      )}\n`,
    );
    await writeIdentity(dispatcherPath, "builder");
    await writeText(
      join(dispatcherPath, "traits", "dispatchable.trait.ts"),
      [
        ``,
        ``,
        `export default {`,
        `  name: "dispatchable",`,
        `  description: "Can submit dispatcher-specific work",`,
        `  tools: {`,
        `    submit_work: { ref: "provider:submit_work" },`,
        `  },`,
        `  require: { tools: ["submit_work"] },`,
        `};`,
        ``,
      ].join("\n"),
    );
    await writeText(
      join(dispatcherPath, "schemas", "details.ts"),
      `import { Schema } from ${JSON.stringify(effectImportPath)};\n\nexport const Details = Schema.Struct({ verdict: Schema.Literal("done") });\n`,
    );
    await writeText(
      join(dispatcherPath, "agents", "builder.agent.ts"),
      [
        `import { bindTrait } from ${JSON.stringify(prismImportPath)};`,
        `import { Details } from "../schemas/details.ts";`,
        ``,
        `export default {`,
        `  name: "builder",`,
        `  description: "Dispatcher builder agent",`,
        `  identity: "builder",`,
        `  traits: [`,
        `    bindTrait("dispatchable", { tools: { submit_work: { slots: { details: Details } } } }),`,
        `  ],`,
        `};`,
        ``,
      ].join("\n"),
    );

    // Independently ground what "correct" looks like through the SAME
    // compiler predicate the fix wires the verifier through — never a
    // hand-guessed wire name.
    const registry = await Effect.runPromise(loadPlugin(dispatcherPath));
    const ownedBindings = await Effect.runPromise(
      resolveOwnedMcpBindingsForTarget(registry, "codex-cli", "global"),
    );
    expect(ownedBindings).toHaveLength(1);
    expect(ownedBindings[0]?.kind).toBe("synthetic");
    const expectedAllowlist = ownedBindings.map((binding) =>
      renderPluginAllowlist("codex-cli", "dispatcher", generatedToolNameForBinding("dispatcher", binding)),
    );

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.toml"),
      [
        `[mcp_servers."${pluginServerKey("dispatcher")}"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = ${JSON.stringify(expectedAllowlist)}`,
        `[mcp_servers."${pluginServerKey("dispatcher")}".env]`,
        `PRISM_SHIM_PLUGINS = "dispatcher"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [dispatcherPath],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).not.toContain("topology.owner-not-installed");
    expect(codes).not.toContain("topology.consumer-has-server");
    expect(codes).not.toContain("topology.allowlist-mismatch");
    expect(codes).toEqual([]);
    expect(report.pass).toBe(true);
  });
});

test("owner detection keeps a true consumer (foreign tool referenced, no slots filled) flagged when it carries a server entry", async () => {
  await withTempDir(async (dir) => {
    const depsRoot = join(dir, "consumer", "deps");
    await writeProviderPlugin(depsRoot, "provider2", "helper_tool", false);

    const consumerPath = join(dir, "consumer");
    await writeText(
      join(consumerPath, "plugin.json"),
      `${JSON.stringify(
        {
          name: "consumer2",
          version: "0.1.0",
          deps: { provider2: "./deps/provider2" },
          targets: { agents: ["codex-cli"], tools: ["codex-cli"] },
        },
        null,
        2,
      )}\n`,
    );
    await writeIdentity(consumerPath, "user");
    await writeText(
      join(consumerPath, "traits", "usable.trait.ts"),
      [
        ``,
        ``,
        `export default {`,
        `  name: "usable",`,
        `  description: "Can use the provider's helper tool",`,
        `  tools: {`,
        `    helper_tool: { ref: "provider2:helper_tool" },`,
        `  },`,
        `  require: { tools: ["helper_tool"] },`,
        `};`,
        ``,
      ].join("\n"),
    );
    await writeText(
      join(consumerPath, "agents", "user.agent.ts"),
      [
        ``,
        ``,
        `export default {`,
        `  name: "user",`,
        `  description: "Consumer agent referencing a foreign tool, no slots filled",`,
        `  identity: "user",`,
        `  traits: ["usable"],`,
        `};`,
        ``,
      ].join("\n"),
    );

    // Ground the negative the same way: the real predicate must return
    // zero OWNED bindings even though the agent references a real tool.
    const registry = await Effect.runPromise(loadPlugin(consumerPath));
    const ownedBindings = await Effect.runPromise(
      resolveOwnedMcpBindingsForTarget(registry, "codex-cli", "global"),
    );
    expect(ownedBindings).toHaveLength(0);

    const root = join(dir, "harnesses", "codex-cli");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "config.toml"),
      [
        `[mcp_servers."${pluginServerKey("consumer2")}"]`,
        `command = "prism"`,
        `args = ["mcp", "shim"]`,
        `enabled_tools = ["bogus_tool"]`,
        `[mcp_servers."${pluginServerKey("consumer2")}".env]`,
        `PRISM_SHIM_PLUGINS = "consumer2"`,
        `PRISM_SHIM_HARNESS = "codex-cli"`,
        ``,
      ].join("\n"),
    );

    const report = await verifyTopology({
      pluginPaths: [consumerPath],
      harnesses: ["codex-cli"],
      roots: singleHarnessRoots("codex-cli", root),
    });

    const codes = findViolationCodes(report, "codex-cli");
    expect(codes).toContain("topology.consumer-has-server");
    expect(report.pass).toBe(false);
  });
});
