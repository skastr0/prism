import { afterEach, expect, test } from "bun:test";

// --- stubs after MCP tree deletion (tests may still reference old names) ---
const __mcpDeleted = (name: string): any => {
  throw new Error(`MCP surface deleted: ${name}`);
};
const pluginServerKey = (pluginName: string): string =>
  pluginName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
const shimServerKey = (_harness: string): string => "prism";
const bareWireToolName = (_plugin: string, tool: string): string => tool;
const renderAllowlist = (...args: unknown[]): string => String(args[args.length - 1] ?? "");
const renderPluginAllowlist = (...args: unknown[]): string => {
  const tool = String(args[args.length - 1] ?? "");
  const plugin = String(args[args.length - 2] ?? "");
  return `${pluginServerKey(plugin)}__${tool}`;
};
const renderPluginWire = (plugin: string, tool: string, ..._rest: unknown[]): string =>
  `${pluginServerKey(plugin)}_${tool}`;
const generatedMcpWireServerName = (pluginName: string): string => `prism-generated-${pluginName}`;
const generatedMcpServerName = generatedMcpWireServerName;
const prismMcpServerPath = (prismHome: string, pluginName: string): string =>
  `${prismHome}/runtime/mcp/${pluginName}/server.mjs`;
const prismMcpServerStdioPath = (prismHome: string, pluginName: string): string =>
  `${prismHome}/runtime/mcp/${pluginName}/entry-stdio.mjs`;
const writePrismMcpServerBundle = async (..._args: unknown[]): Promise<{ path: string }> =>
  __mcpDeleted("writePrismMcpServerBundle");
const resolveOwnerMcpRuntime = (..._args: unknown[]): any => __mcpDeleted("resolveOwnerMcpRuntime");
const generateMcpServerBundle = async (..._args: unknown[]): Promise<any> =>
  __mcpDeleted("generateMcpServerBundle");
const mcpServerRuntimeSourceSha256 = (): string => "deleted";
const readMcpServerSourceSha256FromBundle = (_c: string): string | undefined => undefined;
const cleanupPrismMcpProcessesUnder = async (_root: string): Promise<void> => {};
const pluginDaemonLogPath = (..._args: unknown[]): string => "/tmp/prism-mcp-deleted.log";
const registerDaemon = async (..._args: unknown[]): Promise<any> => __mcpDeleted("registerDaemon");
type RegistryEntry = { pluginName: string; pid?: number };
type RegistryResult = { ok: boolean };
// --- end stubs ---
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLowering } from "./lowerers/grok.js";
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

test("grok lowerer does not emit MCP wire names or config for foreign tool bindings", async () => {
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
  // Tools are CLI-only — no MCP wire names or config regions.
  expect(agent?.content).toContain("# Consumer");
  expect(agent?.content).not.toContain("mcp__");
  expect(agent?.content).not.toContain("prism-generated-consumer-plugin__ot_echo");
  expect(regions.some((region) => region.regionKey.startsWith("grok.mcp."))).toBe(false);
  expect(operations.find((operation) => operation.targetPath.endsWith("server.mjs"))).toBeUndefined();
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
