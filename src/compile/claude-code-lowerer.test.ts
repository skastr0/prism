import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/claude-code.js";
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
    `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { shell: { targets: { "claude-code": { name: "Bash" } } } },
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
      mcpRuntimePort: 38465,
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
  expect(agent?.content).toContain('- "mcp__prism-generated-claude-plugin-fixture__claude_plugin_fixture_echo"');
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
  expect(mcpConfig?.content).toContain('"prism-generated-claude-plugin-fixture"');
  const mcpParsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
  };
  const httpEntry = mcpParsed.mcpServers?.["prism-generated-claude-plugin-fixture"];
  expect(httpEntry).toEqual({
    type: "http",
    url: "http://127.0.0.1:38465/mcp",
    headers: {
      Authorization: "Bearer ${PRISM_MCP_TOKEN}",
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
  expect(hookConfig?.content).toContain(
    '"matcher": "mcp__prism-generated-claude-plugin-fixture__claude_plugin_fixture_echo"',
  );
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
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stdout).toBe("");
  expect(blocked.stderr).toContain("blocked");
});

test("claude-code lowerer emits Streamable HTTP MCP config when opted in", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const pluginRoot = join(root, "claude-http-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "claude-http-fixture",
        version: "0.1.0",
        targets: {
          tools: ["claude-code"],
        },
        runtime: {
          mcp: {
            "claude-code": {
              transport: "streamable-http",
              host: "127.0.0.1",
              port: 38465,
              tokenEnv: "PRISM_MCP_CLAUDE_HTTP_TOKEN",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo over HTTP",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: input.message };
  },
});
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const { files: operations } = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Claude HTTP MCP",
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
            toolPluginName: "claude-http-fixture",
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
      mcpBearerToken: "claude-static-token",
      sourcePluginName: "claude-http-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const mcpConfig = findContentOperation(operations, ".mcp.json");
  const parsed = JSON.parse(mcpConfig?.content ?? "{}") as {
    mcpServers?: Record<string, unknown>;
  };
  expect(parsed.mcpServers?.["prism-generated-claude-http-fixture"]).toEqual({
    type: "http",
    url: "http://127.0.0.1:38465/mcp",
    headers: {
      Authorization: "Bearer claude-static-token",
    },
  });
  expect(mcpConfig?.content).not.toContain('"command"');
  expect(mcpConfig?.content).not.toContain('"args"');
  expect(mcpConfig?.mode).toBe(0o600);

  // HTTP daemons consume the canonical PRISM_HOME bundle; the lowerer
  // plans no bundle write anywhere.
  const bundle = operations.find(
    (operation) => operation.targetPath.endsWith("server.mjs"),
  );
  expect(bundle).toBeUndefined();
});

test("claude-code lowerer fails closed when hook matcher has no Claude target mapping", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".claude");
  const pluginRoot = join(root, "invalid-claude-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "invalid-claude-hook-fixture", version: "0.1.0", targets: { toolspaces: ["claude-code"], hooks: ["claude-code"] } }, null, 2)}\n`,
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
        sourcePluginName: "invalid-claude-hook-fixture",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: pluginRoot,
      },
    }),
  ).rejects.toThrow("has no 'claude-code' target binding");
});
