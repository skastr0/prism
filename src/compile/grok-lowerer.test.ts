import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/grok.js";
import { mcpToolNameForBinding } from "./mcp-bundle.js";
import {
  capGrokWireName,
  createGrokCollisionGuard,
  pluginServerKey,
  renderPluginAllowlist,
} from "@skastr0/prism-sdk/mcp/wire-naming";
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

test("grok lowerer emits a plugin bundle with agents, skills, HTTP MCP, and hooks", async () => {
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
      scope: "project",
      root: outputRoot,
      mcpExposureProfile: "prism-generated-grok-plugin-fixture:grok",
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

  // The shim registration is a managed region in <grok-root>/config.toml —
  // grok never resolves a `.mcp.json` inside an installed plugin bundle, so
  // a bundle-level file would leave every generated tool unreachable.
  expect(findContentOperation(operations, ".mcp.json")).toBeUndefined();
  const ownerServerKey = pluginServerKey("grok-plugin-fixture");
  const mcpRegion = regions.find((region) => region.regionKey === `grok.mcp.${ownerServerKey}`);
  if (mcpRegion?.kind !== "marker") throw new Error("expected a marker region for the grok shim");
  expect(mcpRegion.targetPath).toBe(join(outputRoot, "config.toml"));
  expect(mcpRegion.plugin).toBe("grok-plugin-fixture");
  expect(mcpRegion.content).toContain(`["mcp_servers"."${ownerServerKey}"]`);
  expect(mcpRegion.content).toContain('command = "prism"');
  expect(mcpRegion.content).toContain('args = ["mcp", "shim"]');
  expect(mcpRegion.content).toContain(`["mcp_servers"."${ownerServerKey}"."env"]`);
  expect(mcpRegion.content).toContain('PRISM_SHIM_PLUGINS = "grok-plugin-fixture"');
  expect(mcpRegion.content).toContain('PRISM_SHIM_HARNESS = "grok"');
  expect(mcpRegion.content).toContain('PRISM_SHIM_NAMING = "per-plugin"');
  // Per-plugin regions never carry an explicit exposure profile: absent, the
  // shim derives `prism-generated-<owner>:grok` itself.
  expect(mcpRegion.content).not.toContain("PRISM_SHIM_EXPOSURE");
  expect(mcpRegion.content).not.toContain("http");
  expect(mcpRegion.content).not.toContain("PRISM_MCP_ENABLED_TOOLS");

  // The bundle itself lives in PRISM_HOME — never in the generated plugin.
  const bundle = operations.find(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  );
  expect(bundle).toBeUndefined();

  const hookConfig = findContentOperation(operations, join("hooks", "hooks.json"));
  expect(hookConfig?.content).toContain('"PreToolUse"');
  expect(hookConfig?.content).toContain('"SessionEnd"');
  expect(hookConfig?.content).not.toContain('"Stop"');
  expect(hookConfig?.content).toContain('"matcher": "run_terminal_cmd"');
  const generatedEchoTool = renderPluginAllowlist("grok", "grok-plugin-fixture", "grok_plugin_fixture_echo");
  const generatedSyntheticTool = renderPluginAllowlist(
    "grok",
    "grok-plugin-fixture",
    mcpToolNameForBinding("grok-plugin-fixture", longSyntheticBinding),
  );
  expect(generatedEchoTool).toBe(`${ownerServerKey}__echo`);
  expect(generatedEchoTool.length).toBeLessThanOrEqual(GROK_MAX_TOOL_NAME_LENGTH);
  expect(generatedSyntheticTool.length).toBeLessThanOrEqual(GROK_MAX_TOOL_NAME_LENGTH);
  expect(generatedSyntheticTool.split("__")).toHaveLength(2);
  expect(agent?.content).toContain(`- "${generatedSyntheticTool}"`);
  expect(hookConfig?.content).toContain(
    `"matcher": "${generatedEchoTool}"`,
  );
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

test("grok lowerer emits a per-owner-plugin stdio-shim MCP entry for self-owned tools", async () => {
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
      mcpExposureProfile: "prism-generated-grok-shim-fixture:grok",
      sourcePluginName: "grok-shim-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  expect(findContentOperation(operations, ".mcp.json")).toBeUndefined();
  const ownerServerKey = pluginServerKey("grok-shim-fixture");
  const mcpRegion = regions.find((region) => region.regionKey === `grok.mcp.${ownerServerKey}`);
  if (mcpRegion?.kind !== "marker") throw new Error("expected a marker region for the grok shim");
  expect(mcpRegion.targetPath).toBe(join(outputRoot, "config.toml"));
  // The region is owned by the plugin whose server it registers, not
  // whichever compile happens to render it — stable across every compile
  // that references this owner.
  expect(mcpRegion.plugin).toBe("grok-shim-fixture");
  expect(mcpRegion.content).toBe(
    [
      `["mcp_servers"."${ownerServerKey}"]`,
      'command = "prism"',
      'args = ["mcp", "shim"]',
      "enabled = true",
      `["mcp_servers"."${ownerServerKey}"."env"]`,
      'PRISM_SHIM_PLUGINS = "grok-shim-fixture"',
      'PRISM_SHIM_HARNESS = "grok"',
      'PRISM_SHIM_NAMING = "per-plugin"',
    ].join("\n"),
  );
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
        scope: "project",
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
  const expectedName = renderPluginAllowlist(
    "grok",
    "typefully-cli",
    mcpToolNameForBinding("typefully-cli", binding),
  );

  // The reported drop was caused by a server prefix that spelled out the
  // full plugin id ("prism-generated-typefully-cli", 29 chars) instead of a
  // compact key. Under the per-plugin server scheme the server segment is
  // the owner's own (short) plugin name, and the wire segment is the bare
  // tool name with the redundant own-namespace prefix stripped — even more
  // headroom than the original compact-key fix. Assert the compact form is
  // what's actually emitted, with no truncation needed.
  expect(expectedName).toBe(
    `${pluginServerKey("typefully-cli")}__linkedin_organizations_resolve`,
  );
  expect(expectedName.length).toBeLessThanOrEqual(GROK_MAX_TOOL_NAME_LENGTH);
  expect(expectedName).toMatch(GROK_TOOL_NAME_REGEX);
  expect(agent?.content).toContain(`- "${expectedName}"`);
});

test("grok lowerer caps every generated tool name at 64 chars across a corpus of owner/tool name lengths", async () => {
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
  const toolsBlockMatch = agent?.content.match(/\ntools:\n((?:  - .*\n)+)/u);
  if (!toolsBlockMatch) throw new Error("expected a non-empty tools: block");
  const emittedNames = [...toolsBlockMatch[1]!.matchAll(/- "([^"]+)"/gu)].map((match) => match[1]!);

  expect(emittedNames.length).toBe(corpus.length);
  for (const name of emittedNames) {
    expect(name.length).toBeLessThanOrEqual(GROK_MAX_TOOL_NAME_LENGTH);
    expect(name).toMatch(GROK_TOOL_NAME_REGEX);
  }

  // Every emitted name must exactly match `renderPluginAllowlist`'s own
  // decision (byte-identical when it fits uncapped; deterministically capped
  // when it doesn't) — regeneration must never rename a compliant tool.
  // Collisions can only occur within one owner's own server namespace (see
  // `createGrokToolNamer`), so the guard is scoped per owner, matching the
  // real lowerer.
  const guards = new Map<string, ReturnType<typeof createGrokCollisionGuard>>();
  for (const { plugin, tool } of corpus) {
    let guard = guards.get(plugin);
    if (!guard) {
      guard = createGrokCollisionGuard();
      guards.set(plugin, guard);
    }
    const expected = renderPluginAllowlist(
      "grok",
      plugin,
      mcpToolNameForBinding(plugin, permissionBinding(plugin, tool)),
      guard,
    );
    expect(emittedNames).toContain(expected);
  }
});

// The core cap/collision algorithm now lives in `capGrokWireName`
// (`@skastr0/prism-sdk/mcp/wire-naming`), with its own general-purpose test
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
