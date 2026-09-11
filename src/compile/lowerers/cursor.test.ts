import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ComposedAgent } from "../compose.js";
import { Hook } from "../sources.js";
import { cursorNativeHookEvent, planLowering } from "./cursor.js";

const agent = (name: string): ComposedAgent => ({
  name,
  description: `${name} reviewer`,
  body: `You are ${name}.`,
  color: undefined,
  model: { model: "composer-2.5-fast" },
  targetOverride: {},
  skills: [],
});

const writeSessionHook = async (): Promise<Hook> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-cursor-hook-src-"));
  const sourcePath = join(dir, "session-start.hook.ts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    sourcePath,
    `import { Effect } from "effect";
export default {
  name: "session-start",
  event: "session.start",
  handle: () => Effect.succeed({ decision: "continue" }),
};
`,
  );
  return new Hook({
    name: "session-start",
    sourcePath,
    event: "session.start",
    targets: [],
    match: {},
    handle: () => Effect.succeed({ decision: "continue" as const }),
  });
};

test("cursor native hook events use plugin camelCase names", () => {
  expect(cursorNativeHookEvent("tool.before")).toBe("preToolUse");
  expect(cursorNativeHookEvent("session.start")).toBe("sessionStart");
  expect(cursorNativeHookEvent("prompt.submit")).toBe("beforeSubmitPrompt");
});

test("Cursor lowerer emits plugin subagents and command hooks", async () => {
  const root = "/tmp/cursor-root";
  const output = await planLowering({
    agents: [agent("reviewer")],
    orbits: [],
    sops: [],
    hooks: [await writeSessionHook()],
    target: {
      scope: "global",
      root,
      sourcePluginName: "demo",
      sourcePluginVersion: "1.2.3",
    },
  });

  const pluginRoot = join(root, "plugins", "local", "prism-generated-demo");
  const paths = output.files.map((file) => file.targetPath).sort();
  expect(paths).toContain(join(pluginRoot, ".cursor-plugin", "plugin.json"));
  expect(paths).toContain(join(pluginRoot, "agents", "reviewer.md"));
  expect(paths).toContain(join(pluginRoot, "hooks", "hooks.json"));
  expect(paths).toContain(join(pluginRoot, "hooks", "session-start.mjs"));

  const manifest = output.files.find((file) => file.targetPath.endsWith("plugin.json"))?.content ?? "";
  expect(manifest).toContain("\"agents\": \"agents/\"");
  expect(manifest).toContain("\"commands\": \"commands/\"");

  const agentMd = output.files.find((file) => file.targetPath.endsWith("reviewer.md"))?.content ?? "";
  expect(agentMd).toContain("name: \"reviewer\"");
  expect(agentMd).toContain("model: \"composer-2.5-fast\"");
  expect(agentMd).toContain("You are reviewer.");

  const hooksJson = JSON.parse(
    output.files.find((file) => file.targetPath.endsWith("hooks.json"))?.content ?? "{}",
  ) as { hooks?: Record<string, Array<{ command?: string }>> };
  expect(hooksJson.hooks?.sessionStart?.[0]?.command).toContain("session-start.mjs");
  expect(hooksJson.hooks?.sessionStart?.[0]).not.toHaveProperty("hooks");
});

const writeToolBeforeHook = async (): Promise<Hook> => {
  const dir = await mkdtemp(join(tmpdir(), "prism-cursor-hook-src-"));
  const sourcePath = join(dir, "audit-read.hook.ts");
  await writeFile(
    sourcePath,
    `import { Effect } from "effect";
export default {
  name: "audit-read",
  event: "tool.before",
  handle: () => Effect.succeed({ decision: "block", message: "nope" }),
};
`,
  );
  return new Hook({
    name: "audit-read",
    sourcePath,
    event: "tool.before",
    targets: [],
    match: {},
    handle: () => Effect.succeed({ decision: "block" as const, message: "nope" }),
  });
};

test("Cursor tool.before wrapper emits permission deny and exit 2", async () => {
  const output = await planLowering({
    agents: [agent("reviewer")],
    orbits: [],
    sops: [],
    hooks: [await writeToolBeforeHook()],
    target: {
      scope: "global",
      root: "/tmp/cursor-block",
      sourcePluginName: "demo",
    },
  });
  const wrapper = output.files.find((file) => file.targetPath.endsWith("audit-read.mjs"))?.content ?? "";
  expect(wrapper).toContain("permission");
  expect(wrapper).toContain("deny");
  expect(wrapper).toContain("user_message");
  expect(wrapper).toContain("process.exit(2)");
});

test("tools-only Cursor compile plants no plugin bundle", async () => {
  const output = await planLowering({
    agents: [],
    orbits: [],
    sops: [],
    tools: [],
    target: {
      scope: "global",
      root: "/tmp/cursor-tools",
      sourcePluginName: "tools-only",
    },
  });
  expect(output.files).toEqual([]);
});
