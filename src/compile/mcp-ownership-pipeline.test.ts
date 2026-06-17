import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { exists } from "../fs.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { compilePluginForTarget } from "./pipeline.js";

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
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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