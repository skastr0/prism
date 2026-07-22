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
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/antigravity-cli.js";
import type { ResolvedContractBinding } from "./resolve.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const PRISM_IMPORT = "prism";
const EFFECT_IMPORT = "effect";

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-antigravity-lowerer-"));
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
): DesiredFile | undefined =>
  files.find((file) => file.targetPath.endsWith(suffix));

const permissionBinding = (
  ownerPlugin: string,
  toolName: string,
): ResolvedContractBinding => ({
  kind: "permission",
  logicalName: toolName,
  toolPluginName: ownerPlugin,
  toolName,
  toolSourcePath: `/plugins/${ownerPlugin}/tools/${toolName}.tool.ts`,
});

const runGeneratedHookWrapper = (
  wrapperPath: string,
  payload: unknown,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("node", [wrapperPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(payload));
  });

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("antigravity-cli lowerer emits executable hook wrappers with Antigravity output shape", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".agents");
  const pluginRoot = join(root, "antigravity-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "antigravity-hook-fixture",
        version: "0.1.0",
        targets: {
          toolspaces: ["antigravity-cli"],
          hooks: ["antigravity-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `
export default {
  name: "workspace",
  tools: { shell: { targets: { "antigravity-cli": { name: "run_shell" } } } },
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-shell.hook.ts"),
    `import { Effect } from ${JSON.stringify(EFFECT_IMPORT)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(PRISM_IMPORT)};

export default {
  name: "audit-shell",
  description: "Audit shell commands",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(
    event.tool.input?.block
      || event.cwd !== ${JSON.stringify(pluginRoot)}
      || event.session?.id !== "session-1"
      || event.native?.stepIdx !== 19
      || event.native?.artifactDirectoryPath !== ${JSON.stringify(join(pluginRoot, "artifacts"))}
      ? { decision: "block" as const, message: "blocked" }
      : { decision: "continue" as const },
  ),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-shell-after.hook.ts"),
    `import { Effect } from ${JSON.stringify(EFFECT_IMPORT)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(PRISM_IMPORT)};

export default {
  name: "audit-shell-after",
  description: "Audit shell command responses",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(event.tool.output?.ok && event.cwd === ${JSON.stringify(pluginRoot)} && event.session?.id === "session-2" && event.native?.stepIdx === 5 && event.native?.error === "" ? { decision: "continue" as const } : { decision: "block" as const, message: "missing tool_response fallback" }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "pre-invoke.hook.ts"),
    `import { Effect } from ${JSON.stringify(EFFECT_IMPORT)};
import { hookEvent } from ${JSON.stringify(PRISM_IMPORT)};

export default {
  name: "pre-invoke",
  description: "Validate Antigravity invocation metadata",
  event: hookEvent.sessionStart,
  handle: (event) => event.session?.id === "session-4"
      && event.native?.invocationNum === 3
      && event.native?.initialNumSteps === 10
    ? Effect.succeed({ decision: "continue" as const })
    : Effect.fail(new Error("missing invocation payload")),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "keep-going.hook.ts"),
    `import { Effect } from ${JSON.stringify(EFFECT_IMPORT)};
import { hookEvent } from ${JSON.stringify(PRISM_IMPORT)};

export default {
  name: "keep-going",
  description: "Keep the agent loop alive",
  event: hookEvent.sessionEnd,
  handle: (event) => event.session?.id === "session-3"
      && event.reason === "model_stop"
      && event.native?.executionNum === 7
      && event.native?.fullyIdle === true
      && event.native?.error === "none"
    ? Effect.succeed({ decision: "continue" as const })
    : Effect.fail(new Error("missing stop payload")),
};
`,
  );

  await writeFile(
    join(pluginRoot, "hooks", "turn-stop.hook.ts"),
    `import { Effect } from ${JSON.stringify(EFFECT_IMPORT)};
import { hookEvent } from ${JSON.stringify(PRISM_IMPORT)};

export default {
  name: "turn-stop",
  description: "Portable stop event co-rides antigravity Stop",
  event: hookEvent.stop,
  handle: () => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");
  const afterHook = registry.hooks.get("audit-shell-after");
  const startHook = registry.hooks.get("pre-invoke");
  const stopHook = registry.hooks.get("keep-going");
  const turnStopHook = registry.hooks.get("turn-stop");
  if (!hook) throw new Error("expected audit-shell hook");
  if (!afterHook) throw new Error("expected audit-shell-after hook");
  if (!startHook) throw new Error("expected pre-invoke hook");
  if (!stopHook) throw new Error("expected keep-going hook");
  if (!turnStopHook) throw new Error("expected turn-stop hook");

  const { files: operations } = await planLowering({
    agents: [],
    orbits: [],
    tools: [],
    hooks: [hook, afterHook, startHook, stopHook, turnStopHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "antigravity-hook-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const hookConfig = findContentOperation(operations, "hooks.json");
  expect(hookConfig?.content).toContain('"PreToolUse"');
  expect(hookConfig?.content).toContain('"PostToolUse"');
  expect(hookConfig?.content).toContain('"PreInvocation"');
  expect(hookConfig?.content).toContain('"Stop"');
  expect(hookConfig?.content).toContain('"matcher": "run_shell"');
  expect(hookConfig?.content).toContain('node \\"./hooks/audit-shell.mjs\\"');
  // Portable `stop` co-rides antigravity Stop (grouped alongside session.end).
  expect(hookConfig?.content).toContain('node \\"./hooks/turn-stop.mjs\\"');

  const hookWrapper = findContentOperation(operations, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain("native payload");
  expect(hookWrapper?.content).toContain("validation failed");
  expect(hookWrapper?.content).toContain("result");
  expect(hookWrapper?.content).toContain('harness: "antigravity-cli"');
  expect(hookWrapper?.content).not.toContain("hookSpecificOutput");
  expect(hookWrapper?.content).toContain("transcriptPath");
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");

  await writeText(hookWrapper.targetPath, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    toolCall: { name: "run_shell", args: { block: true } },
    stepIdx: 19,
    conversationId: "session-1",
    artifactDirectoryPath: join(pluginRoot, "artifacts"),
    workspacePaths: [pluginRoot],
  });
  if (blocked.exitCode !== 0) {
    console.log("BLOCKED exit", blocked.exitCode, "stderr:", blocked.stderr, "stdout:", blocked.stdout);
  }
  expect(blocked.exitCode).toBe(0);
  expect(blocked.stderr).toBe("");
  expect(JSON.parse(blocked.stdout.trim())).toEqual({
    decision: "deny",
    reason: "blocked",
  });

  const approved = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    toolCall: { name: "run_shell", args: {} },
    stepIdx: 19,
    conversationId: "session-1",
    artifactDirectoryPath: join(pluginRoot, "artifacts"),
    workspacePaths: [pluginRoot],
  });
  expect(approved.exitCode).toBe(0);
  expect(approved.stderr).toBe("");
  expect(JSON.parse(approved.stdout.trim())).toEqual({ decision: "allow" });

  const afterHookWrapper = findContentOperation(
    operations,
    join("hooks", "audit-shell-after.mjs"),
  );
  if (!afterHookWrapper) throw new Error("expected audit-shell-after wrapper");
  await writeText(afterHookWrapper.targetPath, afterHookWrapper.content);
  const afterResult = await runGeneratedHookWrapper(afterHookWrapper.targetPath, {
    toolCall: { name: "run_shell", args: {}, output: { ok: true } },
    stepIdx: 5,
    error: "",
    conversationId: "session-2",
    tool_response: { ok: true },
    workspacePaths: [pluginRoot],
  });
  expect(afterResult.exitCode).toBe(0);
  expect(afterResult.stderr).toBe("");
  expect(JSON.parse(afterResult.stdout.trim())).toEqual({});

  const startHookWrapper = findContentOperation(operations, join("hooks", "pre-invoke.mjs"));
  if (!startHookWrapper) throw new Error("expected pre-invoke wrapper");
  await writeText(startHookWrapper.targetPath, startHookWrapper.content);
  const startResult = await runGeneratedHookWrapper(startHookWrapper.targetPath, {
    invocationNum: 3,
    initialNumSteps: 10,
    conversationId: "session-4",
    workspacePaths: [pluginRoot],
    transcriptPath: join(pluginRoot, "transcript.jsonl"),
  });
  expect(startResult.exitCode).toBe(0);
  expect(startResult.stderr).toBe("");
  expect(JSON.parse(startResult.stdout.trim())).toEqual({});

  const stopHookWrapper = findContentOperation(operations, join("hooks", "keep-going.mjs"));
  if (!stopHookWrapper) throw new Error("expected keep-going wrapper");
  await writeText(stopHookWrapper.targetPath, stopHookWrapper.content);
  const stopResult = await runGeneratedHookWrapper(stopHookWrapper.targetPath, {
    conversationId: "session-3",
    terminationReason: "model_stop",
    executionNum: 7,
    fullyIdle: true,
    error: "none",
    workspacePaths: [pluginRoot],
    transcriptPath: join(pluginRoot, "transcript.jsonl"),
  });
  expect(stopResult.exitCode).toBe(0);
  expect(stopResult.stderr).toBe("");
  expect(JSON.parse(stopResult.stdout.trim())).toEqual({ decision: "continue" });
});

test("antigravity-cli lowerer emits no MCP config for self-owned tools", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".agents");
  const pluginRoot = join(root, "antigravity-shim-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "antigravity-shim-fixture",
        version: "0.1.0",
        targets: {
          tools: ["antigravity-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(EFFECT_IMPORT)};

export default {
  name: "echo",
  description: "Echo via the stdio shim",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
};
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const { files: operations } = await planLowering({
    agents: [],
    orbits: [],
    tools: [...registry.tools.values()],
    hooks: [],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "antigravity-shim-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const manifest = findContentOperation(operations, "plugin.json");
  expect(JSON.parse(manifest?.content ?? "{}")).toEqual({
    name: "prism-generated-antigravity-shim-fixture",
    version: "0.1.0",
  });

  // MCP config emission was excised — tools are CLI-only.
  expect(findContentOperation(operations, "mcp_config.json")).toBeUndefined();
  const bundle = operations.find(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  );
  expect(bundle).toBeUndefined();
});

test("antigravity-cli production default omits generated MCP tool advertisements and MCP config", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".agents");
  const owner = "antigravity-mcp-off-fixture";
  const binding = permissionBinding(owner, "echo");
  const previous = process.env.PRISM_TOOLS_MCP_EMIT;
  const previousCli = process.env.PRISM_TOOLS_CLI_EMIT;
  const previousInject = process.env.PRISM_TOOLS_CLI_INJECT;

  delete process.env.PRISM_TOOLS_MCP_EMIT;
  delete process.env.PRISM_TOOLS_CLI_EMIT;
  delete process.env.PRISM_TOOLS_CLI_INJECT;
  try {
    const { files } = await planLowering({
      agents: [{
        name: "consumer",
        description: "Consumes one native and one canonical tool",
        body: "# Consumer\n",
        color: undefined,
        model: {},
        targetOverride: {},
        skills: [],
        allowedSkills: [],
        allowedTools: ["read_file"],
        toolBindings: [binding],
      }],
      orbits: [],
      tools: [],
      hooks: [],
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName: owner,
        sourcePluginVersion: "0.1.0",
      },
    });

    const agent = findContentOperation(files, join("agents", "consumer.md"));
    expect(agent?.content).toContain('- "read_file"');
    expect(agent?.content).not.toContain("mcp_");
    expect(agent?.content).toContain("Load skill `prism-tools-antigravity-mcp-off-fixture`");
    expect(agent?.content).toContain(
      "prism tools invoke antigravity-mcp-off-fixture <tool-name>",
    );
    expect(agent?.content).toContain("`echo`");
    expect(findContentOperation(files, "mcp_config.json")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.PRISM_TOOLS_MCP_EMIT;
    else process.env.PRISM_TOOLS_MCP_EMIT = previous;
    if (previousCli === undefined) delete process.env.PRISM_TOOLS_CLI_EMIT;
    else process.env.PRISM_TOOLS_CLI_EMIT = previousCli;
    if (previousInject === undefined) delete process.env.PRISM_TOOLS_CLI_INJECT;
    else process.env.PRISM_TOOLS_CLI_INJECT = previousInject;
  }
});
