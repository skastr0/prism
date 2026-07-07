import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/factory-droid.js";
import { renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-factory-ownership-"));
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

test("factory-droid lowerer owner-qualifies foreign tool bindings and emits no server for consumers", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".factory");
  const ownerPluginName = "ot";

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

  // The agent's allowlist names the OWNER plugin's own server with the bare
  // wire tool — never a shared shim key, never a hash-namespaced name.
  const droid = findContentOperation(operations, join("droids", "consumer.md"));
  const echoPermission = renderPluginAllowlist("factory-droid", ownerPluginName, "ot_echo");
  expect(echoPermission).toBe("mcp__ot__echo");
  expect(droid?.content).toContain(`${echoPermission}`);
  expect(droid?.content).not.toContain("prism-mcp-shim");
  expect(droid?.content).not.toContain("mcp__prism-generated-consumer-plugin__ot_echo");

  // A pure consumer owns no bindings, so it gets NO MCP server entry at all:
  // the owner's own bundle carries the server; consumers only reference it.
  const mcpConfig = findContentOperation(operations, "mcp.json");
  expect(mcpConfig).toBeUndefined();

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});
