import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/grok.js";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-grok-ownership-"));
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

test("grok lowerer owner-qualifies foreign tool bindings and wires the shim to the owner plugin", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
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

  const { files: operations, regions } = await planLowering({
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
  const echoWire = renderPluginAllowlist("grok", ownerPluginName, "ot_echo");
  expect(echoWire).toBe(`${pluginServerKey(ownerPluginName)}__echo`);
  expect(agent?.content).toContain(echoWire);
  expect(agent?.content).not.toContain("prism-generated-consumer-plugin__ot_echo");

  // The shim resolves the owner's daemon on demand — no per-owner runtime
  // resolution is required at compile time; the referenced owner plugin gets
  // its OWN server entry (never the consumer's), named in PRISM_SHIM_PLUGINS
  // inside its own config.toml shim region. The consumer plugin itself gets
  // no server entry at all.
  const mcpRegion = regions.find(
    (region) => region.regionKey === `grok.mcp.${pluginServerKey(ownerPluginName)}`,
  );
  if (mcpRegion?.kind !== "marker") throw new Error("expected a marker region for the owner's grok shim");
  expect(mcpRegion.targetPath).toBe(join(outputRoot, "config.toml"));
  expect(mcpRegion.plugin).toBe(ownerPluginName);
  expect(mcpRegion.content).toContain(`PRISM_SHIM_PLUGINS = "${ownerPluginName}"`);
  expect(
    regions.find((region) => region.regionKey === `grok.mcp.${pluginServerKey("consumer-plugin")}`),
  ).toBeUndefined();

  const bundle = operations.find((operation) => operation.targetPath.endsWith("server.mjs"));
  expect(bundle).toBeUndefined();
});
