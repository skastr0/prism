import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/codex-cli.js";
import { applySync } from "../sync/apply.js";
import { planSync } from "../sync/plan.js";
import { readSnapshot } from "../state/store.js";
import { emptySnapshotManifest } from "../state/snapshot.js";
import type { DesiredFile, DesiredRegion } from "../sync/desired.js";

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

const findFile = (
  files: ReadonlyArray<DesiredFile>,
  suffix: string,
): DesiredFile | undefined => files.find((file) => file.targetPath.endsWith(suffix));

const findRegion = (
  regions: ReadonlyArray<DesiredRegion>,
  regionKey: string,
): DesiredRegion | undefined => regions.find((region) => region.regionKey === regionKey);

const markerContent = (region: DesiredRegion | undefined): string => {
  if (!region || region.kind !== "marker") throw new Error("expected a marker region");
  return region.content;
};

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

test("codex-cli lowerer emits desired files plus config.toml regions", async () => {
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
  handle: (event) => Effect.succeed(event.tool.input?.block ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const, additionalContext: "unsupported-pretool-context" }),
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

  const lowered = await planLowering({
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
      mcpRuntimePort: 38464,
      sourcePluginName: "codex-mcp-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const agentToml = findFile(lowered.files, join("agents", "reviewer.toml"));
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
  expect(agentToml?.content).toContain('url = "http://127.0.0.1:38464/mcp"');
  expect(agentToml?.content).toContain('bearer_token_env_var = "PRISM_MCP_TOKEN"');
  expect(agentToml?.content).not.toContain('command = "bun"');
  expect(agentToml?.content).not.toContain("args = ");
  expect(agentToml?.content).not.toContain("cwd = ");
  expect(agentToml?.content).toContain('default_tools_approval_mode = "approve"');
  expect(agentToml?.content).toContain('enabled_tools = ["codex_mcp_fixture_echo"]');

  const skill = findFile(lowered.files, join("skills", "testing", "SKILL.md"));
  expect(skill?.content).toContain("# Testing");

  const rules = findFile(lowered.files, "AGENTS.md");
  expect(rules?.content).toContain('<!-- prism:rules source="global/context.md" -->');
  expect(rules?.content).toContain("Use project rules.");

  // The MCP server bundle is written once to PRISM_HOME by the pipeline —
  // the lowerer plans no bundle write inside the harness root.
  expect(findFile(lowered.files, "server.mjs")).toBeUndefined();

  // config.toml is never a whole-file write: only regions.
  expect(findFile(lowered.files, "config.toml")).toBeUndefined();
  for (const region of lowered.regions) {
    expect(region.targetPath).toBe(join(outputRoot, "config.toml"));
    expect(region.kind).toBe("marker");
  }

  // No global canonical tools here, so no mcp region — agent-level tables only.
  expect(findRegion(lowered.regions, "codex.mcp.prism-generated-codex-mcp-fixture")).toBeUndefined();

  const hooksRegion = markerContent(findRegion(lowered.regions, "codex.hooks.codex-mcp-fixture"));
  expect(hooksRegion).toContain('[["hooks"."PreToolUse"]]');
  expect(hooksRegion).toContain('[["hooks"."PostToolUse"]]');
  expect(hooksRegion).toContain('[["hooks"."Stop"]]');
  expect(hooksRegion).toContain('matcher = "shell\\\\.command"');
  expect(hooksRegion).toContain('statusMessage = "prism hook audit-shell"');

  const featuresRegion = findRegion(lowered.regions, "codex.features.hooks");
  expect(featuresRegion?.kind).toBe("marker");
  if (featuresRegion?.kind !== "marker") throw new Error("unreachable");
  expect(featuresRegion.anchor).toBe("[features]");
  expect(featuresRegion.content).toBe("hooks = true");

  const hookWrapper = findFile(lowered.files, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain("input?.tool_response");
  expect(hookWrapper?.content).toContain("native payload");
  expect(hookWrapper?.content).toContain("validation failed");
  expect(hookWrapper?.content).toContain('harness: "codex-cli"');
  expect(hookWrapper?.content).toContain("input?.cwd");
  expect(hookWrapper?.content).toContain("permissionDecision");
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");
  await writeText(hookWrapper.targetPath, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    tool: { name: "shell.command", input: { block: true } },
    cwd: pluginRoot,
  });
  expect(blocked.exitCode).toBe(0);
  expect(blocked.stderr).toBe("");
  expect(JSON.parse(blocked.stdout)).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "blocked",
    },
  });
  const continued = await runGeneratedHookWrapper(hookWrapper.targetPath, {
    tool: { name: "shell.command", input: {} },
    cwd: pluginRoot,
  });
  expect(continued.exitCode).toBe(0);
  expect(continued.stdout).toBe("");
  expect(continued.stderr).toBe("");

  const afterHookWrapper = findFile(lowered.files, join("hooks", "audit-shell-after.mjs"));
  if (!afterHookWrapper) throw new Error("expected audit-shell-after wrapper");
  await writeText(afterHookWrapper.targetPath, afterHookWrapper.content);
  const afterResult = await runGeneratedHookWrapper(afterHookWrapper.targetPath, {
    tool: { name: "shell.command", input: {} },
    tool_response: { ok: true },
    cwd: pluginRoot,
  });
  expect(afterResult.exitCode).toBe(0);
  expect(afterResult.stdout).toBe("");
  expect(afterResult.stderr).toBe("");
});

test("codex-cli config regions preserve user config.toml bytes outside fences", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".codex");
  const prismHome = join(root, "prism-home");
  const configTarget = join(outputRoot, "config.toml");

  await writeText(
    configTarget,
    `model = "codex-default"

[features]
model_widget = true

[projects."/Users/someone/code"]
trust_level = "trusted"
`,
  );

  const regions: DesiredRegion[] = [
    {
      kind: "marker",
      targetPath: configTarget,
      regionKey: "codex.hooks.fixture",
      commentPrefix: "#",
      content: '[["hooks"."Stop"]]\ntype = "command"\ncommand = "node hook.mjs"',
      plugin: "fixture",
    },
    {
      kind: "marker",
      targetPath: configTarget,
      regionKey: "codex.features.hooks",
      commentPrefix: "#",
      anchor: "[features]",
      content: "hooks = true",
      plugin: "fixture",
    },
  ];

  const plan = await planSync({
    desired: { harness: "codex-cli", root: outputRoot, files: [], regions },
    snapshot: emptySnapshotManifest({ harness: "codex-cli", root: outputRoot }),
  });
  await applySync({ prismHome, plan });

  const next = await readFile(configTarget, "utf8");
  // User content byte-preserved.
  expect(next).toContain('model = "codex-default"');
  expect(next).toContain("model_widget = true");
  expect(next).toContain('[projects."/Users/someone/code"]\ntrust_level = "trusted"');
  // The features fence is anchored directly under the user's [features]
  // header — no duplicate [features] table is ever created.
  expect(next).toContain(
    "[features]\n# --- prism:codex.features.hooks begin ---\nhooks = true\n# --- prism:codex.features.hooks end ---",
  );
  expect(next.split("[features]").length - 1).toBe(1);
  // Hooks fence appended with the sync engine grammar.
  expect(next).toContain("# --- prism:codex.hooks.fixture begin ---");
  expect(Bun.TOML.parse(next)).toBeTruthy();

  // Orphan removal: dropping the hooks region removes only its fence.
  const snapshot = await readSnapshot({ prismHome, harness: "codex-cli", root: outputRoot });
  const removalPlan = await planSync({
    desired: { harness: "codex-cli", root: outputRoot, files: [], regions: [regions[1]!] },
    snapshot: snapshot.manifest,
  });
  await applySync({ prismHome, plan: removalPlan });
  const afterRemoval = await readFile(configTarget, "utf8");
  expect(afterRemoval).not.toContain("codex.hooks.fixture");
  expect(afterRemoval).toContain("hooks = true");
  expect(afterRemoval).toContain('trust_level = "trusted"');
});

test("codex-cli lowerer renders canonical HTTP MCP config when HTTP runtime is configured", async () => {
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

  const lowered = await planLowering({
    agents: [
      {
        name: "reviewer",
        description: "Reviews through Codex MCP",
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

  const agentToml = findFile(lowered.files, join("agents", "reviewer.toml"));
  expect(agentToml?.content).toContain('["mcp_servers"."prism-generated-codex-http-fixture"]');
  expect(agentToml?.content).toContain('url = "http://127.0.0.1:38464/mcp"');
  expect(agentToml?.content).toContain('bearer_token_env_var = "PRISM_MCP_CODEX_HTTP_TOKEN"');
  expect(agentToml?.content).not.toContain('command = "bun"');
  expect(agentToml?.content).not.toContain("args = ");
  expect(agentToml?.content).not.toContain("http_headers");
  expect(agentToml?.content).not.toContain("codex-static-token");
  expect(agentToml?.content).toContain('enabled_tools = ["codex_http_fixture_echo"]');
  expect(agentToml?.mode).toBeUndefined();

  const mcpRegion = markerContent(
    findRegion(lowered.regions, "codex.mcp.prism-generated-codex-http-fixture"),
  );
  expect(mcpRegion).toContain('["mcp_servers"."prism-generated-codex-http-fixture"]');
  expect(mcpRegion).toContain('url = "http://127.0.0.1:38464/mcp"');
  expect(mcpRegion).toContain('bearer_token_env_var = "PRISM_MCP_CODEX_HTTP_TOKEN"');
  expect(mcpRegion).not.toContain('command = "bun"');
  expect(mcpRegion).not.toContain("args = ");
  expect(mcpRegion).not.toContain("http_headers");
  expect(mcpRegion).not.toContain("codex-static-token");
  expect(mcpRegion).toContain('enabled_tools = ["codex_http_fixture_echo"]');

  // No hooks: no hooks region and no features region.
  expect(findRegion(lowered.regions, "codex.hooks.codex-http-fixture")).toBeUndefined();
  expect(findRegion(lowered.regions, "codex.features.hooks")).toBeUndefined();

  // HTTP daemons consume the canonical PRISM_HOME bundle; nothing is
  // written into the harness root (or any shared runtime root) anymore.
  expect(findFile(lowered.files, "server.mjs")).toBeUndefined();
});

test("codex-cli lowerer emits prompt and permission request hook wrappers", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".codex");
  const pluginRoot = join(root, "codex-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "codex-hook-fixture",
        version: "0.1.0",
        targets: { hooks: ["codex-cli"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    join(pluginRoot, "hooks", "prompt-context.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "prompt-context",
  event: hookEvent.promptSubmit,
  handle: (event) => Effect.succeed({
    decision: "continue" as const,
    systemMessage: "system:" + event.target.harness,
    additionalContext: "prompt:" + event.prompt,
  }),
});
`,
  );
  await writeText(
    join(pluginRoot, "hooks", "permission-guard.hook.ts"),
    `import { Effect } from ${JSON.stringify(effectImportPath)};
import { defineHook, hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "permission-guard",
  event: hookEvent.permissionRequest,
  match: { tool: hookTool.any() },
  handle: (event) => Effect.succeed(
    event.tool?.input?.allow
      ? { decision: "allow" as const, systemMessage: "approved" }
      : { decision: "block" as const, message: "permission-blocked" },
  ),
});
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const lowered = await planLowering({
    agents: [],
    orbits: [],
    tools: [],
    skills: [],
    hooks: [...registry.hooks.values()],
    registry,
    target: {
      scope: "global",
      root: outputRoot,
      sourcePluginName: "codex-hook-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const hooksRegion = markerContent(findRegion(lowered.regions, "codex.hooks.codex-hook-fixture"));
  expect(hooksRegion).toContain('[["hooks"."UserPromptSubmit"]]');
  expect(hooksRegion).toContain('[["hooks"."PermissionRequest"]]');

  const promptWrapper = findFile(lowered.files, join("hooks", "prompt-context.mjs"));
  if (!promptWrapper) throw new Error("expected prompt-context wrapper");
  await writeText(promptWrapper.targetPath, promptWrapper.content);
  const promptResult = await runGeneratedHookWrapper(promptWrapper.targetPath, {
    prompt: "hello",
    cwd: pluginRoot,
  });
  expect(promptResult.exitCode).toBe(0);
  expect(JSON.parse(promptResult.stdout)).toMatchObject({
    systemMessage: "system:codex-cli",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "prompt:hello",
    },
  });

  const permissionWrapper = findFile(lowered.files, join("hooks", "permission-guard.mjs"));
  if (!permissionWrapper) throw new Error("expected permission-guard wrapper");
  await writeText(permissionWrapper.targetPath, permissionWrapper.content);
  const allowed = await runGeneratedHookWrapper(permissionWrapper.targetPath, {
    tool: { name: "Bash", input: { allow: true } },
    cwd: pluginRoot,
  });
  expect(allowed.exitCode).toBe(0);
  expect(JSON.parse(allowed.stdout)).toMatchObject({
    systemMessage: "approved",
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });

  const denied = await runGeneratedHookWrapper(permissionWrapper.targetPath, {
    tool: { name: "Bash", input: {} },
    cwd: pluginRoot,
  });
  expect(denied.exitCode).toBe(0);
  expect(JSON.parse(denied.stdout)).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "permission-blocked" },
    },
  });
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
