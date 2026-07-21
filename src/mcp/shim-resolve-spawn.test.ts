/**
 * Integration gate for resolve-or-spawn (UDS-000 wave 1, step 2).
 *
 * No daemon is pre-started here (unlike shim-main.test.ts's step-1 gate):
 * the compiled bundle exists on disk under a sandboxed HOME, but nothing is
 * registered or listening. Five concurrent shim processes each resolve the
 * same absent plugin at once; the wave-0 singleton bind
 * (`bindUnixSocketSingleton`, already wired into every compiled bundle's own
 * startup) is the only thing that decides the winner -- this asserts
 * exactly one daemon process survives (registry entry + `pgrep` process
 * count) and every shim's tool call still succeeds.
 *
 * A second phase then simulates a `prism refresh`: the bundle at the same
 * canonical path is overwritten with different content (different hash). A
 * fresh shim resolving the same plugin must detect the stale hash, spawn a
 * second daemon on a new content-addressed socket, and route calls there --
 * the old (now orphaned) daemon is left running untouched, never killed.
 */

import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalBase } from "@skastr0/prism-sdk/mcp/wire-naming";
import { generateMcpServerBundle, mcpToolNamesForBindings } from "../compile/mcp-bundle.js";
import { bindingFromToolSource } from "../compile/tool-bindings.js";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close().catch(() => undefined);
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const effectImportPath = join(process.cwd(), "node_modules", "effect", "dist", "esm", "index.js").replace(
  /\\/g,
  "/",
);
const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const PLUGIN_NAME = "e2e-spawn";

interface FixtureBundle {
  readonly content: string;
  readonly toolName: string;
}

/** Compiles a real one-tool plugin bundle (never spawned by this helper). */
const compileFixtureBundleContent = async (outputField: string): Promise<FixtureBundle> => {
  const root = await mkdtemp(join(tmpdir(), "prism-resolve-spawn-src-"));
  tempRoots.push(root);
  const pluginRoot = join(root, "plugin");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: PLUGIN_NAME, version: "0.1.0", targets: { tools: ["hermes"] } }, null, 2)}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Echo fixture tool for resolve-or-spawn.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ ${outputField}: Schema.String }),
  async handle(input) {
    return { ${outputField}: input.message };
  },
};
`,
  );

  const serverName = `prism-generated-${PLUGIN_NAME}`;
  const bindings = [bindingFromToolSource(PLUGIN_NAME, join(pluginRoot, "tools", "echo.tool.ts"))];
  const bundle = await generateMcpServerBundle({
    sourcePluginName: PLUGIN_NAME,
    sourcePluginRoot: pluginRoot,
    serverName,
    bundleId: serverName,
    bindings,
    // Mirror the pipeline: real bundles register a per-harness exposure
    // profile, and a shim given no explicit PRISM_SHIM_EXPOSURE derives
    // `<serverName>:<harness>` per owner daemon.
    exposureProfiles: [
      { name: `${serverName}:claude-code`, toolNames: mcpToolNamesForBindings(PLUGIN_NAME, bindings) },
    ],
  });
  const toolName = bundle.toolNames[0];
  if (!toolName) throw new Error(`fixture bundle for ${PLUGIN_NAME} produced no tools`);
  return { content: bundle.content, toolName };
};

/** `<homeRoot>/.prism/runtime/mcp/<plugin>/server.mjs` -- the same canonical
 * layout `daemon-resolver.ts`'s `pluginBundlePath` resolves against `os.homedir()`
 * for; writing here under a sandboxed `HOME` is what makes this a
 * self-contained fixture. */
const canonicalBundlePath = (homeRoot: string, plugin: string): string =>
  join(homeRoot, ".prism", "runtime", "mcp", plugin, "server.mjs");

const installBundle = async (homeRoot: string, plugin: string, content: string): Promise<string> => {
  const path = canonicalBundlePath(homeRoot, plugin);
  await writeText(path, content);
  return path;
};

/** Mirrors `uds-registry.ts`'s own per-plugin registry file naming exactly
 * (content-addressed hash of the plugin name, not the bundle). */
const registryFilePath = (homeRoot: string, plugin: string): string => {
  const hash = createHash("sha256").update(plugin).digest("hex").slice(0, 16);
  return join(homeRoot, ".prism", "runtime", "mcp", plugin, `${hash}.registry.json`);
};

interface RegistrySnapshot {
  readonly pid: number;
  readonly sock: string;
  readonly bundleHash: string;
}

const readRegistryEntry = async (homeRoot: string, plugin: string): Promise<RegistrySnapshot | undefined> => {
  try {
    const raw = await readFile(registryFilePath(homeRoot, plugin), "utf8");
    return JSON.parse(raw) as RegistrySnapshot;
  } catch {
    return undefined;
  }
};

const countLiveProcessesMatching = async (marker: string): Promise<number> => {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", marker]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch {
    // pgrep exits 1 (and prints nothing) when there are zero matches.
    return 0;
  }
};

const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs: number, pollMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }
  return predicate();
};

interface ShimClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

/**
 * Builds (but does not connect) a shim client/transport pair. `client.close()`
 * (invoked from `afterEach` for every entry in `openClients`) closes the
 * transport, which kills the *shim* child process -- never the detached
 * daemon it may have spawned, which deliberately outlives it.
 */
const makeShimClient = (
  homeRoot: string,
  plugin: string,
  options: { readonly spawnTimeoutMs: number; readonly idleTtlMs: number },
): ShimClient => {
  const shimMainPath = join(process.cwd(), "src", "mcp", "shim-main.ts");
  // shim-main.ts resolves `PRISM_HOME` (falling back to `~/.prism` under
  // the overridden `HOME` below only when `PRISM_HOME` is unset) and
  // threads it all the way to `pluginBundlePath`/`udsPathFor` -- so the
  // globally-sandboxed `PRISM_HOME` this whole test run inherits from
  // `scripts/test-preload.ts` must NOT leak into this subprocess, or the
  // shim looks for the fixture bundle under the wrong sandbox path instead
  // of this test's own `homeRoot`.
  const { PRISM_HOME: _inheritedPrismHome, ...envWithoutInheritedPrismHome } = process.env as Record<
    string,
    string
  >;
  const transport = new StdioClientTransport({
    command: "bun",
    args: [shimMainPath],
    env: {
      ...envWithoutInheritedPrismHome,
      HOME: homeRoot,
      PRISM_SHIM_PLUGINS: plugin,
      PRISM_SHIM_HARNESS: "claude-code",
      PRISM_SHIM_DAEMON_TIMEOUT_MS: "5000",
      PRISM_SHIM_SPAWN_TIMEOUT_MS: String(options.spawnTimeoutMs),
      // Forwarded through the shim's own env to the daemon it spawns
      // (`defaultSpawnDaemon` inherits `process.env`) -- keeps this test's
      // fixture daemons from lingering for the default 15-minute idle TTL.
      PRISM_MCP_IDLE_TTL_MS: String(options.idleTtlMs),
    },
  });
  const client = new Client({ name: "prism-shim-resolve-spawn-test-client", version: "0.1.0" });
  openClients.push(client);
  return { client, transport };
};

test(
  "5 concurrent shims resolving the same absent plugin spawn exactly one daemon; a later hash mismatch spawns a fresh one",
  async () => {
    const homeRoot = await mkdtemp(
      join(tmpdir(), "prism-uds-e2e-deliberately-long-sandbox-home-"),
    );
    tempRoots.push(homeRoot);

    const bundleV1 = await compileFixtureBundleContent("echoed");
    const bundlePath = await installBundle(homeRoot, PLUGIN_NAME, bundleV1.content);

    const fqName = canonicalBase(PLUGIN_NAME, bundleV1.toolName);

    // --- Phase 1: absent -> 5 concurrent shims race to spawn. ---
    const shims = Array.from({ length: 5 }, () =>
      makeShimClient(homeRoot, PLUGIN_NAME, { spawnTimeoutMs: 10_000, idleTtlMs: 5_000 }),
    );

    await Promise.all(shims.map(({ client, transport }) => client.connect(transport)));

    const results = await Promise.all(
      shims.map(({ client }, index) => client.callTool({ name: fqName, arguments: { message: `hello-${index}` } })),
    );
    results.forEach((result, index) => {
      expect(result.structuredContent).toEqual({ echoed: `hello-${index}` });
    });

    // Falsifier: exactly one daemon process survives the race (the other
    // four lose `bindUnixSocketSingleton` inside their own bundle and
    // `process.exit(0)` before ever registering).
    const settledToOne = await waitUntil(async () => (await countLiveProcessesMatching(bundlePath)) === 1, 5_000);
    expect(settledToOne).toBe(true);
    expect(await countLiveProcessesMatching(bundlePath)).toBe(1);

    const entryV1 = await readRegistryEntry(homeRoot, PLUGIN_NAME);
    expect(entryV1).toBeDefined();
    expect(entryV1!.sock).toMatch(/^\/tmp\/prism-mcp-[^/]+\/[a-f0-9]{32}\.sock$/);
    expect(Buffer.byteLength(entryV1!.sock, "utf8")).toBeLessThanOrEqual(100);

    // --- Phase 2: simulate `prism refresh` -- same path, new bytes/hash. ---
    const bundleV2 = await compileFixtureBundleContent("reechoed");
    expect(bundleV2.content).not.toBe(bundleV1.content);
    await installBundle(homeRoot, PLUGIN_NAME, bundleV2.content);

    const shimV2 = makeShimClient(homeRoot, PLUGIN_NAME, { spawnTimeoutMs: 10_000, idleTtlMs: 5_000 });
    await shimV2.client.connect(shimV2.transport);

    const resultV2 = await shimV2.client.callTool({ name: fqName, arguments: { message: "post-refresh" } });
    // Routed to the freshly spawned (v2) daemon, not the still-running v1
    // one -- v1 would answer with `{ echoed: ... }`, never `{ reechoed: ... }`.
    expect(resultV2.structuredContent).toEqual({ reechoed: "post-refresh" });

    const entryV2 = await readRegistryEntry(homeRoot, PLUGIN_NAME);
    expect(entryV2).toBeDefined();
    expect(entryV2!.bundleHash).not.toBe(entryV1!.bundleHash);
    expect(entryV2!.sock).not.toBe(entryV1!.sock);
  },
  30_000,
);
