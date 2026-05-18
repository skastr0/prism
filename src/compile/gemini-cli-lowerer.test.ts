import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadPlugin } from "./load.js";
import { planLowering } from "./lowerers/gemini-cli.js";
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
  const root = await mkdtemp(join(tmpdir(), "prism-gemini-lowerer-"));
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

test("gemini-cli lowerer emits executable hook wrappers with Gemini output shape", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".gemini");
  const pluginRoot = join(root, "gemini-hook-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "gemini-hook-fixture",
        version: "0.1.0",
        targets: {
          toolspaces: ["gemini-cli"],
          hooks: ["gemini-cli"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "toolspaces", "workspace.toolspace.ts"),
    `import { defineToolspace } from ${JSON.stringify(prismImportPath)};

export default defineToolspace({
  name: "workspace",
  tools: { shell: { targets: { "gemini-cli": { name: "run_shell" } } } },
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
  handle: (event) => Effect.succeed(event.tool.input?.block || event.cwd !== ${JSON.stringify(pluginRoot)} || event.session?.id !== "session-1" ? { decision: "block" as const, message: "blocked" } : { decision: "continue" as const }),
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
  handle: (event) => Effect.succeed(event.tool.output?.ok && event.cwd === ${JSON.stringify(pluginRoot)} && event.session?.id === "session-2" ? { decision: "continue" as const } : { decision: "block" as const, message: "missing tool_response fallback" }),
});
`,
  );

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");
  const afterHook = registry.hooks.get("audit-shell-after");
  if (!hook) throw new Error("expected audit-shell hook");
  if (!afterHook) throw new Error("expected audit-shell-after hook");

  const operations = await planLowering({
    agents: [],
    orbits: [],
    tools: [],
    hooks: [hook, afterHook],
    registry,
    target: {
      scope: "project",
      root: outputRoot,
      sourcePluginName: "gemini-hook-fixture",
      sourcePluginVersion: "0.1.0",
      sourcePluginPath: pluginRoot,
    },
  });

  const hookConfig = findContentOperation(operations, join("hooks", "hooks.json"));
  expect(hookConfig?.content).toContain('"BeforeTool"');
  expect(hookConfig?.content).toContain('"AfterTool"');
  expect(hookConfig?.content).toContain('"matcher": "run_shell"');

  const hookWrapper = findContentOperation(operations, join("hooks", "audit-shell.mjs"));
  expect(hookWrapper?.content).toContain("native payload");
  expect(hookWrapper?.content).toContain("validation failed");
  expect(hookWrapper?.content).toContain("result");
  expect(hookWrapper?.content).toContain('harness: "gemini-cli"');
  expect(hookWrapper?.content).toContain("hookSpecificOutput");
  expect(hookWrapper?.content).not.toContain("transcriptPath");
  if (!hookWrapper) throw new Error("expected audit-shell wrapper");

  await writeText(hookWrapper.target, hookWrapper.content);
  const blocked = await runGeneratedHookWrapper(hookWrapper.target, {
    tool: { name: "run_shell", input: { block: true } },
    session: { id: "session-1" },
    workspace: { cwd: pluginRoot },
  });
  expect(blocked.exitCode).toBe(0);
  expect(blocked.stderr).toBe("");
  expect(JSON.parse(blocked.stdout.trim())).toEqual({
    decision: "deny",
    reason: "blocked",
    hookSpecificOutput: { hookEventName: "BeforeTool" },
  });

  const approved = await runGeneratedHookWrapper(hookWrapper.target, {
    tool: { name: "run_shell", input: {} },
    sessionId: "session-1",
    cwd: pluginRoot,
  });
  expect(approved.exitCode).toBe(0);
  expect(approved.stderr).toBe("");
  expect(JSON.parse(approved.stdout.trim())).toEqual({
    continue: true,
    decision: "approve",
    hookSpecificOutput: { hookEventName: "BeforeTool" },
  });

  const afterHookWrapper = findContentOperation(
    operations,
    join("hooks", "audit-shell-after.mjs"),
  );
  if (!afterHookWrapper) throw new Error("expected audit-shell-after wrapper");
  await writeText(afterHookWrapper.target, afterHookWrapper.content);
  const afterResult = await runGeneratedHookWrapper(afterHookWrapper.target, {
    tool: { name: "run_shell", input: {} },
    session_id: "session-2",
    tool_response: { ok: true },
    cwd: pluginRoot,
  });
  expect(afterResult.exitCode).toBe(0);
  expect(afterResult.stderr).toBe("");
  expect(JSON.parse(afterResult.stdout.trim())).toEqual({
    continue: true,
    decision: "allow",
    hookSpecificOutput: { hookEventName: "AfterTool" },
  });
});

test("gemini-cli lowerer fails closed for Streamable HTTP MCP opt-in", async () => {
  const root = await createTempRoot();
  const outputRoot = join(root, ".gemini");
  const pluginRoot = join(root, "gemini-http-fixture");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "gemini-http-fixture",
        version: "0.1.0",
        targets: {
          tools: ["gemini-cli"],
        },
        runtime: {
          mcp: {
            "gemini-cli": {
              transport: "streamable-http",
              host: "127.0.0.1",
              port: 38466,
              tokenEnv: "PRISM_MCP_GEMINI_HTTP_TOKEN",
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
      tools: [],
      hooks: [],
      registry,
      target: {
        scope: "project",
        root: outputRoot,
        sourcePluginName: "gemini-http-fixture",
        sourcePluginVersion: "0.1.0",
        sourcePluginPath: pluginRoot,
      },
    }),
  ).rejects.toThrow("Streamable HTTP MCP is not supported for target 'gemini-cli'");
});
