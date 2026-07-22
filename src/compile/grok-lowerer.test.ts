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
const capGrokWireName = (name: string, ..._rest: unknown[]): string => name.slice(0, 64);
const createGrokCollisionGuard = (): { seen: Set<string> } => ({ seen: new Set() });
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
import { planLowering } from "./lowerers/grok.js";
import { mcpToolNameForBinding } from "./mcp-bundle.js";
import type { ResolvedContractBinding } from "./resolve.js";
import { Contract } from "./sources.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");
const GROK_MAX_TOOL_NAME_LENGTH = 64;
// Grok's own tool-name validation: https://... (PQ-168) — first char letter
// or underscore, remaining 0-63 chars alnum/underscore/hyphen.
const GROK_TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/u;

const permissionBinding = (
  toolPluginName: string,
  toolName: string,
): ResolvedContractBinding => ({
  kind: "permission",
  logicalName: toolName,
  toolPluginName,
  toolName,
  toolSourcePath: join(toolPluginName, "tools", `${toolName}.tool.ts`),
});

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-grok-lowerer-"));
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

test("grok global lowerer emits a plugin bundle with agents, skills, and hooks", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "grok-plugin-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "grok-plugin-fixture",
        version: "0.3.0",
        targets: {
          skills: ["grok"],
          toolspaces: ["grok"],
          hooks: ["grok"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    `---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n`,
  );

  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `
export default {
  name: "workspace",
  tools: { shell: { targets: { "grok": { name: "run_terminal_cmd" } } } },
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-shell.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-shell",
  description: "Audit shell commands",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-echo.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-echo",
  description: "Audit canonical echo calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("echo") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "session-ended.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent } from ${JSON.stringify(prismImportPath)};

export default {
  name: "session-ended",
  description: "Observe session end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "prompt-submitted.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "prompt-submitted",
  description: "Observe prompt submit",
  event: "prompt.submit",
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "blocked prompt" }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "subagent-stopped.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "subagent-stopped",
  description: "Observe subagent stop",
  event: "subagent.stop",
  handle: (_event) => Effect.succeed({ decision: "block" as const, message: "blocked subagent" }),
};
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "notified.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "notified",
  description: "Observe notification",
  event: "notification",
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`,
  );

  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
};
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");
  const canonicalHook = registry.hooks.get("audit-echo");
  const sessionEndHook = registry.hooks.get("session-ended");
  const promptSubmitHook = registry.hooks.get("prompt-submitted");
  const subagentStopHook = registry.hooks.get("subagent-stopped");
  const notificationHook = registry.hooks.get("notified");
  if (!hook) throw new Error("expected audit-shell hook");
  if (!canonicalHook) throw new Error("expected audit-echo hook");
  if (!sessionEndHook) throw new Error("expected session-ended hook");
  if (!promptSubmitHook) throw new Error("expected prompt-submitted hook");
  if (!subagentStopHook) throw new Error("expected subagent-stopped hook");
  if (!notificationHook) throw new Error("expected notified hook");
  const echoBinding: ResolvedContractBinding = {
    kind: "permission",
    logicalName: "echo",
    toolPluginName: "grok-plugin-fixture",
    toolName: "echo",
    toolSourcePath: toolPath,
  };
  const longSyntheticBinding: ResolvedContractBinding = {
    kind: "synthetic",
    logicalName: "echo_review",
    contract: new Contract({
      name: "echo__requirements_trace_review_details",
      sourcePath: `${join(pluginRoot, "traits", "review.trait.ts")}#echo`,
      pluginName: "grok-plugin-fixture",
    }),
    toolPluginName: "grok-plugin-fixture",
    toolName: "echo_review",
    toolSourcePath: toolPath,
  };

  const { files: operations, regions } = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Grok plugin bundle",
        body: "# Reviewer\n\nUse the generated Grok plugin bundle.",
        color: undefined,
        model: { model: "grok-build", effort: "high", temperature: 0.1, top_p: 0.7 },
        targetOverride: {
          "grok": {
            description: "Grok plugin reviewer",
            model: "grok-code-fast-1",
            prompt_mode: "compact",
            permission_mode: "acceptEdits",
            permissionMode: "ignored-camel-fallback",
            agents_md: false,
            tools: ["read_file"],
            "allowed-tools": ["run_terminal_cmd"],
            disallowedTools: ["web_fetch"],
            "disallowed-tools": ["web_search"],
            reasoning_effort: "medium",
            mcpServers: {},
          },
        },
        skills: [],
        allowedSkills: ["testing"],
        allowedTools: ["grep_search"],
        toolBindings: [echoBinding, longSyntheticBinding],
      },
      {
        name: "fallback",
        description: "Exercises Grok fallback frontmatter",
        body: "# Fallback\n\nUse fallback frontmatter values.",
        color: undefined,
        model: { variant: "balanced" },
        targetOverride: {
          "grok": {
            permissionMode: "auto",
            agents_md: true,
            "disallowed-tools": ["legacy_shell"],
          },
        },
        skills: [],
        allowedSkills: [],
        allowedTools: [],
        toolBindings: [],
      },
    ],
    orbits: [],
    skills: [...registry.skills.values()],
    hooks: [hook, canonicalHook, sessionEndHook, promptSubmitHook, subagentStopHook, notificationHook],
    registry,
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "grok-plugin-fixture",
      sourcePluginVersion: "0.3.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const pluginManifest = findContentOperation(
    operations,
    join(".claude-plugin", "plugin.json"),
  );
  expect(pluginManifest?.targetPath).toContain(
    join(".grok", "plugins", "prism-generated-grok-plugin-fixture"),
  );
  expect(pluginManifest?.content).toContain('"name": "prism-generated-grok-plugin-fixture"');

  const agent = findContentOperation(operations, join("agents", "reviewer.md"));
  expect(agent?.targetPath).toContain(
    join(".grok", "plugins", "prism-generated-grok-plugin-fixture", "agents"),
  );
  expect(agent?.content).toContain('description: "Grok plugin reviewer"');
  expect(agent?.content).toContain('model: "grok-code-fast-1"');
  expect(agent?.content).toContain('prompt_mode: "compact"');
  expect(agent?.content).toContain('permission_mode: "acceptEdits"');
  expect(agent?.content).not.toContain("ignored-camel-fallback");
  expect(agent?.content).toContain("agents_md: false");
  expect(agent?.content).toContain('effort: "high"');
  expect(agent?.content).toContain('reasoning_effort: "medium"');
  expect(agent?.content).toContain("temperature: 0.1");
  expect(agent?.content).toContain("top_p: 0.7");
  expect(agent?.content).not.toContain("mcp__");
  expect(agent?.content).not.toContain('- "grok_plugin_fixture_echo"');
  expect(agent?.content).toContain('- "grep_search"');
  expect(agent?.content).toContain('- "read_file"');
  expect(agent?.content).toContain('- "run_terminal_cmd"');
  expect(agent?.content).toContain('disallowedTools:\n  - "web_fetch"\n  - "web_search"');
  // Grok must not emit frontmatter skills (full-body preload poison).
  expect(agent?.content).not.toContain("\nskills:");
  expect(agent?.content).not.toContain("Prism Claude Plugin Diagnostics");
  expect(agent?.content).not.toContain("mcpServers");

  const fallbackAgent = findContentOperation(operations, join("agents", "fallback.md"));
  expect(fallbackAgent?.content).toContain('description: "Exercises Grok fallback frontmatter"');
  expect(fallbackAgent?.content).toContain('permission_mode: "auto"');
  expect(fallbackAgent?.content).toContain("agents_md: true");
  expect(fallbackAgent?.content).toContain('effort: "balanced"');
  expect(fallbackAgent?.content).toContain('disallowedTools:\n  - "legacy_shell"');

  const skill = findContentOperation(operations, join("skills", "testing", "SKILL.md"));
  expect(skill?.content).toContain("# Testing");

  // MCP config emission was excised — tools are CLI-only.
  expect(findContentOperation(operations, ".mcp.json")).toBeUndefined();
  expect(regions.some((region) => region.regionKey.startsWith("grok.mcp."))).toBe(false);

  // No MCP server.mjs in the generated plugin plan.
  const bundle = operations.find(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  );
  expect(bundle).toBeUndefined();

  const hookConfig = findContentOperation(operations, join("hooks", "hooks.json"));
  expect(hookConfig?.content).toContain('"PreToolUse"');
  expect(hookConfig?.content).toContain('"SessionEnd"');
  expect(hookConfig?.content).not.toContain('"Stop"');
  expect(hookConfig?.content).toContain('"matcher": "run_terminal_cmd"');
  // Hook matchers use CLI tool names (not harness MCP wire names).
  const generatedEchoTool = mcpToolNameForBinding("grok-plugin-fixture", {
    kind: "permission",
    logicalName: "echo",
    toolPluginName: "grok-plugin-fixture",
    toolName: "echo",
    toolSourcePath: "tools/echo.tool.ts",
  });
  const generatedSyntheticTool = mcpToolNameForBinding("grok-plugin-fixture", longSyntheticBinding);
  expect(hookConfig?.content).toContain(`"matcher": "${generatedEchoTool}"`);
  // Agent frontmatter no longer lists generated tool wire names.
  expect(agent?.content).not.toContain(`- "${generatedSyntheticTool}"`);
  expect(agent?.content).not.toContain(`- "${generatedEchoTool}"`);
  expect(hookConfig?.content).toContain(
    join(outputRoot, "plugins", "prism-generated-grok-plugin-fixture", "hooks", "audit-shell.mjs"),
  );
  expect(hookConfig?.content).not.toContain("CLAUDE_PLUGIN_ROOT");

  const hookWrapper = findContentOperation(operations, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain("native payload");
  expect(hookWrapper?.content).toContain("validation failed");
  expect(hookWrapper?.content).toContain("result");
  expect(hookWrapper?.content).toContain('harness: "grok"');
  expect(hookWrapper?.content).toContain('decision: "deny"');
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");
  await writeText(hookWrapper.targetPath, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    tool: { name: "run_terminal_cmd", input: { block: true } },
    workspaceRoot: pluginRoot,
  });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr).toBe("");
  expect(JSON.parse(blocked.stdout.trim())).toEqual({
    decision: "deny",
    reason: "blocked",
  });

  expect(hookConfig?.content).toContain('"UserPromptSubmit"');
  expect(hookConfig?.content).toContain('"SubagentStop"');
  expect(hookConfig?.content).toContain('"Notification"');

  const promptHookWrapper = findContentOperation(operations, join("hooks", "prompt-submitted.mjs"));
  expect(promptHookWrapper).toBeDefined();
  await writeText(promptHookWrapper!.targetPath, promptHookWrapper!.content);
  const promptRes = await runGeneratedHookWrapper(promptHookWrapper!.targetPath, {
    prompt: "hello",
    workspaceRoot: pluginRoot,
  });
  expect(promptRes.exitCode).toBe(0);
  expect(promptRes.stdout.trim()).toBe("");

  const subagentHookWrapper = findContentOperation(operations, join("hooks", "subagent-stopped.mjs"));
  expect(subagentHookWrapper).toBeDefined();
  await writeText(subagentHookWrapper!.targetPath, subagentHookWrapper!.content);
  const subagentRes = await runGeneratedHookWrapper(subagentHookWrapper!.targetPath, {
    subagent: { id: "123", type: "research" },
    workspaceRoot: pluginRoot,
  });
  expect(subagentRes.exitCode).toBe(0);
  expect(subagentRes.stdout.trim()).toBe("");

  const notifyHookWrapper = findContentOperation(operations, join("hooks", "notified.mjs"));
  expect(notifyHookWrapper).toBeDefined();
  await writeText(notifyHookWrapper!.targetPath, notifyHookWrapper!.content);
  const notifyRes = await runGeneratedHookWrapper(notifyHookWrapper!.targetPath, {
    message: "alert",
    kind: "warning",
    workspaceRoot: pluginRoot,
  });
  expect(notifyRes.exitCode).toBe(0);
  expect(notifyRes.stdout.trim()).toBe("");
});

test("grok project lowerer emits agents and skills directly without a shadow plugin bundle", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "grok-project-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      name: "grok-project-fixture",
      version: "0.1.0",
      targets: { skills: ["grok"], orbits: ["grok"] },
    }, null, 2) + "\n",
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Project testing guidance\n---\n\n# Testing\n",
  );
  await writeText(
    join(pluginRoot, "orbits", "delivery.orbit.ts"),
    "export default { name: 'delivery', description: 'Project delivery orbit', phases: [{ name: 'Build' }] };\n",
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const { files, regions } = await planLowering({
    agents: [{
      name: "worker",
      description: "Project worker",
      body: "# Worker\n",
      color: undefined,
      model: { model: "grok-4.5" },
      targetOverride: {},
      skills: [],
      allowedSkills: [],
      allowedTools: [],
      toolBindings: [],
    }],
    orbits: [...registry.orbits.values()],
    skills: [...registry.skills.values()],
    hooks: [],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "grok-project-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  expect(files.map((file) => file.targetPath).sort()).toEqual([
    join(outputRoot, "agents", "worker.md"),
    join(outputRoot, "skills", "delivery", "SKILL.md"),
    join(outputRoot, "skills", "testing", "SKILL.md"),
  ].sort());
  expect(files.some((file) => file.targetPath.includes(`${join(outputRoot, "plugins")}/`))).toBe(false);
  expect(findContentOperation(files, join("hooks", "hooks.json"))).toBeUndefined();
  expect(regions).toEqual([]);
});

test("grok global lowerer omits an empty hooks map", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const { files } = await planLowering({
    agents: [{
      name: "worker",
      description: "Global worker",
      body: "# Worker\n",
      color: undefined,
      model: {},
      targetOverride: {},
      skills: [],
      allowedSkills: [],
      allowedTools: [],
      toolBindings: [],
    }],
    orbits: [],
    skills: [],
    hooks: [],
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "grok-global-fixture",
      sourcePluginVersion: "0.1.0",
    },
  });

  expect(findContentOperation(files, join(".claude-plugin", "plugin.json"))).toBeDefined();
  expect(findContentOperation(files, join("agents", "worker.md"))?.targetPath).toContain(
    join(outputRoot, "plugins", "prism-generated-grok-global-fixture"),
  );
  expect(findContentOperation(files, join("hooks", "hooks.json"))).toBeUndefined();
});

test("grok project lowerer rejects non-empty hooks with an actionable exactly-once diagnostic", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "grok-project-hooks-fixture");
  const hookPath = join(pluginRoot, "hooks", "started.hook.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      name: "grok-project-hooks-fixture",
      version: "0.1.0",
      targets: { hooks: ["grok"] },
    }, null, 2) + "\n",
  );
  await writeText(
    hookPath,
    "export default { name: 'started', event: 'session.start', handle: () => ({ decision: 'continue' }) };\n",
  );
  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("started");
  if (!hook) throw new Error("expected started hook");

  await expect(planLowering({
    agents: [],
    orbits: [],
    skills: [],
    hooks: [hook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "grok-project-hooks-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  })).rejects.toThrow(
    "Grok project-scope hooks are unsupported until Prism can prove exactly-once hook loading",
  );
  await expect(planLowering({
    agents: [],
    orbits: [],
    skills: [],
    hooks: [hook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "grok-project-hooks-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  })).rejects.toThrow(hookPath);
});

test("grok agent MCP tool advertisement and config share the MCP emit flag", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const binding = permissionBinding("owner-tools", "echo");
  const previous = process.env.PRISM_TOOLS_MCP_EMIT;
  const output = await (async () => {
    process.env.PRISM_TOOLS_MCP_EMIT = "0";
    try {
      return await planLowering({
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
        skills: [],
        hooks: [],
        target: {
          scope: "project",
          root: outputRoot,
          sourcePluginName: "grok-mcp-off-fixture",
          sourcePluginVersion: "0.1.0",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.PRISM_TOOLS_MCP_EMIT;
      else process.env.PRISM_TOOLS_MCP_EMIT = previous;
    }
  })();

  const agent = findContentOperation(output.files, join("agents", "consumer.md"));
  const generatedName = renderPluginAllowlist(
    "grok",
    "owner-tools",
    mcpToolNameForBinding("owner-tools", binding),
  );
  expect(agent?.content).toContain('- "read_file"');
  expect(agent?.content).not.toContain(generatedName);
  expect(output.regions).toEqual([]);
});

test("grok lowerer preserves frontmatter precedence and omission rules", async () => {
  const root = await createTempRoot();
  const { files: operations } = await planLowering({
    agents: [
      {
        name: "frontmatter-precedence",
        description: "Base frontmatter description",
        body: "# Frontmatter\n\nExercise Grok frontmatter precedence.",
        color: undefined,
        model: { model: "model-fallback", temperature: 0, top_p: 0 },
        targetOverride: {
          grok: {
            description: "Override frontmatter description",
            permission_mode: "acceptEdits",
            permissionMode: "auto",
            agents_md: false,
            reasoning_effort: "high",
            tools: ["run_terminal_cmd", "read_file", 42],
            "allowed-tools": ["read_file", "grep_search", false],
            disallowedTools: ["web_fetch", 99],
            "disallowed-tools": ["web_fetch", "web_search", null],
          },
        },
        skills: ["direct-skill"],
        allowedSkills: ["zeta", "alpha", "alpha"],
        allowedTools: ["grep_search", "list_files"],
        toolBindings: [],
      },
      {
        name: "frontmatter-omission",
        description: "Omission description",
        body: "# Omission\n\nExercise omitted Grok frontmatter values.",
        color: undefined,
        model: { model: 123, effort: false, variant: null, reasoning_effort: "ignored" },
        targetOverride: { grok: {} },
        skills: ["direct-skill"],
        allowedSkills: [],
        allowedTools: [],
        toolBindings: [],
      },
    ],
    orbits: [],
    skills: [],
    hooks: [],
    target: {
      scope: "project",
      root: join(root, ".grok"),
      sourcePluginName: "frontmatter-fixture",
      sourcePluginVersion: "0.1.0",
    },
  });

  const precedenceAgent = findContentOperation(
    operations,
    join("agents", "frontmatter-precedence.md"),
  );
  expect(precedenceAgent?.content).toContain('name: "frontmatter-precedence"');
  expect(precedenceAgent?.content).toContain('description: "Override frontmatter description"');
  expect(precedenceAgent?.content).toContain('model: "model-fallback"');
  expect(precedenceAgent?.content).toContain('permission_mode: "acceptEdits"');
  expect(precedenceAgent?.content).not.toContain('permission_mode: "auto"');
  expect(precedenceAgent?.content).toContain("agents_md: false");
  expect(precedenceAgent?.content).toContain('reasoning_effort: "high"');
  expect(precedenceAgent?.content).toContain("temperature: 0");
  expect(precedenceAgent?.content).toContain("top_p: 0");
  expect(precedenceAgent?.content).toContain(
    'tools:\n  - "grep_search"\n  - "list_files"\n  - "read_file"\n  - "run_terminal_cmd"',
  );
  expect(precedenceAgent?.content).toContain(
    'disallowedTools:\n  - "web_fetch"\n  - "web_fetch"\n  - "web_search"',
  );
  // Skills are intentionally omitted for Grok (preload = full bodies).
  expect(precedenceAgent?.content).not.toContain("\nskills:");
  expect(precedenceAgent?.content).not.toContain("direct-skill");
  expect(precedenceAgent?.content).not.toContain('"alpha"');
  expect(precedenceAgent?.content).not.toContain('"zeta"');

  const omissionAgent = findContentOperation(
    operations,
    join("agents", "frontmatter-omission.md"),
  );
  expect(omissionAgent?.content).toContain('name: "frontmatter-omission"');
  expect(omissionAgent?.content).toContain('description: "Omission description"');
  expect(omissionAgent?.content).not.toContain("\nmodel:");
  expect(omissionAgent?.content).not.toContain("\nprompt_mode:");
  expect(omissionAgent?.content).not.toContain("\npermission_mode:");
  expect(omissionAgent?.content).not.toContain("\nreasoning_effort:");
  expect(omissionAgent?.content).not.toContain("\ntools:");
  expect(omissionAgent?.content).not.toContain("\nskills:");
  expect(omissionAgent?.content).not.toContain("direct-skill");
});

test("grok lowerer emits no MCP config region for self-owned tools", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "grok-shim-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "grok-shim-fixture",
        version: "0.1.0",
        targets: {
          tools: ["grok"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

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
  const { files: operations, regions } = await planLowering({
    agents: [],
    orbits: [],
    tools: [...registry.tools.values()],
    skills: [],
    hooks: [],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "grok-shim-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  // MCP config emission was excised — tools are CLI-only.
  expect(findContentOperation(operations, ".mcp.json")).toBeUndefined();
  expect(regions.some((region) => region.regionKey.startsWith("grok.mcp."))).toBe(false);
});

test("grok lowerer fails closed when hook matcher has no Grok target mapping", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "invalid-grok-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "invalid-grok-hook-fixture", version: "0.1.0", targets: { toolspaces: ["grok"], hooks: ["grok"] } }, null, 2)}\n`,
  );
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `
export default {
  name: "workspace",
  tools: { shell: { targets: { opencode: { name: "bash" } } } },
};
`);
  await writeText(join(pluginRoot, "hooks", "audit-shell.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "audit-shell",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
};
`);

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");
  if (!hook) throw new Error("expected audit-shell hook");

  await expect(
    planLowering({
      agents: [],
      orbits: [],
      skills: [],
      hooks: [hook],
      registry,
      target: {
        scope: "global",
        root: outputRoot,
        sourcePluginName: "invalid-grok-hook-fixture",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: pluginRoot,
      },
    }),
  ).rejects.toThrow("has no 'grok' target binding");
});

test("grok lowerer reproduces the reported typefully-cli overflow and keeps it compliant (PQ-168)", async () => {
  const root = await createTempRoot();
  const binding = permissionBinding("typefully-cli", "linkedin_organizations_resolve");

  const { files: operations } = await planLowering({
    agents: [
      {
        name: "typefully-consumer",
        description: "Consumes a foreign typefully-cli tool",
        body: "# Typefully consumer\n",
        color: undefined,
        model: {},
        targetOverride: {},
        skills: [],
        allowedSkills: [],
        allowedTools: [],
        toolBindings: [binding],
      },
    ],
    orbits: [],
    skills: [],
    hooks: [],
    target: {
      scope: "project",
      root: join(root, ".grok"),
      sourcePluginName: "scribe",
      sourcePluginVersion: "0.1.0",
    },
  });

  const agent = findContentOperation(operations, join("agents", "typefully-consumer.md"));
  // Tools are CLI-only — agent frontmatter no longer lists MCP wire names.
  expect(agent?.content).not.toContain("mcp__");
  expect(agent?.content).not.toContain("tools:");
  expect(agent?.content).toContain("# Typefully consumer");
});

test("grok lowerer no longer emits generated tool wire names in agent frontmatter", async () => {
  const root = await createTempRoot();

  // A representative corpus: the reported real-world case, short names,
  // and adversarially long plugin/tool name combinations that push the raw
  // qualified name (server + separator + tool segment) well past 64 chars
  // before any capping.
  const corpus: ReadonlyArray<{ readonly plugin: string; readonly tool: string }> = [
    { plugin: "typefully-cli", tool: "linkedin_organizations_resolve" },
    { plugin: "a", tool: "b" },
    { plugin: "scribe", tool: "voice_profile" },
    { plugin: "prism-generated-forge", tool: "submit_review_requirements_trace_review_details" },
    { plugin: "x".repeat(40), tool: "y".repeat(80) },
    { plugin: "another-very-long-plugin-name-indeed", tool: "z".repeat(120) },
  ];

  const bindings = corpus.map(({ plugin, tool }) => permissionBinding(plugin, tool));

  const { files: operations } = await planLowering({
    agents: [
      {
        name: "corpus-consumer",
        description: "Consumes every binding in the corpus",
        body: "# Corpus consumer\n",
        color: undefined,
        model: {},
        targetOverride: {},
        skills: [],
        allowedSkills: [],
        allowedTools: [],
        toolBindings: bindings,
      },
    ],
    orbits: [],
    skills: [],
    hooks: [],
    target: {
      scope: "project",
      root: join(root, ".grok"),
      sourcePluginName: "corpus-fixture",
      sourcePluginVersion: "0.1.0",
    },
  });

  const agent = findContentOperation(operations, join("agents", "corpus-consumer.md"));
  // Tools are CLI-only — generated MCP wire names are no longer emitted into
  // Grok agent frontmatter. CLI names stay under the portable length budget.
  expect(agent?.content).not.toContain("\ntools:");
  expect(agent?.content).not.toContain("mcp__");
  for (const { plugin, tool } of corpus) {
    const name = mcpToolNameForBinding(plugin, permissionBinding(plugin, tool));
    expect(name.length).toBeLessThanOrEqual(GROK_MAX_TOOL_NAME_LENGTH);
  }
});

// The core cap/collision algorithm now lives in `capGrokWireName`
// coverage there (compliant-untouched, truncate+hash, determinism, collision
// guard). This test keeps only the one boundary case not covered there: a
// truncation cut landing mid-run-of-underscores must not leave a doubled or
// dangling underscore where the hash suffix is joined on — exercised here at
// the budget Grok's shim actually uses.
test("capGrokWireName does not leave a doubled or dangling underscore at a mid-run-of-underscores truncation boundary", () => {
  const budget = GROK_MAX_TOOL_NAME_LENGTH - pluginServerKey("typefully-cli").length - 2;
  const prefixLength = budget - 8 - 1;
  const trailingUnderscoreAtBoundary = `${"a".repeat(prefixLength - 5)}_____${"b".repeat(50)}`;
  const cappedTrailingUnderscore = capGrokWireName(trailingUnderscoreAtBoundary, budget);
  expect(cappedTrailingUnderscore.length).toBeLessThanOrEqual(budget);
  expect(cappedTrailingUnderscore).toMatch(GROK_TOOL_NAME_REGEX);
  expect(cappedTrailingUnderscore).not.toMatch(/__/u);
});
