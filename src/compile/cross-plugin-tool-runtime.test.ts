import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Layer, Option } from "effect";
import { compilePluginForTarget } from "./pipeline.js";
import { resolveOwnerMcpRuntime } from "./mcp-runtime.js";
import { loadPlugin } from "./load.js";
import { prismMcpServerPath } from "./mcp-runtime-path.js";
import { generatedOwnerToolName } from "./generated-plugin.js";
import { getFreePort, roundTripCompiledBundle } from "./test-helpers/mcp-http-roundtrip.js";
import { createPrismSandbox } from "../testing/prism-sandbox.js";
import { cleanupPrismMcpProcessesUnder } from "../testing/mcp-process-cleanup.js";
import { PrismHomeTest, HarnessRootsTest } from "../services/prism-env.js";
import type { CompileError } from "./errors.js";

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
};

interface OwnerFixtureOptions {
  readonly name?: string;
  readonly targets?: { readonly tools: string[] };
  readonly runtime?: { readonly mcp?: Record<string, { readonly port?: number; readonly host?: string }> };
}

const createOwnerPlugin = async (
  root: string,
  options: OwnerFixtureOptions = {},
): Promise<string> => {
  const name = options.name ?? "owner-tools";
  const pluginRoot = join(root, name);
  const manifest: Record<string, unknown> = {
    name,
    version: "0.1.0",
    targets: options.targets ?? { tools: ["opencode"] },
  };
  if (options.runtime) {
    manifest.runtime = options.runtime;
  }
  await writeJson(join(pluginRoot, "plugin.json"), manifest);
  await writeText(
    join(pluginRoot, "tools", "acknowledge.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "acknowledge",
  description: "Acknowledge a request",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle() {
    return { acknowledged: true };
  },
};
`,
  );
  return pluginRoot;
};

interface ConsumerFixtureOptions {
  readonly name?: string;
  readonly ownerName?: string;
  readonly ownerPath?: string;
  readonly withOrbitBind?: boolean;
}

const createConsumerPlugin = async (
  root: string,
  options: ConsumerFixtureOptions = {},
): Promise<string> => {
  const name = options.name ?? "consumer";
  const ownerName = options.ownerName ?? "owner-tools";
  const ownerPath = options.ownerPath ?? `../${ownerName}`;
  const pluginRoot = join(root, name);

  await writeJson(join(pluginRoot, "plugin.json"), {
    name,
    version: "0.1.0",
    deps: { [ownerName]: ownerPath },
    targets: { agents: ["opencode"] },
  });

  await writeText(
    join(pluginRoot, "identities", "consumer.identity.md"),
    `---
description: Consumer
---

# Consumer
`,
  );

  await writeText(
    join(pluginRoot, "traits", "ack-capable.trait.ts"),
    `
export default {
  name: "ack-capable",
  description: "Can acknowledge via owner tool",
  tools: { acknowledge: { ref: ${JSON.stringify(`${ownerName}:acknowledge`)} } },
};
`,
  );

  await writeText(
    join(pluginRoot, "agents", "consumer.agent.ts"),
    `import { bindTrait } from ${JSON.stringify(prismImportPath)};

export default {
  name: "consumer",
  description: "Consumer agent",
  identity: "consumer",
  traits: [bindTrait("ack-capable")],
};
`,
  );

  if (options.withOrbitBind) {
    await writeText(
      join(pluginRoot, "orbits", "use-ack.orbit.ts"),
      `import { agentRef } from ${JSON.stringify(prismImportPath)};

export default {
  name: "use-ack",
  description: "Use ack with bind",
  phases: [{ name: "Run", agents: [agentRef("consumer")] }],
  tool_permissions: [
    // @ts-expect-error bind is not supported by the orbit schema yet
    { ref: ${JSON.stringify(`${ownerName}:acknowledge`)}, as: "acknowledge", bind: { board: "default" } },
  ],
};
`,
    );
  }

  return pluginRoot;
};

const tempRoots: string[] = [];

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "cross-plugin-tool-runtime-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => cleanupPrismMcpProcessesUnder(root).catch(() => undefined)));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const testLayers = (sandbox: Awaited<ReturnType<typeof createPrismSandbox>>) =>
  Layer.merge(
    PrismHomeTest(sandbox.prismHome),
    HarnessRootsTest({ opencode: sandbox.rootFor("opencode") }),
  );

test("owner-targeting gate succeeds when owner targets the consumer harness", async () => {
  const sandbox = await createPrismSandbox();
  const projectRoot = join(sandbox.root, "project");
  await mkdir(projectRoot, { recursive: true });
  const ownerRoot = await createOwnerPlugin(sandbox.root, { targets: { tools: ["opencode"] } });
  const consumerRoot = await createConsumerPlugin(sandbox.root, {
    ownerPath: ownerRoot,
  });

  const result = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: sandbox.prismHome,
      pluginPath: consumerRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }).pipe(Effect.provide(testLayers(sandbox))),
  );

  expect(result.failures).toHaveLength(0);
  const consumer = result.composed.find((agent) => agent.name === "consumer");
  expect(consumer?.toolBindings.some((binding) => binding.logicalName === "acknowledge")).toBe(true);
});

test("owner-targeting gate fails when owner does not target the consumer harness", async () => {
  const sandbox = await createPrismSandbox();
  const projectRoot = join(sandbox.root, "project");
  await mkdir(projectRoot, { recursive: true });
  const ownerRoot = await createOwnerPlugin(sandbox.root, { targets: { tools: ["claude-code"] } });
  const consumerRoot = await createConsumerPlugin(sandbox.root, {
    ownerPath: ownerRoot,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: sandbox.prismHome,
      pluginPath: consumerRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }).pipe(Effect.provide(testLayers(sandbox))),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) return;
  const error = failure.value as CompileError;
  expect(error._tag).toBe("AgentValidationError");
  expect(error.message).toContain("targets.tools");
  expect(error.message).toContain("opencode");
  expect(error.message).toContain("owner-tools");
});

test("resolveOwnerMcpRuntime prefers running daemon runtime.json", async () => {
  const sandbox = await createPrismSandbox();
  const ownerRoot = await createOwnerPlugin(sandbox.root, {
    runtime: { mcp: { "claude-code": { port: 11111, host: "127.0.0.1" } } },
  });
  const consumerRoot = await createConsumerPlugin(sandbox.root, { ownerPath: ownerRoot });
  const registry = await Effect.runPromise(loadPlugin(consumerRoot));

  const runtimeDir = join(sandbox.prismHome, "runtime", "mcp", "owner-tools");
  await mkdir(runtimeDir, { recursive: true });
  await writeJson(join(runtimeDir, "runtime.json"), {
    schema: "prism.mcp-runtime.v1",
    serverName: "prism-generated-owner-tools",
    transport: "streamable-http",
    host: "127.0.0.1",
    port: 22222,
  });

  const resolved = await resolveOwnerMcpRuntime({
    prismHome: sandbox.prismHome,
    registry,
    targetId: "claude-code",
    ownerPluginName: "owner-tools",
  });

  expect(resolved).toBeDefined();
  expect(resolved?.port).toBe(22222);
  expect(resolved?.host).toBe("127.0.0.1");
  await sandbox.cleanup();
});

test("resolveOwnerMcpRuntime falls back to static plugin.json runtime config", async () => {
  const sandbox = await createPrismSandbox();
  const ownerRoot = await createOwnerPlugin(sandbox.root, {
    runtime: { mcp: { "claude-code": { port: 33333, host: "127.0.0.1" } } },
  });
  const consumerRoot = await createConsumerPlugin(sandbox.root, { ownerPath: ownerRoot });
  const registry = await Effect.runPromise(loadPlugin(consumerRoot));

  const resolved = await resolveOwnerMcpRuntime({
    prismHome: sandbox.prismHome,
    registry,
    targetId: "claude-code",
    ownerPluginName: "owner-tools",
  });

  expect(resolved).toBeDefined();
  expect(resolved?.port).toBe(33333);
  expect(resolved?.host).toBe("127.0.0.1");
  await sandbox.cleanup();
});

test("cross-plugin canonical tool call round-trip", async () => {
  const sandbox = await createPrismSandbox();
  const projectRoot = join(sandbox.root, "project");
  await mkdir(projectRoot, { recursive: true });

  // Owner targets both the consumer harness (opencode) and a generated-MCP
  // harness (claude-code) so the canonical MCP bundle is actually built.
  const ownerRoot = await createOwnerPlugin(sandbox.root, {
    targets: { tools: ["opencode", "claude-code"] },
  });
  const consumerRoot = await createConsumerPlugin(sandbox.root, { ownerPath: ownerRoot });

  // Compile the owner plugin for claude-code so its canonical MCP bundle is written.
  // Serve mode starts the daemon so the lifecycle gate is satisfied.
  const ownerResult = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: sandbox.prismHome,
      pluginPath: ownerRoot,
      target: "claude-code",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }).pipe(Effect.provide(testLayers(sandbox))),
  );
  expect(ownerResult.failures).toHaveLength(0);

  // Compile the consumer plugin for opencode to validate cross-plugin binding resolution.
  const consumerResult = await Effect.runPromise(
    compilePluginForTarget({
      prismHome: sandbox.prismHome,
      pluginPath: consumerRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }).pipe(Effect.provide(testLayers(sandbox))),
  );
  expect(consumerResult.failures).toHaveLength(0);

  const serverPath = prismMcpServerPath(sandbox.prismHome, "owner-tools");
  const port = await getFreePort();
  const scopedToolName = generatedOwnerToolName("owner-tools", "acknowledge");

  try {
    const roundTrip = await roundTripCompiledBundle({
      serverPath,
      port,
      toolName: scopedToolName,
      toolArgs: { summary: "hello from consumer" },
    });

    expect(roundTrip.toolNames).toContain(scopedToolName);
    expect(roundTrip.callResult.structuredContent).toEqual({ acknowledged: true });
  } finally {
    await sandbox.cleanup();
  }
}, 30_000);

test("orbit tool_permissions reject unsupported bind field", async () => {
  const sandbox = await createPrismSandbox();
  const projectRoot = join(sandbox.root, "project");
  await mkdir(projectRoot, { recursive: true });
  const ownerRoot = await createOwnerPlugin(sandbox.root, { targets: { tools: ["opencode"] } });
  const consumerRoot = await createConsumerPlugin(sandbox.root, {
    ownerPath: ownerRoot,
    withOrbitBind: true,
  });

  const exit = await Effect.runPromiseExit(
    compilePluginForTarget({
      prismHome: sandbox.prismHome,
      pluginPath: consumerRoot,
      target: "opencode",
      scope: "project",
      projectPath: projectRoot,
      dryRun: false,
    }).pipe(Effect.provide(testLayers(sandbox))),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) return;
  const error = failure.value as CompileError;
  expect(error._tag).toBe("SourceParseError");
  expect(error.message).toContain("tool_permissions");
  await sandbox.cleanup();
});
