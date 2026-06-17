import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planLowering } from "./lowerers/factory-droid.js";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-factory-ownership-"));
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

test("factory-droid lowerer owner-qualifies foreign tool bindings and merges owner MCP server", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".factory");
  const ownerPluginName = "ot";
  const ownerPluginId = `prism-generated-${ownerPluginName}`;

  // Simulate an already-compiled owner plugin with an MCP server entry.
  const ownerMcpPath = join(outputRoot, "plugins", ownerPluginId, "mcp.json");
  await writeText(
    ownerMcpPath,
    JSON.stringify(
      {
        mcpServers: {
          [ownerPluginId]: {
            type: "http",
            url: "http://127.0.0.1:55555/mcp",
            headers: {},
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
      scope: "project",
      root: outputRoot,
      sourcePluginName: "consumer-plugin",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: join(root, "consumer-plugin"),
    },
  });

  const droid = findContentOperation(operations, join("droids", "consumer.md"));
  expect(droid?.content).toContain(`mcp__${ownerPluginId}__ot_echo`);
  expect(droid?.content).not.toContain("mcp__prism-generated-consumer-plugin__ot_echo");

  const mcpConfig = findContentOperation(operations, "mcp.json");
  const parsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, unknown>;
  };
  expect(parsed.mcpServers).toHaveProperty(ownerPluginId);
  expect(parsed.mcpServers).not.toHaveProperty("prism-generated-consumer-plugin");

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});

test("factory-droid lowerer fails closed when owner MCP config is missing", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".factory");

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
        scope: "project",
        root: outputRoot,
        sourcePluginName: "consumer-plugin",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, "consumer-plugin"),
      },
    }),
  ).rejects.toThrow("Cannot reference tools from owner plugin 'owner-tools'");
});
