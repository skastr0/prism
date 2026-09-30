import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { exists } from "../fs.js";
import { compilePluginForTarget } from "./pipeline.js";
import { effectImportPath } from "../testing/prism-sandbox.js";
import { createOpenCodeV2TestHost } from "./opencode-v2-test-host.js";
import { commitSnapshot, readSnapshot } from "../state/store.js";
import { serializeRegionRef } from "../sync/plan.js";

const tempRoots: string[] = [];

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-native-plugin-load-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
};

interface NativePluginFixture {
  readonly pluginRoot: string;
  readonly projectRoot: string;
}

const PLUGIN_NAME = "native-plugin-load-fixture";
const GENERATED_PLUGIN_ID = `prism-generated-${PLUGIN_NAME}`;

const createNativePluginFixture = async (): Promise<NativePluginFixture> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });

  await writeJson(join(pluginRoot, "plugin.json"), {
    name: PLUGIN_NAME,
    version: "0.1.0",
    targets: {
      agents: ["opencode", "amp-code", "pi"],
      tools: ["opencode", "amp-code", "pi"],
      commands: ["amp-code", "pi"],
      hooks: ["amp-code", "pi"],
    },
  });

  await writeText(
    join(pluginRoot, "identities", "worker.identity.md"),
    `---
description: Worker identity
---

# Worker
`,
  );

  await writeText(
    join(pluginRoot, "agents", "worker.agent.ts"),
    `import type { AgentSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "worker",
  description: "Worker agent for native plugin load tests",
  identity: "worker",
} satisfies AgentSource;
`,
  );

  await writeText(
    join(pluginRoot, "tools", "greet.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import type { ToolSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "greet",
  description: "Greet someone",
  input: Schema.Struct({ name: Schema.String, nested: Schema.optional(Schema.Struct({ label: Schema.String })) }),
  output: Schema.Struct({ message: Schema.String, context: Schema.optional(Schema.Unknown) }),
  async handle(input, context) {
    if (input.name === "fail") throw new Error("handler failed");
    if (input.name === "context") return { message: "context", context: { ...context, signal: context.signal?.aborted } };
    return { message: "Hello, " + input.name };
  },
} satisfies ToolSource;
`,
  );

  await writeText(
    join(pluginRoot, "commands", "hello.md"),
    `---
name: hello
description: Say hello
---

Say hello to the user.
`,
  );

  await writeText(
    join(pluginRoot, "hooks", "on-start.hook.ts"),
    `import { hookEvent, type HookSource } from ${JSON.stringify(prismImportPath)};

export default {
  name: "on-start",
  description: "Run on session start",
  event: hookEvent.sessionStart,
  async handle() {
    return { decision: "continue" };
  },
} satisfies HookSource;
`,
  );

  return { pluginRoot, projectRoot };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("OpenCode native plugin is registered and loads", async () => {
  const { pluginRoot, projectRoot } = await createNativePluginFixture();
  const prismHome = join(dirname(pluginRoot), "prism-home");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.failures).toHaveLength(0);
  expect(result.blocked).toHaveLength(0);

  const opencodeJsonPath = join(projectRoot, ".opencode", "opencode.json");
  const config = JSON.parse(await readFile(opencodeJsonPath, "utf8"));
  const expectedEntry = pathToFileURL(
    join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID),
  ).href;

  expect(config.plugins).toContain(expectedEntry);
  expect(config.plugins.filter((entry: string) => entry === expectedEntry)).toHaveLength(1);

  const serverPath = Bun.resolveSync(
    join(fileURLToPath(config.plugins[0]), "server"),
    projectRoot,
  );
  expect(serverPath).toBe(join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID, "server.mjs"));
  const imported = (await import(
    `${pathToFileURL(serverPath).href}?test=${Date.now()}`
  )) as {
    readonly default?: { readonly id?: string; readonly setup?: unknown; readonly server?: unknown };
  };
  expect(imported.default).toBeDefined();
  expect(imported.default!.id).toBe(GENERATED_PLUGIN_ID);
  expect(imported.default!.server).toBeUndefined();
  expect(typeof imported.default!.setup).toBe("function");
  const host = createOpenCodeV2TestHost();
  await (imported.default!.setup as (ctx: unknown) => Promise<unknown>)(host.context);
  expect([...host.tools.keys()]).toEqual(["native_plugin_load_fixture_greet"]);
  host.replay();
  const tool = host.tools.get("native_plugin_load_fixture_greet")!;
  expect(tool.input).toMatchObject({ type: "object", additionalProperties: false, required: ["name"] });
  const execution = { sessionID: "session", agent: "active-agent", signal: new AbortController().signal };
  expect(await tool.execute({ name: "Ada" }, execution)).toEqual({ content: JSON.stringify({ message: "Hello, Ada" }, null, 2) });
  await expect(tool.execute({ name: 3 }, execution)).rejects.toThrow();
  await expect(tool.execute({ name: "Ada", typo: true }, execution)).rejects.toThrow();
  await expect(tool.execute({ name: "Ada", nested: { label: "x", lable: "typo" } }, execution)).rejects.toThrow();
  await expect(tool.execute({ name: "fail" }, execution)).rejects.toThrow("handler failed");
  const resultContext = JSON.parse((await tool.execute({ name: "context" }, execution)).content).context;
  expect(resultContext).toMatchObject({ sessionID: "session", agent: "active-agent", sessionTitle: "Live session", workingDirectory: "/worktree/src", repoRoot: "/worktree", signal: false, cost: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.02, currency: "USD" } });
  expect(Number.isFinite(Date.parse(resultContext.timestamp))).toBe(true);
  await expect(tool.execute({ name: "Ada" }, { ...execution, sessionID: "missing" })).rejects.toThrow("missing session");
}, 60000);

test("Amp Code native plugin is emitted and loads", async () => {
  const { pluginRoot, projectRoot } = await createNativePluginFixture();
  const prismHome = join(dirname(pluginRoot), "prism-home");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "amp-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.failures).toHaveLength(0);
  expect(result.blocked).toHaveLength(0);

  const pluginPath = join(
    projectRoot,
    ".amp",
    "plugins",
    `${GENERATED_PLUGIN_ID}.ts`,
  );
  expect(await exists(pluginPath)).toBe(true);

  const registeredTools: Array<{ name: string }> = [];
  const registeredCommands: string[] = [];
  const ampOnEvents: string[] = [];

  const imported = (await import(
    `${pathToFileURL(pluginPath).href}?test=${Date.now()}`
  )) as {
    readonly default: (amp: {
      registerTool(definition: { name: string }): void;
      registerCommand(id: string, options: unknown, handler: unknown): void;
      on(event: string, handler: unknown): void;
    }) => void;
  };

  imported.default({
    registerTool: (definition) => {
      registeredTools.push(definition);
    },
    registerCommand: (id) => {
      registeredCommands.push(id);
    },
    on: (event) => {
      ampOnEvents.push(event);
    },
  });

  expect(registeredTools.map((tool) => tool.name)).toContain(
    "native_plugin_load_fixture_greet",
  );
  expect(registeredCommands).toContain(`${GENERATED_PLUGIN_ID}-hello`);
  expect(ampOnEvents).toContain("session.start");
}, 60000);

test("Pi native extension is registered and loads", async () => {
  const { pluginRoot, projectRoot } = await createNativePluginFixture();
  const prismHome = join(dirname(pluginRoot), "prism-home");

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "pi",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );

  expect(result.failures).toHaveLength(0);
  expect(result.blocked).toHaveLength(0);

  const settingsPath = join(projectRoot, ".pi", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(settings.packages).toContain(`./packages/${GENERATED_PLUGIN_ID}`);

  const extensionPath = join(
    projectRoot,
    ".pi",
    "packages",
    GENERATED_PLUGIN_ID,
    "extensions",
    "prism-extension.js",
  );
  expect(await exists(extensionPath)).toBe(true);

  const registeredTools: Array<{ name: string }> = [];
  const piOnEvents: string[] = [];

  const imported = (await import(
    `${pathToFileURL(extensionPath).href}?test=${Date.now()}`
  )) as {
    readonly default: (pi: {
      registerTool(definition: { name: string }): void;
      on(event: string, handler: unknown): void;
    }) => void;
  };

  imported.default({
    registerTool: (definition) => {
      registeredTools.push(definition);
    },
    on: (event) => {
      piOnEvents.push(event);
    },
  });

  expect(registeredTools.map((tool) => tool.name)).toContain(
    "native_plugin_load_fixture_greet",
  );
  expect(piOnEvents).toContain("session_start");
}, 60000);

test("OpenCode plugin registration is idempotent and removable", async () => {
  const { pluginRoot, projectRoot } = await createNativePluginFixture();
  const prismHome = join(dirname(pluginRoot), "prism-home");

  const first = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(first.failures).toHaveLength(0);
  expect(first.converged).toBe(false);

  const opencodeJsonPath = join(projectRoot, ".opencode", "opencode.json");
  const expectedEntry = pathToFileURL(
    join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID),
  ).href;

  const configAfterFirst = JSON.parse(await readFile(opencodeJsonPath, "utf8"));
  expect(configAfterFirst.plugins).toContain(expectedEntry);

  const second = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(second.failures).toHaveLength(0);
  expect(second.converged).toBe(true);

  const manifestPath = join(pluginRoot, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    targets: Record<string, string[] | undefined>;
  };
  manifest.targets.agents = (manifest.targets.agents ?? []).filter((h) => h !== "opencode");
  manifest.targets.tools = (manifest.targets.tools ?? []).filter((h) => h !== "opencode");
  await writeJson(manifestPath, manifest);

  const third = await Effect.runPromise(
    compilePluginForTarget({
      prismHome,
      pluginPath: pluginRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }),
  );
  expect(third.failures).toHaveLength(0);

  const configAfterRemoval = JSON.parse(await readFile(opencodeJsonPath, "utf8"));
  expect(configAfterRemoval.plugins ?? []).not.toContain(expectedEntry);
  expect(await exists(join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID, "server.mjs"))).toBe(false);
}, 60000);

test.each(["plugin", "plugins"] as const)("OpenCode migrates previous owned %s membership without adopting neighbors", async (legacyKey) => {
  const { pluginRoot, projectRoot } = await createNativePluginFixture();
  const prismHome = join(dirname(pluginRoot), "prism-home");
  const root = join(projectRoot, ".opencode");
  const options = { prismHome, pluginPath: pluginRoot, target: "opencode" as const, scope: "project" as const, projectPath: projectRoot, dryRun: false };
  const first = await Effect.runPromise(compilePluginForTarget(options));
  expect(first.failures).toHaveLength(0);
  const configPath = join(root, "opencode.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const entry = config.plugins[0];
  const legacyBundlePath = join(root, "plugins", GENERATED_PLUGIN_ID, "dist", "server.mjs");
  const legacyEntry = pathToFileURL(legacyBundlePath).href;
  const bundlePath = join(root, "plugins", GENERATED_PLUGIN_ID, "server.mjs");
  await writeText(legacyBundlePath, await readFile(bundlePath, "utf8"));
  await rm(bundlePath);
  config.plugin = ["old-hand-authored", ...(legacyKey === "plugin" ? [legacyEntry] : [])];
  config.plugins = ["new-hand-authored", ...(legacyKey === "plugins" ? [legacyEntry] : [])];
  await writeJson(configPath, config);
  const previous = await readSnapshot({ prismHome, harness: "opencode", root });
  const oldRef = serializeRegionRef({ kind: "json-array-member", targetPath: configPath, regionKey: `${legacyKey}.${GENERATED_PLUGIN_ID}`, jsonPath: [legacyKey], value: legacyEntry, plugin: PLUGIN_NAME });
  await commitSnapshot({ prismHome, manifest: { ...previous.manifest, entries: previous.manifest.entries.map((owned) => owned.targetPath === configPath && owned.regionKey?.startsWith("json-array plugins.") ? { ...owned, regionKey: oldRef } : owned.targetPath === bundlePath ? { ...owned, targetPath: legacyBundlePath } : owned) } });
  const migrated = await Effect.runPromise(compilePluginForTarget(options));
  expect(migrated.failures).toHaveLength(0);
  expect(migrated.blocked).toHaveLength(0);
  const after = JSON.parse(await readFile(configPath, "utf8"));
  expect(after.plugin).toEqual(["old-hand-authored"]);
  expect(after.plugins).toEqual(["new-hand-authored", entry]);
  expect(await exists(legacyBundlePath)).toBe(false);
  expect(await exists(bundlePath)).toBe(true);
  const second = await Effect.runPromise(compilePluginForTarget(options));
  expect(second.failures).toHaveLength(0);
  expect(second.blocked).toHaveLength(0);
  expect(second.converged).toBe(true);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(after);
}, 60000);

test("OpenCode v2 hooks execute, block, propagate errors, and clean up subscriptions", async () => {
  const { pluginRoot, projectRoot } = await createNativePluginFixture();
  const prismHome = join(dirname(pluginRoot), "prism-home");
  const manifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
  manifest.targets.hooks.push("opencode");
  await writeJson(join(pluginRoot, "plugin.json"), manifest);
  const sinkKey = `prism-v2-${pluginRoot}`;
  const observed: any[] = [];
  (globalThis as any)[sinkKey] = observed;
  const imports = `import { Effect } from ${JSON.stringify(effectImportPath)};
import { hookEvent, hookTool } from ${JSON.stringify(prismImportPath)};`;
  for (const [name, event, match, body] of [
    ["on-start", "sessionStart", "", `return Effect.sync(() => { globalThis[${JSON.stringify(sinkKey)}].push(event); return { decision: "continue" }; });`],
    ["on-end", "sessionEnd", "", `globalThis[${JSON.stringify(sinkKey)}].push(event); return { decision: "continue" };`],
    ["before", "toolBefore", 'match: { tool: hookTool.native("bash") },', `if (event.tool.input?.fail) throw new Error("hook failed"); if (event.tool.input?.invalid) return { decision: "garbage" }; return event.tool.input?.block ? { decision: "block", message: "blocked by hook" } : { decision: "continue" };`],
    ["canonical", "toolBefore", 'match: { tool: hookTool.canonical("greet") },', `throw new Error("canonical matcher fired");`],
    ["after", "toolAfter", 'match: { tool: hookTool.native("bash") },', `globalThis[${JSON.stringify(sinkKey)}].push(event); if (event.tool.input?.fail) throw new Error("after failed"); return { decision: "continue" };`],
    ["prompt", "promptSubmit", "", 'return { decision: "continue", systemMessage: "policy", additionalContext: "context:" + event.prompt };'],
    ["permission", "permissionRequest", 'match: { tool: hookTool.any() },', 'if (event.tool.input.metadata?.fail) throw new Error("permission failed"); return event.tool.input.metadata?.block ? { decision: "block", message: "denied by policy" } : { decision: "continue" };'],
  ]) {
    await writeText(join(pluginRoot, "hooks", `${name}.hook.ts`), `${imports}\nexport default { name: ${JSON.stringify(name)}, event: hookEvent.${event}, ${match} handle(event) { ${body} } };\n`);
  }
  try {
    const compiled = await Effect.runPromise(compilePluginForTarget({ prismHome, pluginPath: pluginRoot, target: "opencode", scope: "project", projectPath: projectRoot, dryRun: false }));
    expect(compiled.failures).toHaveLength(0);
    const bundlePath = join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID, "server.mjs");
    const plugin = (await import(pathToFileURL(bundlePath).href)).default;
    const host = createOpenCodeV2TestHost();
    const cleanup = await plugin.setup(host.context);
    expect([...host.hooks.keys()].sort()).toEqual(["permission.evaluate", "session.prompt", "tool.execute.after", "tool.execute.before"]);
    const before = host.hooks.get("tool.execute.before")!;
    const event = { sessionID: "session", agent: "active", tool: "bash", input: { block: true } };
    await expect(before(event)).rejects.toThrow("blocked by hook");
    await expect(before({ ...event, input: { fail: true } })).rejects.toThrow("hook failed");
    await expect(before({ ...event, input: { invalid: true } })).rejects.toThrow("validation failed");
    await before({ ...event, tool: "read" });
    await expect(before({ ...event, tool: "native_plugin_load_fixture_greet" })).rejects.toThrow("canonical matcher fired");
    const after = host.hooks.get("tool.execute.after")!;
    const failed = { ...event, input: {}, status: "error", error: { message: "original failure" } };
    await after(failed);
    expect(failed).toMatchObject({ status: "error", error: { message: "original failure" } });
    expect(observed.at(-1)).toMatchObject({ cwd: "/worktree/src", tool: { success: false, output: { message: "original failure" } }, native: failed });
    await after({ ...event, input: {}, status: "completed", result: { content: "ok" } });
    expect(observed.at(-1).tool.success).toBe(true);
    await expect(after({ ...failed, input: { fail: true } })).rejects.toThrow("after failed");
    const prompt = { sessionID: "session", messageID: "message", prompt: { text: "original", files: [{ uri: "file:///keep" }] }, metadata: { user: true }, delivery: "steer" };
    await host.hooks.get("session.prompt")!(prompt);
    expect(prompt.prompt.text).toBe("original\n\npolicy\n\ncontext:original");
    expect(prompt.prompt.files).toEqual([{ uri: "file:///keep" }]);
    expect(prompt.metadata).toEqual({ user: true });
    const permission = { sessionID: "session", action: "bash", resources: ["*"], effect: "ask", metadata: { block: true } };
    await host.hooks.get("permission.evaluate")!(permission);
    expect(permission).toMatchObject({ effect: "deny", message: "denied by policy" });
    await expect(host.hooks.get("permission.evaluate")!({ ...permission, metadata: { fail: true } })).rejects.toThrow("permission failed");
    host.emit({ type: "session.status", location: { directory: "/event-location" }, data: { sessionID: "session", status: { type: "busy" } } });
    host.emit({ type: "session.status", data: { sessionID: "session", status: { type: "idle" } } });
    host.emit({ type: "session.idle", data: { sessionID: "session" } });
    for (let i = 0; i < 100 && !observed.some((receipt) => receipt.event === "session.end"); i++) await Bun.sleep(1);
    expect(observed.filter((receipt) => receipt.event === "session.start")).toHaveLength(1);
    expect(observed.find((receipt) => receipt.event === "session.start").cwd).toBe("/event-location");
    expect(observed.filter((receipt) => receipt.event === "session.end")).toHaveLength(1);
    expect(host.subscriptionSignal?.aborted).toBe(false);
    await cleanup();
    expect(host.subscriptionSignal?.aborted).toBe(true);
    expect(host.closed).toBe(true);
    const count = observed.length;
    host.emit({ type: "session.idle", data: { sessionID: "session" } });
    await Bun.sleep(1);
    expect(observed).toHaveLength(count);

    // Observer hook failures are not converted to successful strings or swallowed.
    const child = Bun.spawn([process.execPath, "--eval", `const plugin = (await import(${JSON.stringify(pathToFileURL(bundlePath).href)})).default; globalThis[${JSON.stringify(sinkKey)}] = { push() { throw new Error("observer failed"); } }; await plugin.setup({ tool: { transform: async () => {}, hook: async () => {} }, permission: { hook: async () => {} }, session: { hook: async () => {}, get: async () => ({ location: { directory: "/event" } }) }, event: { async *subscribe() { yield { type: "session.idle", data: { sessionID: "session" } }; } } }); await Bun.sleep(20);`], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("observer failed");
  } finally {
    delete (globalThis as any)[sinkKey];
  }
}, 60000);
