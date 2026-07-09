import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";
import { GENERATED_HOOK_RUNTIME } from "./hook-runtime-bundle.js";
import { loadPlugin } from "./load.js";
import { resolveHookMatchForTarget } from "./hooks.js";
import {
  NativePermissionRequestHookPayloadSchema,
  NativePromptSubmitHookPayloadSchema,
  NativeToolAfterHookPayloadSchema,
  NativeToolBeforeHookPayloadSchema,
  NativeSessionEndHookPayloadSchema,
  decodeHookResultForEvent,
  decodeNativeHookPayloadForEvent,
} from "./sources.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-hooks-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createHookFixture = async (): Promise<string> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hook-fixture",
        version: "0.1.0",
        targets: {
          hooks: ["opencode"],
          toolspaces: ["opencode"],
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "toolspaces", "core.toolspace.ts"),
    `import { defineToolspace, toolRef } from "prism";

export default defineToolspace({
  name: "core",
  tools: {
    shell: {
      targets: {
        opencode: { name: "bash" },
        "claude-code": { name: "Bash" },
      },
    },
    read: {
      targets: {
        opencode: { name: "read" },
      },
    },
  },
  groups: {
    readonly_shell: {
      tools: [toolRef("core", "shell"), toolRef("core", "read")],
    },
  },
});
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "audit-shell.hook.ts"),
    `import { Effect } from "effect";
import { defineHook, hookEvent, hookTool, toolGroupRef } from "prism";

export default defineHook({
  name: "audit-shell",
  description: "Audit shell-adjacent tool calls",
  event: hookEvent.toolBefore,
  match: {
    tool: hookTool.group(toolGroupRef("core", "readonly_shell")),
  },
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`,
  );

  return pluginRoot;
};

test("hooks/*.hook.ts load through defineHook and normalize toolspace matchers", async () => {
  const pluginRoot = await createHookFixture();

  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");

  expect(hook).toBeDefined();
  expect(hook?.event).toBe("tool.before");
  expect(hook?.match.tool).toEqual({
    kind: "toolspace-group",
    ref: "core#readonly_shell",
  });
});

test("hook toolspace matchers resolve to target-native tool names", async () => {
  const pluginRoot = await createHookFixture();
  const registry = await Effect.runPromise(loadPlugin(pluginRoot));
  const hook = registry.hooks.get("audit-shell");
  if (!hook) throw new Error("expected hook");

  const resolved = await Effect.runPromise(resolveHookMatchForTarget(hook, registry, "opencode"));

  expect(resolved.tool).toEqual({
    kind: "native-tools",
    names: ["bash", "read"],
  });
});

test("native hook payload schemas normalize target payloads into prism events", () => {
  const decoded = Schema.decodeUnknownSync(NativeToolBeforeHookPayloadSchema)({
    target: { harness: "opencode", nativeEvent: "tool.execute.before" },
    tool: { logical: "shell", name: "bash", input: { command: "pwd" } },
    cwd: "/repo",
    session: { id: "session-1" },
    native: { artifactDirectoryPath: "/repo/.artifacts" },
  });

  expect(decoded).toEqual({
    event: "tool.before",
    target: { harness: "opencode", nativeEvent: "tool.execute.before" },
    tool: { logical: "shell", nativeName: "bash", input: { command: "pwd" } },
    cwd: "/repo",
    session: { id: "session-1" },
    native: { artifactDirectoryPath: "/repo/.artifacts" },
  });
});

test("native hook payload decoding is event-specific", () => {
  const decoded = Schema.decodeUnknownSync(NativeToolAfterHookPayloadSchema)({
    target: { harness: "opencode", nativeEvent: "tool.execute.after" },
    tool: {
      name: "bash",
      input: { command: "pwd" },
      output: "ok",
      success: true,
    },
    session: { id: "session-1" },
  });

  expect(decoded).toEqual({
    event: "tool.after",
    target: { harness: "opencode", nativeEvent: "tool.execute.after" },
    tool: {
      nativeName: "bash",
      input: { command: "pwd" },
      output: "ok",
      success: true,
    },
    session: { id: "session-1" },
  });

  expect(
    decodeNativeHookPayloadForEvent("tool.after", {
      target: { harness: "opencode", nativeEvent: "tool.execute.after" },
      tool: { name: "bash", input: {}, output: "ok" },
    })._tag,
  ).toBe("Right");

  const sessionEnd = Schema.decodeUnknownSync(NativeSessionEndHookPayloadSchema)({
    target: { harness: "antigravity-cli", nativeEvent: "Stop" },
    session: { id: "session-1" },
    reason: "model_stop",
    native: { executionNum: 7, fullyIdle: true, error: "none" },
  });
  expect(sessionEnd.native).toEqual({ executionNum: 7, fullyIdle: true, error: "none" });
});

test("native hook payload schemas normalize prompt and permission events", () => {
  const prompt = Schema.decodeUnknownSync(NativePromptSubmitHookPayloadSchema)({
    target: { harness: "codex-cli", nativeEvent: "UserPromptSubmit" },
    prompt: "summarize this diff",
    cwd: "/repo",
    session: { id: "session-1" },
  });

  expect(prompt).toEqual({
    event: "prompt.submit",
    target: { harness: "codex-cli", nativeEvent: "UserPromptSubmit" },
    prompt: "summarize this diff",
    cwd: "/repo",
    session: { id: "session-1" },
  });

  const permission = Schema.decodeUnknownSync(NativePermissionRequestHookPayloadSchema)({
    target: { harness: "codex-cli", nativeEvent: "PermissionRequest" },
    tool: { logical: "shell", name: "bash", input: { command: "git status" } },
    native: { approval_policy: "on-request" },
  });

  expect(permission).toEqual({
    event: "permission.request",
    target: { harness: "codex-cli", nativeEvent: "PermissionRequest" },
    tool: { logical: "shell", nativeName: "bash", input: { command: "git status" } },
    native: { approval_policy: "on-request" },
  });

  expect(
    decodeNativeHookPayloadForEvent("prompt.submit", {
      target: { harness: "codex-cli", nativeEvent: "UserPromptSubmit" },
      prompt: "hello",
    })._tag,
  ).toBe("Right");

  expect(
    decodeNativeHookPayloadForEvent("permission.request", {
      target: { harness: "codex-cli", nativeEvent: "PermissionRequest" },
      tool: { name: "bash", input: {} },
    })._tag,
  ).toBe("Right");
});

test("hook result validation is event-specific and conservative", () => {
  expect(decodeHookResultForEvent("tool.before", { decision: "block", message: "No" })._tag)
    .toBe("Right");
  expect(decodeHookResultForEvent("tool.after", { decision: "block", message: "No" })._tag)
    .toBe("Left");
  expect(decodeHookResultForEvent("permission.request", { decision: "block", message: "No" })._tag)
    .toBe("Right");
  expect(decodeHookResultForEvent("permission.request", { decision: "allow" })._tag)
    .toBe("Right");
  expect(decodeHookResultForEvent("prompt.submit", { decision: "block", message: "No" })._tag)
    .toBe("Right");
  expect(decodeHookResultForEvent("tool.before", { decision: "allow" })._tag)
    .toBe("Left");
  expect(
    decodeHookResultForEvent("prompt.submit", {
      decision: "continue",
      systemMessage: "system",
      additionalContext: "context",
    })._tag,
  ).toBe("Right");
  expect(decodeHookResultForEvent("session.end", { decision: "continue" })._tag)
    .toBe("Right");
});

test("generated hook runtime decodes prompt and permission event contracts", async () => {
  const root = await createTempRoot();
  const runtimePath = join(root, "hook-runtime.mjs");
  await writeText(runtimePath, GENERATED_HOOK_RUNTIME);
  const runtime = await import(pathToFileURL(runtimePath).href) as {
    decodeNativeHookPayloadForEvent: (event: string, payload: unknown) => { _tag: string };
    decodeHookResultForEvent: (event: string, result: unknown) => { _tag: string; right?: unknown };
  };

  expect(
    runtime.decodeNativeHookPayloadForEvent("prompt.submit", {
      target: { harness: "codex-cli", nativeEvent: "UserPromptSubmit" },
      prompt: "hello",
    })._tag,
  ).toBe("Right");
  expect(
    runtime.decodeNativeHookPayloadForEvent("permission.request", {
      target: { harness: "codex-cli", nativeEvent: "PermissionRequest" },
      tool: { name: "bash", input: { command: "pwd" } },
    })._tag,
  ).toBe("Right");
  expect(
    runtime.decodeHookResultForEvent("permission.request", {
      decision: "block",
      message: "No",
    })._tag,
  ).toBe("Right");
  expect(
    runtime.decodeHookResultForEvent("permission.request", {
      decision: "allow",
    }).right,
  ).toEqual({
    decision: "allow",
    systemMessage: undefined,
  });
  expect(
    runtime.decodeHookResultForEvent("prompt.submit", {
      decision: "continue",
      additionalContext: "context",
    }).right,
  ).toEqual({
    decision: "continue",
    systemMessage: undefined,
    additionalContext: "context",
  });
});

test("hook V1 fails closed for agent-bound authoring attempts", async () => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "invalid-hook", version: "0.1.0", targets: { hooks: ["opencode"] } }, null, 2)}\n`,
  );
  await writeText(
    join(pluginRoot, "hooks", "agent-bound.hook.ts"),
    `import { Effect } from "effect";
import { defineHook, hookEvent } from "prism";

export default defineHook({
  name: "agent-bound",
  event: hookEvent.sessionStart,
  agents: ["builder"],
  handle: (_event) => Effect.succeed({ decision: "continue" as const }),
});
`,
  );

  const exit = await Effect.runPromiseExit(loadPlugin(pluginRoot));
  expect(exit._tag).toBe("Failure");
});
