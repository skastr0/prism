import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/claude-code.js";
import { pluginServerKey, renderPluginAllowlist } from "@skastr0/prism-sdk/mcp/wire-naming";
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
  const root = await mkdtemp(join(tmpdir(), "prism-claude-lowerer-"));
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

test("claude-code lowerer emits a plugin bundle with agents, skills, MCP, and hooks", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const pluginRoot = join(root, "claude-plugin-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "claude-plugin-fixture",
        version: "0.3.0",
        targets: {
          commands: ["claude-code"],
          skills: ["claude-code"],
          toolspaces: ["claude-code"],
          hooks: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "commands", "hello.md"),
    `---\ndescription: Say hello\n---\n\nSay hello from Claude plugin bundle.\n`,
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
  tools: { shell: { targets: { "claude-code": { name: "Bash" } } } },
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
  if (!hook) throw new Error("expected audit-shell hook");
  if (!canonicalHook) throw new Error("expected audit-echo hook");
  if (!sessionEndHook) throw new Error("expected session-ended hook");

  const { files: operations } = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Claude plugin bundle",
        body: "# Reviewer\n\nUse the generated Claude plugin bundle.",
        color: undefined,
        model: { model: "sonnet", effort: "high", temperature: 0.1, top_p: 0.7 },
        targetOverride: {
          "claude-code": {
            description: "Claude plugin reviewer",
            model: "opus",
            tools: ["Read"],
            "allowed-tools": ["Bash"],
            disallowedTools: ["WebFetch"],
            mcpServers: {},
          },
        },
        skills: [],
        allowedSkills: ["testing"],
        allowedTools: ["Grep"],
        toolBindings: [
          {
            kind: "permission",
            logicalName: "echo",
            toolPluginName: "claude-plugin-fixture",
            toolName: "echo",
            toolSourcePath: toolPath,
          },
        ],
      },
    ],
    orbits: [],
    skills: [...registry.skills.values()],
    hooks: [hook, canonicalHook, sessionEndHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "claude-plugin-fixture",
      sourcePluginVersion: "0.3.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const pluginManifest = findContentOperation(
    operations,
    join(".claude-plugin", "plugin.json"),
  );
  expect(pluginManifest?.targetPath).toContain(
    join(".claude", "skills", "prism-generated-claude-plugin-fixture"),
  );
  expect(pluginManifest?.content).toContain('"name": "prism-generated-claude-plugin-fixture"');

  const agent = findContentOperation(operations, join("agents", "reviewer.md"));
  expect(agent?.targetPath).toContain(
    join(".claude", "skills", "prism-generated-claude-plugin-fixture", "agents"),
  );
  expect(agent?.content).toContain('description: "Claude plugin reviewer"');
  expect(agent?.content).toContain('model: "opus"');
  expect(agent?.content).toContain('effort: "high"');
  expect(agent?.content).toContain("temperature: 0.1");
  expect(agent?.content).toContain("top_p: 0.7");
  const echoPermission = renderPluginAllowlist(
    "claude-code",
    "claude-plugin-fixture",
    "claude_plugin_fixture_echo",
  );
  expect(agent?.content).toContain(`- "${echoPermission}"`);
  expect(agent?.content).not.toContain('- "claude_plugin_fixture_echo"');
  expect(agent?.content).toContain('- "Bash"');
  expect(agent?.content).toContain('- "Grep"');
  expect(agent?.content).toContain('- "Read"');
  expect(agent?.content).toContain('disallowedTools:\n  - "WebFetch"');
  expect(agent?.content).toContain('skills:\n  - "testing"');
  expect(agent?.content).toContain("Prism Claude Plugin Diagnostics");
  expect(agent?.content).toContain("mcpServers");

  const skill = findContentOperation(operations, join("skills", "testing", "SKILL.md"));
  expect(skill?.content).toContain("# Testing");

  const command = findContentOperation(operations, join("commands", "hello.md"));
  expect(command?.content).toContain("Say hello from Claude plugin bundle.");

  const mcpConfig = findContentOperation(operations, ".mcp.json");
  const mcpParsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const ownServerKey = pluginServerKey("claude-plugin-fixture");
  expect(Object.keys(mcpParsed.mcpServers ?? {})).toEqual([ownServerKey]);
  expect(mcpParsed.mcpServers?.[ownServerKey]).toEqual({
    command: "prism",
    args: ["mcp", "shim"],
    env: {
      PRISM_SHIM_PLUGINS: "claude-plugin-fixture",
      PRISM_SHIM_HARNESS: "claude-code",
      PRISM_SHIM_NAMING: "per-plugin",
      PRISM_SHIM_EXPOSURE: "prism-generated-claude-plugin-fixture:claude-code",
    },
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
  expect(hookConfig?.content).toContain('"matcher": "Bash"');
  expect(hookConfig?.content).toContain(`"matcher": "${echoPermission}"`);
  expect(hookConfig?.content).toContain('node \\"${CLAUDE_PLUGIN_ROOT}/hooks/audit-shell.mjs\\"');

  const hookWrapper = findContentOperation(operations, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain("native payload");
  expect(hookWrapper?.content).toContain("validation failed");
  expect(hookWrapper?.content).toContain("result");
  expect(hookWrapper?.content).toContain('harness: "claude-code"');
  expect(hookWrapper?.content).toContain("workspace?.cwd");
  expect(hookWrapper?.content).toContain("console.error");
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");
  await writeText(hookWrapper.targetPath, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    tool: { name: "Bash", input: { block: true } },
    workspace: { cwd: pluginRoot },
  });
  expect(blocked.exitCode).toBe(0);
  expect(blocked.stderr).toBe("");
  const jsonResponse = JSON.parse(blocked.stdout.trim());
  expect(jsonResponse.hookSpecificOutput).toEqual({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "blocked",
  });
});

test("claude-code lowerer emits one per-plugin stdio-shim MCP entry keyed by the owner plugin's own name", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const pluginRoot = join(root, "claude-shim-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "claude-shim-fixture",
        version: "0.1.0",
        targets: {
          tools: ["claude-code"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo over the shim",
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
    agents: [
      {
        name: "reviewer",
        description: "Reviews through the Claude stdio shim",
        body: "# Reviewer",
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
            toolPluginName: "claude-shim-fixture",
            toolName: "echo",
            toolSourcePath: toolPath,
          },
        ],
      },
    ],
    orbits: [],
    skills: [],
    hooks: [],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "claude-shim-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const mcpConfig = findContentOperation(operations, ".mcp.json");
  const parsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  // One server, keyed by the owner plugin's own name — never the retired
  // shared "prism-mcp-shim" key, and never a re-export/facade entry.
  const ownServerKey = pluginServerKey("claude-shim-fixture");
  expect(Object.keys(parsed.mcpServers ?? {})).toEqual([ownServerKey]);
  expect(parsed.mcpServers?.[ownServerKey]).toEqual({
    command: "prism",
    args: ["mcp", "shim"],
    env: {
      PRISM_SHIM_PLUGINS: "claude-shim-fixture",
      PRISM_SHIM_HARNESS: "claude-code",
      PRISM_SHIM_NAMING: "per-plugin",
      PRISM_SHIM_EXPOSURE: "prism-generated-claude-shim-fixture:claude-code",
    },
  });
  expect(mcpConfig?.content).not.toContain('"type": "http"');
  expect(mcpConfig?.content).not.toContain("prism-mcp-shim");
});

test("claude-code lowerer fails closed when hook matcher has no Claude target mapping", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const pluginRoot = join(root, "invalid-claude-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "invalid-claude-hook-fixture", version: "0.1.0", targets: { toolspaces: ["claude-code"], hooks: ["claude-code"] } }, null, 2)}\n`,
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
        sourcePluginName: "invalid-claude-hook-fixture",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: pluginRoot,
      },
    }),
  ).rejects.toThrow("has no 'claude-code' target binding");
});

test("claude-code lowerer full hook event and wrapper protocol fidelity", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const pluginRoot = join(root, "claude-full-fidelity-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      name: "claude-full-fidelity-fixture",
      version: "0.1.0",
      targets: {
        hooks: ["claude-code"],
      },
    }) + "\n",
  );

  await writeText(
    join(pluginRoot, "hooks", "prompt-check.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "prompt-check",
  event: "prompt.submit",
  handle: (event) => {
    if (event.prompt.includes("block")) {
      return Effect.succeed({ decision: "block" as const, message: "blocked prompt" });
    }
    return Effect.succeed({
      decision: "continue" as const,
      additionalContext: "custom-prompt-ctx",
      systemMessage: "prompt-ok",
    });
  },
};
`
  );

  await writeText(
    join(pluginRoot, "hooks", "perm-check.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "perm-check",
  event: "permission.request",
  handle: (event) => {
    const input = event.native;
    if (input?.decision === "block") {
      return Effect.succeed({ decision: "block" as const, message: "blocked perm" });
    }
    if (input?.decision === "allow") {
      return Effect.succeed({ decision: "allow" as const, updatedInput: { allowed: true } });
    }
    if (input?.decision === "ask") {
      return Effect.succeed({ decision: "ask" as const, systemMessage: "ask-warn" });
    }
    return Effect.succeed({ decision: "continue" as const });
  },
};
`
  );

  await writeText(
    join(pluginRoot, "hooks", "stop-check.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};

export default {
  name: "stop-check",
  event: "stop",
  handle: (_event) => {
    return Effect.succeed({ decision: "block" as const, message: "stop blocked" });
  },
};
`
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const promptHook = registry.hooks.get("prompt-check");
  const permHook = registry.hooks.get("perm-check");
  const stopHook = registry.hooks.get("stop-check");
  if (!promptHook || !permHook || !stopHook) throw new Error("expected all hooks to exist");

  const { files: operations } = await planLowering({
    agents: [],
    orbits: [],
    skills: [],
    hooks: [promptHook, permHook, stopHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "claude-full-fidelity-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const hooksJsonFile = findContentOperation(operations, join("hooks", "hooks.json"));
  expect(hooksJsonFile).toBeDefined();
  const hooksJson = JSON.parse(hooksJsonFile?.content ?? "{}");

  // Verify grouping and lack of matchers for prompt.submit and stop
  expect(hooksJson.hooks.UserPromptSubmit).toEqual([
    {
      hooks: [
        {
          type: "command",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/prompt-check.mjs"',
        },
      ],
    },
  ]);
  expect(hooksJson.hooks.PermissionRequest).toEqual([
    {
      hooks: [
        {
          type: "command",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/perm-check.mjs"',
        },
      ],
    },
  ]);
  expect(hooksJson.hooks.Stop).toEqual([
    {
      hooks: [
        {
          type: "command",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-check.mjs"',
        },
      ],
    },
  ]);

  // Write and run prompt-check hook wrapper behaviors
  const promptWrapper = findContentOperation(operations, join("hooks", "prompt-check.mjs"));
  if (!promptWrapper) throw new Error("prompt-check wrapper missing");
  await writeText(promptWrapper.targetPath, promptWrapper.content);

  const promptBlockedRes = await runGeneratedHookWrapper(promptWrapper.targetPath, {
    prompt: "block",
  });
  expect(promptBlockedRes.exitCode).toBe(0);
  expect(JSON.parse(promptBlockedRes.stdout.trim())).toEqual({
    decision: "block",
    reason: "blocked prompt",
  });

  const promptOkRes = await runGeneratedHookWrapper(promptWrapper.targetPath, {
    prompt: "ok",
  });
  expect(promptOkRes.exitCode).toBe(0);
  expect(JSON.parse(promptOkRes.stdout.trim())).toEqual({
    systemMessage: "prompt-ok",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "custom-prompt-ctx",
    },
  });

  // Write and run perm-check hook wrapper behaviors
  const permWrapper = findContentOperation(operations, join("hooks", "perm-check.mjs"));
  if (!permWrapper) throw new Error("perm-check wrapper missing");
  await writeText(permWrapper.targetPath, permWrapper.content);

  const permBlockedRes = await runGeneratedHookWrapper(permWrapper.targetPath, {
    decision: "block",
  });
  expect(permBlockedRes.exitCode).toBe(0);
  expect(JSON.parse(permBlockedRes.stdout.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "blocked perm",
      },
    },
  });

  const permAllowRes = await runGeneratedHookWrapper(permWrapper.targetPath, {
    decision: "allow",
  });
  expect(permAllowRes.exitCode).toBe(0);
  expect(JSON.parse(permAllowRes.stdout.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: { allowed: true },
      },
    },
  });

  const permAskRes = await runGeneratedHookWrapper(permWrapper.targetPath, {
    decision: "ask",
  });
  expect(permAskRes.exitCode).toBe(0);
  expect(JSON.parse(permAskRes.stdout.trim())).toEqual({
    systemMessage: "ask-warn",
  });

  // Write and run stop-check hook wrapper behaviors
  const stopWrapper = findContentOperation(operations, join("hooks", "stop-check.mjs"));
  if (!stopWrapper) throw new Error("stop-check wrapper missing");
  await writeText(stopWrapper.targetPath, stopWrapper.content);

  const stopBlockedRes = await runGeneratedHookWrapper(stopWrapper.targetPath, {});
  expect(stopBlockedRes.exitCode).toBe(0);
  expect(JSON.parse(stopBlockedRes.stdout.trim())).toEqual({
    decision: "block",
    reason: "stop blocked",
  });
});

