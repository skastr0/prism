import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/grok.js";
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

test("grok lowerer emits a plugin bundle with agents, skills, MCP, and hooks", async () => {
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
    `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { shell: { targets: { "grok": { name: "run_terminal_cmd" } } } },
});
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-shell.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-shell",
  description: "Audit shell commands",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
});
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-echo.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-echo",
  description: "Audit canonical echo calls",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.canonical("echo") },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "session-ended.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "session-ended",
  description: "Observe session end",
  event: hookEvent.sessionEnd,
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`,
  );

  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
});
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");
  const canonicalHook = registry.hooks.get("audit-echo");
  const sessionEndHook = registry.hooks.get("session-ended");
  if (!hook) throw new Error("expected audit-shell hook");
  if (!canonicalHook) throw new Error("expected audit-echo hook");
  if (!sessionEndHook) throw new Error("expected session-ended hook");

  const { files: operations } = await planLowering({
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
        toolBindings: [
          {
            kind: "permission",
            logicalName: "echo",
            toolPluginName: "grok-plugin-fixture",
            toolName: "echo",
            toolSourcePath: toolPath,
          },
        ],
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
    hooks: [hook, canonicalHook, sessionEndHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      mcpServerPath: join(root, "prism-home", "runtime", "mcp", "grok-plugin-fixture", "server.mjs"),
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
  expect(agent?.content).toContain('skills:\n  - "testing"');
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

  const mcpConfig = findContentOperation(operations, ".mcp.json");
  expect(mcpConfig?.content).toContain('"prism-generated-grok-plugin-fixture"');
  const mcpParsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const grokEntry = mcpParsed.mcpServers?.["prism-generated-grok-plugin-fixture"];
  expect(grokEntry?.command).toBe("bun");
  expect(grokEntry?.args).toEqual([
    join(root, "prism-home", "runtime", "mcp", "grok-plugin-fixture", "server.mjs"),
  ]);
  // Deny-by-default exposure: Grok has no client-side tool filter, so the
  // per-harness tool names ride PRISM_MCP_ENABLED_TOOLS.
  expect(grokEntry?.env).toEqual({
    PRISM_MCP_ENABLED_TOOLS: "grok_plugin_fixture_echo",
  });

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
  expect(hookConfig?.content).toContain(
    '"matcher": "prism-generated-grok-plugin-fixture__grok_plugin_fixture_echo"',
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
  expect(precedenceAgent?.content).toContain('skills:\n  - "alpha"\n  - "zeta"');
  expect(precedenceAgent?.content).not.toContain("direct-skill");

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

test("grok lowerer fails closed for Streamable HTTP MCP opt-in", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "grok-http-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "grok-http-fixture",
        version: "0.1.0",
        targets: {
          tools: ["grok"],
        },
        runtime: {
          mcp: {
            grok: {
              transport: "streamable-http",
              host: "127.0.0.1",
              port: 38467,
              tokenEnv: "PRISM_MCP_GROK_HTTP_TOKEN",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  await expect(
    planLowering({
      agents: [],
      orbits: [],
      skills: [],
      hooks: [],
      registry,
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName: "grok-http-fixture",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: pluginRoot,
      },
    }),
  ).rejects.toThrow("Streamable HTTP MCP is not supported for target 'grok'");
});

test("grok lowerer fails closed when hook matcher has no Grok target mapping", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".grok");
  const pluginRoot = join(root, "invalid-grok-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "invalid-grok-hook-fixture", version: "0.1.0", targets: { toolspaces: ["grok"], hooks: ["grok"] } }, null, 2)}\n`,
  );
  await writeText(join(pluginRoot, "toolspaces", "workspace.toolspace.ts"), `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { shell: { targets: { opencode: { name: "bash" } } } },
});
`);
  await writeText(join(pluginRoot, "hooks", "audit-shell.hook.ts"), `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-shell",
  event: hookEvent.toolBefore,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
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
