import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planLowering } from "./lowerers/antigravity-cli.js";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-antigravity-ownership-"));
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

test("antigravity-cli lowerer owner-qualifies foreign tool bindings and merges owner MCP server", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".antigravity");
  const ownerPluginName = "ot";
  const ownerPluginId = `prism-generated-${ownerPluginName}`;

  // Simulate an already-compiled owner plugin with an MCP server entry.
  const ownerMcpPath = join(outputRoot, "plugins", ownerPluginId, "mcp_config.json");
  await writeText(
    ownerMcpPath,
    JSON.stringify(
      {
        mcpServers: {
          [ownerPluginId]: {
            serverUrl: "http://127.0.0.1:55555/mcp",
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
    tools: [],
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

  const agent = findContentOperation(operations, join("agents", "consumer.md"));
  expect(agent?.content).toContain(`mcp_${ownerPluginId}_ot_echo`);
  expect(agent?.content).not.toContain("mcp_prism-generated-consumer-plugin_ot_echo");

  const mcpConfig = findContentOperation(operations, "mcp_config.json");
  const parsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, unknown>;
  };
  expect(parsed.mcpServers).toHaveProperty(ownerPluginId);
  expect(parsed.mcpServers).not.toHaveProperty("prism-generated-consumer-plugin");

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});

test("antigravity-cli lowerer fails closed when owner MCP config is missing", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".antigravity");

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
      tools: [],
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
  ).rejects.toThrow("Cannot reference tools from owner plugin");
});
