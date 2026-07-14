import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { getDaemon } from "@skastr0/prism-sdk/mcp/uds-registry";
import { exists } from "../fs.js";
import { computeMcpHttpConfigContentHash } from "../content-hash.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { compilePluginForTarget } from "./pipeline.js";
import { commitSnapshot, readSnapshot } from "../state/store.js";
import { cleanupPrismMcpProcessesUnder } from "../testing/mcp-process-cleanup.js";

const tempRoots: string[] = [];

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-mcp-ownership-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => cleanupPrismMcpProcessesUnder(root).catch(() => undefined)));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("consumer-only codex plugin does not write an MCP server bundle", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const pluginRoot = join(root, "orbit-consumer");
  const depRoot = join(root, "tower-tools");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(depRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tower-tools",
        version: "0.1.0",
        targets: { tools: ["codex-cli"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(depRoot, "tools", "claim_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "claim_glyph",
  description: "Claim a glyph",
  input: Schema.Struct({ glyphId: Schema.String }),
  output: Schema.Struct({ claimed: Schema.Boolean }),
  async handle() { return { claimed: true }; },
};
`,
  );

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-consumer",
        version: "0.1.0",
        deps: { "tower-tools": "../tower-tools" },
        targets: {
          agents: ["codex-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "identities", "orchestrator.identity.md"),
    `---\ndescription: Orchestrator\n---\n\n# Orchestrator\n`,
  );
  await writeText(
    join(pluginRoot, "traits", "tower-capable.trait.ts"),
    `
export default {
  name: "tower-capable",
  description: "Can use tower tools",
  tools: { claim_glyph: { ref: "tower-tools:claim_glyph" } },
};
`,
  );
  await writeText(
    join(pluginRoot, "agents", "orchestrator.agent.ts"),
    `import { bindTrait } from ${JSON.stringify(prismImportPath)};

export default {
  name: "orchestrator",
  description: "Consumes tower tools",
  identity: "orchestrator",
  traits: [bindTrait("tower-capable")],
};
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(await exists(prismMcpServerPath(prismHome, "orbit-consumer"))).toBe(false);
});

// The "dry-run plan reuses the running MCP daemon port for generated URL
// artifacts" test that used to live here tested two things that no longer
// exist: `mcpLifecycle: "serve"` starting a daemon during compile (that
// option has been a no-op since the compile pipeline stopped driving the
// MCP lifecycle), and a URL-bearing `mcpServers.*` region for the "cursor"
// harness (every harness lowerer now emits a stdio-shim command instead --
// see the wire-naming/stdio-shim consolidation). Deleted rather than
// migrated: nothing in the consolidated UDS-shim world reuses a "daemon
// port" in a dry-run plan.

// ---------------------------------------------------------------------------
// Shared-shim union invariant: the codex config.toml shim region is ONE
// fence shared by every installed plugin, so per-plugin compiles must
// accumulate (never narrow) it, converge byte-identically, keep exactly one
// snapshot entry for it, shrink it when a plugin's MCP surface disappears,
// and orphan-remove it only when no plugin needs it anymore.
// ---------------------------------------------------------------------------

const writeShimUnionPlugin = async (options: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly toolName?: string;
  readonly harness?: string;
}): Promise<void> => {
  await rm(options.pluginRoot, { recursive: true, force: true });
  await writeText(
    join(options.pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: options.name,
        version: "0.1.0",
        targets: { tools: [options.harness ?? "codex-cli"] },
      },
      null,
      2,
    )}\n`,
  );
  if (options.toolName) {
    await writeText(
      join(options.pluginRoot, "tools", `${options.toolName}.tool.ts`),
      `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: ${JSON.stringify(options.toolName)},
  description: "Echo fixture",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) { return { message: input.message }; },
};
`,
    );
  }
};

test("codex per-plugin shim regions stay independent across plugin compiles", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const alphaRoot = join(root, "shim-alpha");
  const betaRoot = join(root, "shim-beta");
  const configPath = join(projectRoot, ".codex", "config.toml");

  await writeShimUnionPlugin({ pluginRoot: alphaRoot, name: "shim-alpha", toolName: "alpha_tool" });
  await writeShimUnionPlugin({ pluginRoot: betaRoot, name: "shim-beta", toolName: "beta_tool" });

  const compileCodex = (pluginPath: string, dryRun = false) =>
    Effect.runPromise(
      compilePluginForTarget({
        prismHome,
        pluginPath,
        target: "codex-cli",
        scope: "project",
        projectPath: projectRoot,
        dryRun,
      }),
    );

  // A dry-run plan never mutates anything on disk.
  await compileCodex(alphaRoot, true);
  expect(await exists(configPath)).toBe(false);

  await compileCodex(alphaRoot);
  const afterAlpha = await readFile(configPath, "utf8");
  expect(afterAlpha).toContain('["mcp_servers"."shim-alpha"]');
  expect(afterAlpha).toContain('PRISM_SHIM_PLUGINS = "shim-alpha"');
  expect(afterAlpha).toContain('enabled_tools = ["alpha_tool"]');
  expect(afterAlpha).not.toContain("shim-beta");

  // THE invariant: a second, unrelated owner plugin gets its OWN region —
  // never a shared union. Compiling beta must not touch alpha's fence at
  // all (byte-identical before/after beta's compile).
  await compileCodex(betaRoot);
  const afterBeta = await readFile(configPath, "utf8");
  expect(afterBeta).toContain('["mcp_servers"."shim-beta"]');
  expect(afterBeta).toContain('PRISM_SHIM_PLUGINS = "shim-beta"');
  expect(afterBeta).toContain('enabled_tools = ["beta_tool"]');
  expect(afterBeta).toContain(afterAlpha); // alpha's own fence, unchanged, still present
  expect(afterBeta).not.toContain('PRISM_SHIM_PLUGINS = "shim-alpha,shim-beta"'); // never a union

  // Recompiling alpha converges (skip-regions) and beta's fence is untouched
  // — a single-plugin refresh never rewrites its neighbor's region.
  const alphaRecompile = await compileCodex(alphaRoot);
  expect(alphaRecompile.converged).toBe(true);
  expect(
    alphaRecompile.operations.some(
      (operation) => operation.kind === "skip-regions" && operation.targetPath === configPath,
    ),
  ).toBe(true);
  expect(await readFile(configPath, "utf8")).toBe(afterBeta);

  // Two independent snapshot entries, each owned by its OWN plugin.
  const snapshot = await readSnapshot({
    prismHome,
    harness: "codex-cli",
    root: join(projectRoot, ".codex"),
  });
  const shimEntries = snapshot.manifest.entries.filter(
    (entry) => entry.mode === "region" && (entry.regionKey ?? "").includes("codex.mcp."),
  );
  expect(shimEntries).toHaveLength(2);
  expect(shimEntries.map((entry) => entry.plugin).sort()).toEqual(["shim-alpha", "shim-beta"]);

  // Alpha drops its MCP surface -> ONLY alpha's own region is pruned; beta's
  // region is untouched.
  await writeShimUnionPlugin({ pluginRoot: alphaRoot, name: "shim-alpha" });
  await compileCodex(alphaRoot);
  const afterShrink = await readFile(configPath, "utf8");
  expect(afterShrink).not.toContain("shim-alpha");
  expect(afterShrink).toContain('["mcp_servers"."shim-beta"]');
  expect(afterShrink).toContain('enabled_tools = ["beta_tool"]');

  // Remove beta's surface too -> its own fence is orphan-removed entirely.
  await writeShimUnionPlugin({ pluginRoot: betaRoot, name: "shim-beta" });
  await compileCodex(betaRoot);
  const afterEmpty = await readFile(configPath, "utf8");
  expect(afterEmpty).not.toContain("prism:codex.mcp.");
  expect(afterEmpty).not.toContain("PRISM_SHIM_PLUGINS");
});

test("grok per-plugin shim regions stay independent across plugin compiles, and retire a legacy bundle .mcp.json", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const alphaRoot = join(root, "shim-alpha");
  const betaRoot = join(root, "shim-beta");
  const grokRoot = join(projectRoot, ".grok");
  const configPath = join(grokRoot, "config.toml");

  await writeShimUnionPlugin({
    pluginRoot: alphaRoot,
    name: "shim-alpha",
    toolName: "alpha_tool",
    harness: "grok",
  });
  await writeShimUnionPlugin({
    pluginRoot: betaRoot,
    name: "shim-beta",
    toolName: "beta_tool",
    harness: "grok",
  });

  const compileGrok = (pluginPath: string) =>
    Effect.runPromise(
      compilePluginForTarget({
        prismHome,
        pluginPath,
        target: "grok",
        scope: "project",
        projectPath: projectRoot,
        dryRun: false,
      }),
    );

  await compileGrok(alphaRoot);
  const afterAlpha = await readFile(configPath, "utf8");
  expect(afterAlpha).toContain('PRISM_SHIM_PLUGINS = "shim-alpha"');
  expect(afterAlpha).not.toContain("PRISM_SHIM_EXPOSURE");
  expect(afterAlpha).not.toContain("shim-beta");

  // Simulate the legacy (pre-region) lowering that wrote a per-plugin
  // bundle-level .mcp.json grok never resolves: plant the file and its
  // snapshot ownership entry, exactly what an old install left behind.
  const legacyMcpJsonPath = join(
    grokRoot,
    "plugins",
    "prism-generated-shim-alpha",
    ".mcp.json",
  );
  const legacyContent = `${JSON.stringify(
    { mcpServers: { prism: { command: "prism", args: ["mcp", "shim"] } } },
    null,
    2,
  )}\n`;
  await writeText(legacyMcpJsonPath, legacyContent);
  const seeded = await readSnapshot({ prismHome, harness: "grok", root: grokRoot });
  await commitSnapshot({
    prismHome,
    manifest: {
      ...seeded.manifest,
      entries: [
        ...seeded.manifest.entries,
        {
          targetPath: legacyMcpJsonPath,
          contentHash: computeMcpHttpConfigContentHash(legacyContent),
          mode: "owned",
          plugin: "shim-alpha",
        },
      ],
    },
  });

  // THE invariant: a second, unrelated owner plugin gets its OWN region —
  // never a shared union. Compiling beta must not touch alpha's fence (or
  // alpha's legacy entry, out of beta's own snapshot scope) at all.
  await compileGrok(betaRoot);
  const afterBeta = await readFile(configPath, "utf8");
  expect(afterBeta).toContain('PRISM_SHIM_PLUGINS = "shim-beta"');
  expect(afterBeta).toContain(afterAlpha); // alpha's own fence, unchanged, still present
  expect(afterBeta).not.toContain('PRISM_SHIM_PLUGINS = "shim-alpha,shim-beta"'); // never a union
  expect(await exists(legacyMcpJsonPath)).toBe(true); // out of beta's scope, untouched

  // Recompiling alpha converges its own region and prunes ITS OWN
  // snapshot-owned legacy .mcp.json (orphaned: owned in the snapshot, never
  // desired again) — beta's fence is untouched.
  await compileGrok(alphaRoot);
  expect(await readFile(configPath, "utf8")).toBe(afterBeta);
  expect(await exists(legacyMcpJsonPath)).toBe(false);

  // Two independent snapshot entries, each owned by its OWN plugin, and the
  // legacy .mcp.json entry is gone.
  const snapshot = await readSnapshot({ prismHome, harness: "grok", root: grokRoot });
  const shimEntries = snapshot.manifest.entries.filter(
    (entry) => entry.mode === "region" && (entry.regionKey ?? "").includes("grok.mcp."),
  );
  expect(shimEntries).toHaveLength(2);
  expect(shimEntries.map((entry) => entry.plugin).sort()).toEqual(["shim-alpha", "shim-beta"]);
  expect(
    snapshot.manifest.entries.some((entry) => entry.targetPath === legacyMcpJsonPath),
  ).toBe(false);

  // Alpha drops its MCP surface -> ONLY alpha's own region is pruned; beta's
  // region is untouched.
  await writeShimUnionPlugin({ pluginRoot: alphaRoot, name: "shim-alpha", harness: "grok" });
  await compileGrok(alphaRoot);
  const afterShrink = await readFile(configPath, "utf8");
  expect(afterShrink).not.toContain("shim-alpha");
  expect(afterShrink).toContain('PRISM_SHIM_PLUGINS = "shim-beta"');

  // Remove beta's surface too -> its own fence is orphan-removed entirely.
  await writeShimUnionPlugin({ pluginRoot: betaRoot, name: "shim-beta", harness: "grok" });
  await compileGrok(betaRoot);
  const afterEmpty = await readFile(configPath, "utf8");
  expect(afterEmpty).not.toContain("prism:grok.mcp.");
  expect(afterEmpty).not.toContain("PRISM_SHIM_PLUGINS");
});

// ---------------------------------------------------------------------------
// PQ-171: a scoped --compile-root must never mutate the shared, live MCP
// daemon registry. Since the UDS/stdio-shim migration (WS6) retired
// compile-time daemon spawn/stop/restart entirely (removing the
// --mcp-lifecycle flag itself, REV-003), this now holds unconditionally --
// proven here rather than left "true by luck" the way the pre-WS6 incident
// (a scratch --compile-root run that restarted a live daemon) found it.
// ---------------------------------------------------------------------------

test("a scoped --compile-root compile never registers or touches a live daemon (PQ-171)", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const compileRoot = join(root, "scratch-compile-root");
  const pluginRoot = join(root, "lifecycle-scope-plugin");
  await writeShimUnionPlugin({ pluginRoot, name: "lifecycle-scope-plugin", toolName: "echo_tool" });

  expect(await getDaemon("lifecycle-scope-plugin", prismHome)).toEqual({ kind: "absent" });

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "global",
      root: compileRoot,
      dryRun: false,
    }),
  );

  // The generated bundle itself still lands under the shared prismHome (a
  // separately established, separately tested invariant -- `root` scopes the
  // harness config output, never PRISM_HOME's own MCP runtime tree). What
  // must NEVER happen, for any root, is a live daemon registration: no pid,
  // no socket, no registry entry.
  expect(await exists(prismMcpServerPath(prismHome, "lifecycle-scope-plugin"))).toBe(true);
  expect(await getDaemon("lifecycle-scope-plugin", prismHome)).toEqual({ kind: "absent" });
});

test("--dry-run compile writes nothing at all, registry or bundle (PQ-171)", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const compileRoot = join(root, "scratch-compile-root");
  const pluginRoot = join(root, "lifecycle-dryrun-plugin");
  await writeShimUnionPlugin({ pluginRoot, name: "lifecycle-dryrun-plugin", toolName: "echo_tool" });

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "codex-cli",
      scope: "global",
      root: compileRoot,
      dryRun: true,
    }),
  );

  // A genuinely side-effect-free plan: neither the generated bundle nor a
  // daemon registration exists after a dry-run.
  expect(await exists(prismMcpServerPath(prismHome, "lifecycle-dryrun-plugin"))).toBe(false);
  expect(await getDaemon("lifecycle-dryrun-plugin", prismHome)).toEqual({ kind: "absent" });
});
