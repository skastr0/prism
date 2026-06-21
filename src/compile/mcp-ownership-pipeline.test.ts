import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { exists } from "../fs.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { compilePluginForTarget, planPluginForTarget } from "./pipeline.js";
import { getMcpStatus, stopMcp } from "../mcp/lifecycle.js";
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

test("dry-run plan reuses the running MCP daemon port for generated URL artifacts", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const pluginRoot = join(root, "cursor-tools");
  const cursorRoot = join(root, "cursor");
  await mkdir(cursorRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "cursor-tools",
        version: "0.1.0",
        targets: { tools: ["cursor"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "ping.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "ping",
  description: "Ping for plan/refresh parity test.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ pong: Schema.String }),
  async handle(input) {
    return { pong: input.message };
  },
});
`,
  );

  const compiled = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "cursor",
      scope: "global",
      dryRun: false,
      mcpLifecycle: "serve",
    }),
  );
  expect(compiled.failures).toHaveLength(0);

  const status = await getMcpStatus({
    pluginPath: pluginRoot,
    harness: "cursor",
    scope: "global",
    prismHome,
  });
  expect(status.state).toBe("running");
  const runningPort = status.metadata?.port;
  expect(runningPort).toBeGreaterThan(0);

  try {
    const planned = await Effect.runPromise(
      planPluginForTarget({
        prismHome,
        pluginPath: pluginRoot,
        target: "cursor",
        scope: "global",
        dryRun: true,
      }),
    );

    const mcpRegion = planned.regions.find(
      (region) => region.kind === "json-key" && region.regionKey.startsWith("mcpServers."),
    );
    expect(mcpRegion).toBeDefined();
    expect(mcpRegion?.kind === "json-key" ? mcpRegion.value : undefined).toMatchObject({
      url: expect.stringContaining(`:${runningPort}/`),
    });
  } finally {
    await stopMcp({
      pluginPath: pluginRoot,
      harness: "cursor",
      scope: "global",
      prismHome,
    }).catch(() => undefined);
  }
}, 20_000);
