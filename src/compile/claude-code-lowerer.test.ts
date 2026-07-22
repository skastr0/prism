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

