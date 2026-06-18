import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { exists } from "../fs.js";
import { compilePluginForTarget } from "./pipeline.js";

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
    `import { bindTrait, defineAgent } from ${JSON.stringify(prismImportPath)};

export default defineAgent({
  name: "worker",
  description: "Worker agent for native plugin load tests",
  identity: "worker",
  traits: [bindTrait("actionable")],
});
`,
  );

  await writeText(
    join(pluginRoot, "traits", "actionable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(prismImportPath)};

export default defineTrait({
  name: "actionable",
  description: "Can perform actions",
  instructions: "Use the greet tool when appropriate.",
  tools: {
    greet: { ref: "greet" },
  },
  require: {
    tools: ["greet"],
  },
});
`,
  );

  await writeText(
    join(pluginRoot, "tools", "greet.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "greet",
  description: "Greet someone",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  async handle(input) {
    return { message: "Hello, " + input.name };
  },
});
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
    `import { defineHook, hookEvent } from ${JSON.stringify(prismImportPath)};

export default defineHook({
  name: "on-start",
  description: "Run on session start",
  event: hookEvent.sessionStart,
  async handle() {
    return { decision: "continue" };
  },
});
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
    join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID, "dist", "server.mjs"),
  ).href;

  expect(config.plugin).toContain(expectedEntry);
  expect(config.plugin.filter((entry: string) => entry === expectedEntry)).toHaveLength(1);

  const serverPath = join(
    projectRoot,
    ".opencode",
    "plugins",
    GENERATED_PLUGIN_ID,
    "dist",
    "server.mjs",
  );
  const imported = (await import(
    `${pathToFileURL(serverPath).href}?test=${Date.now()}`
  )) as {
    readonly default?: { readonly id?: string; readonly server?: unknown };
  };
  expect(imported.default).toBeDefined();
  expect(imported.default!.id).toBe(GENERATED_PLUGIN_ID);
  expect(typeof imported.default!.server).toBe("function");

  const serverResult = await (imported.default!.server as (ctx: unknown) => Promise<unknown>)({
    directory: projectRoot,
    worktree: projectRoot,
  });
  expect(serverResult).toMatchObject({
    tool: {
      native_plugin_load_fixture_greet: expect.any(Object),
    },
  });
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
    join(projectRoot, ".opencode", "plugins", GENERATED_PLUGIN_ID, "dist", "server.mjs"),
  ).href;

  const configAfterFirst = JSON.parse(await readFile(opencodeJsonPath, "utf8"));
  expect(configAfterFirst.plugin).toContain(expectedEntry);

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
  expect(configAfterRemoval.plugin ?? []).not.toContain(expectedEntry);
}, 60000);
