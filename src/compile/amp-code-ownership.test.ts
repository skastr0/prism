import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { exists } from "../fs.js";
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
  const root = await mkdtemp(join(tmpdir(), "prism-amp-ownership-"));
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

test("consumer-only Amp plugins do not bundle foreign owner tools", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const depRoot = join(root, "tower-tools");
  const consumerRoot = join(root, "orbit-consumer");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(depRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tower-tools",
        version: "0.1.0",
        targets: { tools: ["amp-code"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(depRoot, "tools", "claim_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { ToolSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "claim_glyph",
  description: "Claim a glyph",
  input: Schema.Struct({ glyphId: Schema.String }),
  output: Schema.Struct({ claimed: Schema.Boolean }),
  async handle() { return { claimed: true }; },
} satisfies ToolSource;
`,
  );

  await writeText(
    join(consumerRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-consumer",
        version: "0.1.0",
        deps: { "tower-tools": "../tower-tools" },
        targets: { agents: ["amp-code"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(consumerRoot, "identities", "orchestrator.identity.md"),
    `---\ndescription: Orchestrator\n---\n\n# Orchestrator\n`,
  );
  await writeText(
    join(consumerRoot, "traits", "tower-capable.trait.ts"),
    `import type { TraitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "tower-capable",
  description: "Can use tower tools",
  tools: { claim_glyph: { ref: "tower-tools:claim_glyph" } },
} satisfies TraitSource;
`,
  );
  await writeText(
    join(consumerRoot, "agents", "orchestrator.agent.ts"),
    `import type { AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "orchestrator",
  description: "Consumes tower tools",
  identity: "orchestrator",
  traits: ["tower-capable"],
} satisfies AgentSource;
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: consumerRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const consumerPluginPath = join(
    projectRoot,
    ".amp",
    "plugins",
    "prism-generated-orbit-consumer.ts",
  );
  expect(await exists(consumerPluginPath)).toBe(false);

  const roleSkillPath = join(
    projectRoot,
    ".agents",
    "skills",
    "prism-agent-orchestrator",
    "SKILL.md",
  );
  const roleSkill = await readFile(roleSkillPath, "utf8");
  expect(roleSkill).toContain("prism-generated-tower-tools");
  expect(roleSkill).toContain("tower_tools_claim_glyph");
});

test("owner Amp plugins still register owned canonical tools", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const ownerRoot = join(root, "tower-tools");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(ownerRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tower-tools",
        version: "0.1.0",
        targets: { tools: ["amp-code"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(ownerRoot, "tools", "claim_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { ToolSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "claim_glyph",
  description: "Claim a glyph",
  input: Schema.Struct({ glyphId: Schema.String }),
  output: Schema.Struct({ claimed: Schema.Boolean }),
  async handle() { return { claimed: true }; },
} satisfies ToolSource;
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: ownerRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const ownerPluginPath = join(
    projectRoot,
    ".amp",
    "plugins",
    "prism-generated-tower-tools.ts",
  );
  expect(await exists(ownerPluginPath)).toBe(true);

  const source = await readFile(ownerPluginPath, "utf8");
  expect(source).toContain('createToolDefinition("tower_tools_claim_glyph"');
  expect(source).not.toContain("orbit-consumer");

  const generated = (await import(`${pathToFileURL(ownerPluginPath).href}?test=${Date.now()}`)) as {
    readonly default: (amp: { registerTool(definition: unknown): void }) => void;
  };
  const registeredTools: Array<{ name: string }> = [];
  generated.default({
    registerTool: (definition) => {
      registeredTools.push(definition as { name: string });
    },
  });
  expect(registeredTools.map((tool) => tool.name)).toEqual(["tower_tools_claim_glyph"]);
});

test("consumer Amp plugins with commands only emit a slim command plugin", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const depRoot = join(root, "tower-tools");
  const consumerRoot = join(root, "orbit-consumer");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(depRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "tower-tools",
        version: "0.1.0",
        targets: { tools: ["amp-code"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(depRoot, "tools", "claim_glyph.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { ToolSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "claim_glyph",
  description: "Claim a glyph",
  input: Schema.Struct({ glyphId: Schema.String }),
  output: Schema.Struct({ claimed: Schema.Boolean }),
  async handle() { return { claimed: true }; },
} satisfies ToolSource;
`,
  );

  await writeText(
    join(consumerRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "orbit-consumer",
        version: "0.1.0",
        deps: { "tower-tools": "../tower-tools" },
        targets: {
          agents: ["amp-code"],
          commands: ["amp-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(consumerRoot, "identities", "orchestrator.identity.md"),
    `---\ndescription: Orchestrator\n---\n\n# Orchestrator\n`,
  );
  await writeText(
    join(consumerRoot, "traits", "tower-capable.trait.ts"),
    `import type { TraitSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "tower-capable",
  description: "Can use tower tools",
  tools: { claim_glyph: { ref: "tower-tools:claim_glyph" } },
} satisfies TraitSource;
`,
  );
  await writeText(
    join(consumerRoot, "agents", "orchestrator.agent.ts"),
    `import type { AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "orchestrator",
  description: "Consumes tower tools",
  identity: "orchestrator",
  traits: ["tower-capable"],
} satisfies AgentSource;
`,
  );
  await writeText(
    join(consumerRoot, "commands", "dispatch.md"),
    `---
description: Dispatch work
---

Dispatch the requested work.
`,
  );

  await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: consumerRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  const consumerPluginPath = join(
    projectRoot,
    ".amp",
    "plugins",
    "prism-generated-orbit-consumer.ts",
  );
  expect(await exists(consumerPluginPath)).toBe(true);

  const source = await readFile(consumerPluginPath, "utf8");
  expect(source).toContain("registerCommand");
  expect(source).not.toContain("tower_tools_claim_glyph");
  expect(source).not.toContain("claim_glyph_tool_default");

  const generated = (await import(`${pathToFileURL(consumerPluginPath).href}?test=${Date.now()}`)) as {
    readonly default: (amp: {
      registerTool(definition: unknown): void;
      registerCommand: (
        id: string,
        options: Record<string, unknown>,
        handler: () => Promise<void>,
      ) => void;
    }) => void;
  };
  const registeredTools: unknown[] = [];
  const registeredCommands: string[] = [];
  generated.default({
    registerTool: (definition) => {
      registeredTools.push(definition);
    },
    registerCommand: (id) => {
      registeredCommands.push(id);
    },
  });
  expect(registeredTools).toHaveLength(0);
  expect(registeredCommands).toEqual(["prism-generated-orbit-consumer-dispatch"]);
});
