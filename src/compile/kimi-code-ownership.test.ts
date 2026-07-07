import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/kimi-code.js";
import { pluginServerKey } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-kimi-ownership-"));
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

test("kimi-code lowerer owner-qualifies foreign tool bindings without copying owner MCP servers", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".kimi-code");
  const ownerPluginName = "ot";
  const ownerServerName = pluginServerKey(ownerPluginName);

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
  expect(roleSkill?.content).toContain(`mcp__${ownerServerName}__echo`);
  expect(roleSkill?.content).not.toContain("prism-generated-consumer-plugin");

  const manifest = findContentOperation(operations, "kimi.plugin.json");
  const parsed = JSON.parse(manifest?.content ?? "{}") as {
    mcpServers?: Record<string, unknown>;
  };
  // Consumer plugin (no owned bindings of its own) carries NO mcpServers at
  // all under the per-plugin-manifest law -- not the owner's server key, and
  // not its own.
  expect(parsed.mcpServers).toBeUndefined();
  expect(parsed.mcpServers?.[ownerServerName]).toBeUndefined();
  expect(parsed.mcpServers?.["consumer-plugin"]).toBeUndefined();
});
