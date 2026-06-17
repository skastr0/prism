import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planLowering } from "./lowerers/kimi-code.js";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-kimi-ownership-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const findContentOperation = (
  files: ReadonlyArray<DesiredFile>,
  suffix: string,
): DesiredFile | undefined => files.find((file) => file.targetPath.endsWith(suffix));

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("kimi-code lowerer owner-qualifies foreign tool bindings and merges owner MCP servers", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".kimi-code");
  const ownerPluginName = "ot";
  const ownerPluginId = `prism-generated-${ownerPluginName}`;
  const ownerServerName = ownerPluginId;

  // Simulate an already-compiled owner Kimi plugin with an MCP server entry.
  const ownerManifestPath = join(outputRoot, "plugins", "managed", ownerPluginId, "kimi.plugin.json");
  await writeText(
    ownerManifestPath,
    JSON.stringify(
      {
        name: ownerPluginId,
        version: "0.1.0",
        mcpServers: {
          [ownerServerName]: {
            enabled: true,
            url: "http://127.0.0.1:55555/mcp",
            enabledTools: ["ot_echo"],
          },
        },
      },
      null,
      2,
    ),
  );

  const consumerAgent: ComposedAgent = {
    name: "consumer",
    description: "Consumer agent that references an owner tool",
    body: "# Consumer\n",
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    allowedSkills: [],
    allowedTools: [],
    toolBindings: [
      {
        kind: "permission",
        logicalName: "echo",
        toolPluginName: ownerPluginName,
        toolName: "echo",
        toolSourcePath: join(root, "owner-tools", "tools", "echo.tool.ts"),
      },
    ],
  };

  const { files: operations } = await planLowering({
    agents: [consumerAgent],
    orbits: [],
    skills: [],
    hooks: [],
    registry: undefined,
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "consumer-plugin",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: join(root, "consumer-plugin"),
    },
  });

  const roleSkill = findContentOperation(
    operations,
    join("skills", "prism-agent-consumer", "SKILL.md"),
  );
  expect(roleSkill?.content).toContain(
    `mcp__plugin-${ownerPluginId}_${ownerPluginId}__ot_echo`,
  );
  expect(roleSkill?.content).not.toContain("prism-generated-consumer-plugin");

  const manifest = findContentOperation(operations, "kimi.plugin.json");
  const parsed = JSON.parse(manifest?.content ?? "{}") as {
    mcpServers?: Record<string, unknown>;
  };
  expect(parsed.mcpServers).toHaveProperty(ownerServerName);
  expect(parsed.mcpServers).not.toHaveProperty("prism-generated-consumer-plugin");
});

test("kimi-code lowerer filters owner enabledTools to referenced tool union", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".kimi-code");
  const ownerPluginName = "ot";
  const ownerPluginId = `prism-generated-${ownerPluginName}`;
  const ownerServerName = ownerPluginId;

  const ownerManifestPath = join(outputRoot, "plugins", "managed", ownerPluginId, "kimi.plugin.json");
  await writeText(
    ownerManifestPath,
    JSON.stringify(
      {
        name: ownerPluginId,
        version: "0.1.0",
        mcpServers: {
          [ownerServerName]: {
            enabled: true,
            url: "http://127.0.0.1:55555/mcp",
            enabledTools: ["ot_echo", "ot_unused"],
          },
        },
      },
      null,
      2,
    ),
  );

  const consumerAgent: ComposedAgent = {
    name: "consumer",
    description: "Consumer agent that references one owner tool",
    body: "# Consumer\n",
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    allowedSkills: [],
    allowedTools: [],
    toolBindings: [
      {
        kind: "permission",
        logicalName: "echo",
        toolPluginName: ownerPluginName,
        toolName: "echo",
        toolSourcePath: join(root, "owner-tools", "tools", "echo.tool.ts"),
      },
    ],
  };

  const { files: operations } = await planLowering({
    agents: [consumerAgent],
    orbits: [],
    skills: [],
    hooks: [],
    registry: undefined,
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "consumer-plugin",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: join(root, "consumer-plugin"),
    },
  });

  const manifest = findContentOperation(operations, "kimi.plugin.json");
  const parsed = JSON.parse(manifest?.content ?? "{}") as {
    mcpServers?: Record<string, { enabledTools?: string[] }>;
  };
  const ownerEntry = parsed.mcpServers?.[ownerServerName];
  expect(ownerEntry?.enabledTools).toEqual(["ot_echo"]);
  expect(ownerEntry?.enabledTools).not.toContain("ot_unused");
});

test("kimi-code lowerer fails closed when owner Kimi manifest is missing", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".kimi-code");

  const consumerAgent: ComposedAgent = {
    name: "consumer",
    description: "Consumer agent that references an owner tool",
    body: "# Consumer\n",
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    allowedSkills: [],
    allowedTools: [],
    toolBindings: [
      {
        kind: "permission",
        logicalName: "echo",
        toolPluginName: "owner-tools",
        toolName: "echo",
        toolSourcePath: join(root, "owner-tools", "tools", "echo.tool.ts"),
      },
    ],
  };

  await expect(
    planLowering({
      agents: [consumerAgent],
      orbits: [],
      skills: [],
      hooks: [],
      registry: undefined,
      target: {
        scope: "global",
        root: outputRoot,
        sourcePluginName: "consumer-plugin",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, "consumer-plugin"),
      },
    }),
  ).rejects.toThrow("Cannot reference tools from owner plugin 'owner-tools'");
});
