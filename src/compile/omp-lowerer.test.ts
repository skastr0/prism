import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { planLowering } from "./lowerers/omp.js";
import type { ComposedAgent } from "./compose.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-omp-lowerer-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const ownedToolSource = `
import { Schema } from "effect";

export default {
  name: "owned",
  description: "Owned tool for OMP.",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  async handle() {
    return {};
  },
};
`;

test("OMP lowerer emits native agents, skills, and extension without Pi surfaces", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".omp");
  const sourcePluginPath = join(root, "omp-plugin");
  const ownedToolPath = join(sourcePluginPath, "tools", "owned.tool.ts");
  const skillPath = join(sourcePluginPath, "skills", "grounded", "SKILL.md");
  await writeText(ownedToolPath, ownedToolSource);
  await writeText(skillPath, "---\nname: grounded\ndescription: Ground claims.\n---\n\n# Grounded\n");

  const agent: ComposedAgent = {
    name: "builder",
    description: "OMP builder",
    body: "# Builder\n",
    color: undefined,
    model: { model: "gpt-5.6-luna", variant: "high" },
    targetOverride: {
      omp: {
        model: ["gpt-5.6-luna", "synthetic/hf:moonshotai/Kimi-K2.6"],
        thinkingLevel: "high",
        spawns: ["reviewer"],
        readSummarize: true,
      },
    },
    skills: ["grounded"],
    allowedSkills: ["grounded"],
    allowedTools: ["read"],
    toolBindings: [
      {
        kind: "permission",
        logicalName: "owned",
        toolPluginName: "omp-plugin",
        toolName: "owned",
        toolSourcePath: ownedToolPath,
      },
    ],
  };

  const lowered = await planLowering({
    agents: [agent],
    orbits: [],
    skills: [{ name: "grounded", sourcePath: skillPath }],
    hooks: [],
    registry: undefined,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "omp-plugin",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath,
    },
  });

  const agentFile = lowered.files.find((file) =>
    file.targetPath === join(outputRoot, "agents", "builder.md"),
  );
  expect(agentFile).toBeDefined();
  const parsedAgent = matter(agentFile?.content ?? "");
  expect(parsedAgent.data).toMatchObject({
    name: "builder",
    model: ["gpt-5.6-luna", "synthetic/hf:moonshotai/Kimi-K2.6"],
    thinkingLevel: "high",
    tools: ["omp_plugin_owned", "read"],
    spawns: ["reviewer"],
    autoloadSkills: ["grounded"],
    readSummarize: true,
  });
  expect(parsedAgent.data["read-summarize"]).toBeUndefined();

  expect(lowered.files).toContainEqual(
    expect.objectContaining({
      targetPath: join(outputRoot, "skills", "grounded", "SKILL.md"),
    }),
  );
  const extension = lowered.files.find((file) =>
    file.targetPath === join(
      outputRoot,
      "extensions",
      "prism-generated-omp-plugin",
      "index.ts",
    ),
  );
  expect(extension?.content).toContain("omp_plugin_owned");
  expect(extension?.content).toContain("omp-schema-bridge");
  expect(lowered.files.some((file) => file.targetPath.includes(".pi"))).toBe(false);
  expect(lowered.files.some((file) => file.targetPath.endsWith("server.mjs"))).toBe(false);
});
