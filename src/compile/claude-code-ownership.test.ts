import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/claude-code.js";
import { generatedMcpWireServerName } from "./mcp-runtime.js";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-claude-ownership-"));
  tempRoots.push(root);
  return root;
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

test("claude-code lowerer owner-qualifies foreign tool bindings without copying owner MCP config", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const ownerPluginName = "ot";
  const ownerServerName = generatedMcpWireServerName(ownerPluginName);

  const consumerAgent: ComposedAgent = {
    name: "consumer",
    description: "Consumer agent that references an owner tool",
    body: "# Consumer\n",
    color: undefined,
    model: {},
    // Generated agents now omit `tools:` (Claude treats it as an exclusive allowlist that strips
    // built-ins). An explicit author tools override re-emits the merged allowlist — the surface
    // where the owner-qualified foreign binding name remains observable.
    targetOverride: { "claude-code": { tools: ["Read"] } },
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

  const agent = findContentOperation(operations, join("agents", "consumer.md"));
  expect(agent?.content).toContain(`mcp__${ownerServerName}__ot_echo`);
  expect(agent?.content).not.toContain("mcp__prism-generated-consumer-plugin__ot_echo");

  const mcpConfig = findContentOperation(operations, ".mcp.json");
  expect(mcpConfig).toBeUndefined();

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});
