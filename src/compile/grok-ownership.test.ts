import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/grok.js";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
import type { ComposedAgent } from "./compose.js";
import type { DesiredFile } from "../sync/desired.js";
import { PathConflictError } from "../errors.js";
import { readSnapshot } from "../state/store.js";
import { planSync } from "../sync/plan.js";
import { applySync } from "../sync/apply.js";

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

test("two plugins compiling a same-named Grok project agent fail closed, naming both plugins", async () => {
  const root = await createTempRoot();
  const home = await createTempRoot();
  const outputRoot = join(root, ".grok");

  const agentNamed = (sourcePluginName: string): ComposedAgent => ({
    name: "builder",
    description: `Builder from ${sourcePluginName}`,
    body: `# Builder\n\nAuthored independently by ${sourcePluginName}.\n`,
    color: undefined,
    model: {},
    targetOverride: {},
    skills: [],
    allowedSkills: [],
    allowedTools: [],
    toolBindings: [],
  });

  const lowerFor = (sourcePluginName: string) =>
    planLowering({
      agents: [agentNamed(sourcePluginName)],
      orbits: [],
      skills: [],
      hooks: [],
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName,
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: join(root, sourcePluginName),
      },
    });

  const first = await lowerFor("agent-forge");
  const second = await lowerFor("agent-quasar");
  const agentTargetPath = join(outputRoot, "agents", "builder.md");
  expect(first.files.some((file) => file.targetPath === agentTargetPath)).toBe(true);
  expect(second.files.some((file) => file.targetPath === agentTargetPath)).toBe(true);

  const refreshScoped = async (desired: typeof first, plugin: string) => {
    const snapshot = await readSnapshot({ prismHome: home, harness: "grok", root: outputRoot });
    const plan = await planSync({
      desired: {
        harness: "grok",
        root: outputRoot,
        files: desired.files,
        regions: desired.regions,
      },
      snapshot: snapshot.manifest,
      scopePlugins: new Set([plugin]),
    });
    return applySync({ prismHome: home, plan });
  };

  await refreshScoped(first, "agent-forge");
  try {
    await refreshScoped(second, "agent-quasar");
    throw new Error("expected a PathConflictError");
  } catch (error) {
    expect(error).toBeInstanceOf(PathConflictError);
    if (!(error instanceof PathConflictError)) throw error;
    expect(error.targetPath).toBe(agentTargetPath);
    expect(error.firstPlugin).toBe("agent-forge");
    expect(error.secondPlugin).toBe("agent-quasar");
  }
});
