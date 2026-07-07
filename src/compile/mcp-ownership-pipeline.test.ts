import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { exists } from "../fs.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { compilePluginForTarget } from "./pipeline.js";
import { SHIM_REGION_OWNER } from "./lowerers/shared.js";
import { readSnapshot } from "../state/store.js";
import { shimExposurePath } from "../state/shim-exposure.js";
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
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "claim_glyph",
  description: "Claim a glyph",
  input: Schema.Struct({ glyphId: Schema.String }),
  output: Schema.Struct({ claimed: Schema.Boolean }),
  async handle() { return { claimed: true }; },
});
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
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "tower-capable",
  description: "Can use tower tools",
  tools: { claim_glyph: { ref: "tower-tools:claim_glyph" } },
});
`,
  );
  await writeText(
    join(pluginRoot, "agents", "orchestrator.agent.ts"),
    `import { bindTrait, defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "orchestrator",
  description: "Consumes tower tools",
  identity: "orchestrator",
  traits: [bindTrait("tower-capable")],
});
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
      mcpLifecycle: "none",
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
}): Promise<void> => {
  await rm(options.pluginRoot, { recursive: true, force: true });
  await writeText(
    join(options.pluginRoot, "plugin.json"),
    `${JSON.stringify(
      { name: options.name, version: "0.1.0", targets: { tools: ["codex-cli"] } },
      null,
      2,
    )}\n`,
  );
  if (options.toolName) {
    await writeText(
      join(options.pluginRoot, "tools", `${options.toolName}.tool.ts`),
      `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: ${JSON.stringify(options.toolName)},
  description: "Echo fixture",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) { return { message: input.message }; },
});
`,
    );
  }
};

test("codex shared shim region unions across plugin compiles and never narrows", async () => {
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
        mcpLifecycle: "none",
      }),
    );

  // A dry-run plan never mutates the exposure registry.
  await compileCodex(alphaRoot, true);
  expect(
    await exists(shimExposurePath(prismHome, join(projectRoot, ".codex"))),
  ).toBe(false);

  await compileCodex(alphaRoot);
  const afterAlpha = await readFile(configPath, "utf8");
  expect(afterAlpha).toContain('PRISM_SHIM_PLUGINS = "shim-alpha"');

  await compileCodex(betaRoot);
  const afterBeta = await readFile(configPath, "utf8");
  expect(afterBeta).toContain('PRISM_SHIM_PLUGINS = "shim-alpha,shim-beta"');
  expect(afterBeta).toContain("shim_alpha_alpha_tool");
  expect(afterBeta).toContain("shim_beta_beta_tool");

  // THE invariant: recompiling alpha converges (skip-regions) and the region
  // still names BOTH plugins — a single-plugin refresh never narrows the union.
  const alphaRecompile = await compileCodex(alphaRoot);
  expect(alphaRecompile.converged).toBe(true);
  expect(
    alphaRecompile.operations.some(
      (operation) => operation.kind === "skip-regions" && operation.targetPath === configPath,
    ),
  ).toBe(true);
  expect(await readFile(configPath, "utf8")).toBe(afterBeta);

  // Exactly one snapshot entry exists for the shim region, owned by the
  // reserved cross-plugin owner — no per-plugin duplicate accumulation, so
  // doctor has nothing to report marker drift against.
  const snapshot = await readSnapshot({
    prismHome,
    harness: "codex-cli",
    root: join(projectRoot, ".codex"),
  });
  const shimEntries = snapshot.manifest.entries.filter(
    (entry) =>
      entry.mode === "region" && (entry.regionKey ?? "").includes("codex.mcp.prism-mcp-shim"),
  );
  expect(shimEntries).toHaveLength(1);
  expect(shimEntries[0]!.plugin).toBe(SHIM_REGION_OWNER);

  // Shrink: alpha drops its MCP surface -> the region keeps only beta.
  await writeShimUnionPlugin({ pluginRoot: alphaRoot, name: "shim-alpha" });
  await compileCodex(alphaRoot);
  const afterShrink = await readFile(configPath, "utf8");
  expect(afterShrink).toContain('PRISM_SHIM_PLUGINS = "shim-beta"');
  expect(afterShrink).not.toContain("shim_alpha_alpha_tool");
  expect(afterShrink).toContain("shim_beta_beta_tool");

  // Remove beta's surface too -> the fence is orphan-removed entirely.
  await writeShimUnionPlugin({ pluginRoot: betaRoot, name: "shim-beta" });
  await compileCodex(betaRoot);
  const afterEmpty = await readFile(configPath, "utf8");
  expect(afterEmpty).not.toContain("prism:codex.mcp.prism-mcp-shim");
  expect(afterEmpty).not.toContain("PRISM_SHIM_PLUGINS");
});
