import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/codex-cli.js";
import type { LowerOperation } from "./lowerers/opencode.js";

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
  const root = await mkdtemp(join(tmpdir(), "prism-codex-mcp-test-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

type ContentOperation = Extract<LowerOperation, { readonly content: string }>;

const isContentOperation = (operation: LowerOperation): operation is ContentOperation =>
  "content" in operation;

const findContentOperation = (
  operations: ReadonlyArray<LowerOperation>,
  suffix: string,
): ContentOperation | undefined =>
  operations.find(
    (operation): operation is ContentOperation =>
      isContentOperation(operation) && operation.target.endsWith(suffix),
  );

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

test("codex-cli lowerer emits MCP server bundle and managed config", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".codex");
  const pluginRoot = join(root, "codex-mcp-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "codex-mcp-fixture",
        version: "0.1.0",
        targets: {
          rules: ["codex-cli"],
          skills: ["codex-cli"],
          toolspaces: ["codex-cli"],
          hooks: ["codex-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(outputRoot, "config.toml"),
    `model = "codex-default"

[features]
codex_hooks = true
model_widget = true

# --- prism codex-cli begin: codex-mcp-fixture ---
stale = true
# --- prism codex-cli end: codex-mcp-fixture ---
`,
  );

  await writeText(
    join(pluginRoot, "rules", "global", "context.md"),
    `# Codex context\n\nUse project rules.\n`,
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
  tools: {
    shell: { targets: { "codex-cli": { name: "shell.command" } } },
  },
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
    join(pluginRoot, "hooks", "audit-shell-after.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool, toolRef } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "audit-shell-after",
  description: "Audit shell command responses",
  event: hookEvent.toolAfter,
  match: { tool: hookTool.tool(toolRef("workspace", "shell")) },
  handle: (event) => Effect.succeed(event.tool.output?.ok ? { decision: "continue" as const } : { decision: "block" as const, message: "missing tool_response fallback" }),
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
  const afterHook = registry.hooks.get("audit-shell-after");
  const sessionEndHook = registry.hooks.get("session-ended");
  if (!hook) throw new Error("expected audit-shell hook");
  if (!afterHook) throw new Error("expected audit-shell-after hook");
  if (!sessionEndHook) throw new Error("expected session-ended hook");

  const operations = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Codex MCP",
        body: "# Reviewer\n\nUse the generated MCP server.",
        color: undefined,
        model: { model: "gpt-5", effort: "high" },
        targetOverride: { "codex-cli": { model_verbosity: "medium", profile: "review" } },
        skills: [],
        allowedSkills: [],
        allowedTools: ["Shell"],
        toolBindings: [
          {
            kind: "permission",
            logicalName: "echo",
            toolPluginName: "codex-mcp-fixture",
            toolName: "echo",
            toolSourcePath: toolPath,
          },
        ],
      },
    ],
    orbits: [],
    tools: [],
    skills: [...registry.skills.values()],
    hooks: [hook, afterHook, sessionEndHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "codex-mcp-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const agentToml = findContentOperation(operations, join("agents", "reviewer.toml"));
  expect(agentToml?.content).toContain('name = "reviewer"');
  expect(agentToml?.content).toContain('developer_instructions = "# Reviewer\\n\\nUse the generated MCP server."');
  expect(agentToml?.content).toContain('model = "gpt-5"');
  expect(agentToml?.content).toContain('model_reasoning_effort = "high"');
  expect(agentToml?.content).toContain('model_verbosity = "medium"');
  expect(agentToml?.content).toContain('profile = "review"');
  expect(agentToml?.content).not.toContain('\neffort = "high"');
  expect(agentToml?.content).not.toContain("temperature");
  expect(agentToml?.content).toContain("Codex has no direct equivalent for harness-native per-role tool allowlists");
  expect(agentToml?.content).toContain('["mcp_servers"."prism-generated-codex-mcp-fixture"]');
  expect(agentToml?.content).toContain('command = "bun"');
  expect(agentToml?.content).toContain('args = ["mcp/prism_generated_codex_mcp_fixture/server.mjs"]');
  expect(agentToml?.content).toContain(`cwd = ${JSON.stringify(outputRoot)}`);
  expect(agentToml?.content).toContain('default_tools_approval_mode = "approve"');
  expect(agentToml?.content).toContain('enabled_tools = ["codex_mcp_fixture_echo"]');

  const skill = findContentOperation(operations, join("skills", "testing", "SKILL.md"));
  expect(skill?.content).toContain("# Testing");

  const rules = findContentOperation(operations, "AGENTS.md");
  expect(rules?.content).toContain('<!-- prism:rules source="global/context.md" -->');
  expect(rules?.content).toContain("Use project rules.");

  const bundle = findContentOperation(
    operations,
    join("mcp", "prism_generated_codex_mcp_fixture", "server.mjs"),
  );
  expect(bundle?.content).toContain("codex_mcp_fixture_echo");
  expect(bundle?.content).toContain("tools/list");

  const configToml = findContentOperation(operations, "config.toml");
  expect(configToml?.content).toContain('model = "codex-default"');
  expect(configToml?.content).toContain("[features]\nhooks = true\nmodel_widget = true");
  expect(configToml?.content).not.toContain("codex_hooks");
  expect(configToml?.content).not.toContain("stale = true");
  expect(configToml?.content).toContain("# --- prism codex-cli begin: codex-mcp-fixture ---");
  expect(configToml?.content).not.toContain('["mcp_servers"."prism-generated-codex-mcp-fixture"]');
  expect(configToml?.content).not.toContain('args = ["mcp/prism_generated_codex_mcp_fixture/server.mjs"]');
  expect(configToml?.content).not.toContain('default_tools_approval_mode = "approve"');
  expect(configToml?.content).not.toContain('enabled_tools = ["codex_mcp_fixture_echo"]');
  expect(configToml?.content).toContain('[["hooks"."PreToolUse"]]');
  expect(configToml?.content).toContain('[["hooks"."PostToolUse"]]');
  expect(configToml?.content).toContain('[["hooks"."Stop"]]');
  expect(configToml?.content).toContain('matcher = "shell\\\\.command"');
  expect(configToml?.content).toContain('statusMessage = "prism hook audit-shell"');

  const hookWrapper = findContentOperation(operations, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain("input?.tool_response");
  expect(hookWrapper?.content).toContain("native payload");
  expect(hookWrapper?.content).toContain("validation failed");
  expect(hookWrapper?.content).toContain("result");
  expect(hookWrapper?.content).toContain('harness: "codex-cli"');
  expect(hookWrapper?.content).toContain("input?.cwd");
  expect(hookWrapper?.content).toContain("console.error");
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");
  await writeText(hookWrapper.target, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.target, {
    tool: { name: "shell.command", input: { block: true } },
    cwd: pluginRoot,
  });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stdout).toBe("");
  expect(blocked.stderr).toContain("blocked");

  const afterHookWrapper = findContentOperation(
    operations,
    join("hooks", "audit-shell-after.mjs"),
  );
  if (!afterHookWrapper) throw new Error("expected audit-shell-after wrapper");
  await writeText(afterHookWrapper.target, afterHookWrapper.content);
  const afterResult = await runGeneratedHookWrapper(afterHookWrapper.target, {
    tool: { name: "shell.command", input: {} },
    tool_response: { ok: true },
    cwd: pluginRoot,
  });
  expect(afterResult.exitCode).toBe(0);
  expect(afterResult.stdout).toBe("");
  expect(afterResult.stderr).toBe("");
});

test("codex-cli lowerer emits Streamable HTTP MCP config when opted in", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".codex");
  const pluginRoot = join(root, "codex-http-fixture");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "codex-http-fixture",
        version: "0.1.0",
        targets: {
          tools: ["codex-cli"],
        },
        runtime: {
          mcp: {
            "codex-cli": {
              transport: "streamable-http",
              host: "127.0.0.1",
              port: 38464,
              tokenEnv: "PRISM_MCP_CODEX_HTTP_TOKEN",
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
  const tool = registry.tools.get("echo");
  if (!tool) throw new Error("expected echo tool");

  const operations = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Codex HTTP MCP",
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
            toolPluginName: "codex-http-fixture",
            toolName: "echo",
            toolSourcePath: toolPath,
          },
        ],
      },
    ],
    orbits: [],
    tools: [tool],
    skills: [],
    hooks: [],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "codex-http-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const agentToml = findContentOperation(operations, join("agents", "reviewer.toml"));
  expect(agentToml?.content).toContain('["mcp_servers"."prism-generated-codex-http-fixture"]');
  expect(agentToml?.content).toContain('url = "http://127.0.0.1:38464/mcp"');
  expect(agentToml?.content).toContain('bearer_token_env_var = "PRISM_MCP_CODEX_HTTP_TOKEN"');
  expect(agentToml?.content).not.toContain('command = "bun"');
  expect(agentToml?.content).not.toContain("args = ");
  expect(agentToml?.content).toContain('enabled_tools = ["codex_http_fixture_echo"]');

  const configToml = findContentOperation(operations, "config.toml");
  expect(configToml?.content).toContain('["mcp_servers"."prism-generated-codex-http-fixture"]');
  expect(configToml?.content).toContain('url = "http://127.0.0.1:38464/mcp"');
  expect(configToml?.content).toContain('bearer_token_env_var = "PRISM_MCP_CODEX_HTTP_TOKEN"');
  expect(configToml?.content).not.toContain('command = "bun"');
  expect(configToml?.content).not.toContain("args = ");
  expect(configToml?.content).toContain('enabled_tools = ["codex_http_fixture_echo"]');

  const bundle = operations.find(
    (operation): operation is ContentOperation =>
      isContentOperation(operation) &&
      operation.target === join(outputRoot, "prism", "mcp", "prism_generated_codex_http_fixture", "server.mjs"),
  );
  expect(bundle?.content).toContain("codex_http_fixture_echo");
  expect(bundle?.content).toContain("PRISM_MCP_CODEX_HTTP_TOKEN");
});

test("codex-cli lowerer fails closed for unsupported model config keys", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".codex");

  await expect(
    planLowering({
      agents: [
        {
          name: "reviewer",
          description: "Reviews through Codex MCP",
          body: "# Reviewer",
          color: undefined,
          model: { model: "gpt-5", temperature: 0.2 },
          targetOverride: {},
          skills: [],
          allowedSkills: [],
          allowedTools: [],
          toolBindings: [],
        },
      ],
      orbits: [],
      tools: [],
      skills: [],
      hooks: [],
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName: "codex-mcp-fixture",
        sourcePluginVersion: "0.1.0",
      },
    }),
  ).rejects.toThrow("unsupported Codex model config key 'temperature'");
});
