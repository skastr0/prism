/**
 * Integration gate for the aggregating shim (UDS-000 wave 1, step 1).
 *
 * Builds two real fixture bundles, runs each as a real daemon process on a
 * scratch UDS socket, spawns the shim (`shim-main.ts`) as a child speaking
 * stdio MCP, and drives it exactly like a harness would:
 *
 *   initialize -> tools/list (merged, namespaced, deterministic order)
 *   -> tools/call each plugin's tool
 *   -> kill daemon B
 *   -> B's tools/call now returns a typed MCP error, A still serves
 */

import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { pluginWireNamespace } from "@skastr0/prism-core/mcp/shim";
import { generateMcpServerBundle } from "../compile/mcp-bundle.js";
import { bindingFromToolSource } from "../compile/tool-bindings.js";
import { waitForChildClose, waitForUdsSocket } from "../compile/test-helpers/mcp-http-roundtrip.js";

const tempRoots: string[] = [];
const liveDaemons: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of liveDaemons.splice(0)) {
    child.kill("SIGTERM");
    await waitForChildClose(child).catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
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

/** Waits until a UDS daemon's healthz endpoint actually answers. */
const waitForUdsHealthy = async (socketPath: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch("http://localhost/healthz", { unix: socketPath } as RequestInit);
      if (response.status === 200) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`UDS daemon did not become healthy at ${socketPath}`);
};

interface FixtureDaemon {
  readonly pluginName: string;
  readonly toolName: string;
  readonly socketPath: string;
  readonly child: ChildProcessWithoutNullStreams;
}

/**
 * Compiles a minimal one-tool plugin bundle and spawns it as a real daemon
 * bound to a scratch UDS socket, self-registering into the (sandboxed, via
 * `HOME`) UDS registry — exactly the contract `getDaemon` reads.
 */
const spawnFixtureDaemon = async (options: {
  readonly pluginName: string;
  readonly outputField: string;
  readonly home: string;
}): Promise<FixtureDaemon> => {
  const root = await mkdtemp(join(tmpdir(), `prism-shim-fixture-${options.pluginName}-`));
  tempRoots.push(root);
  const pluginRoot = join(root, "plugin");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: options.pluginName, version: "0.1.0", targets: { tools: ["hermes"] } }, null, 2)}\n`,
  );
  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo fixture tool for ${options.pluginName}.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ ${options.outputField}: Schema.String }),
  async handle(input) {
    return { ${options.outputField}: input.message };
  },
});
`,
  );

  const serverName = `prism-generated-${options.pluginName}`;
  const bundle = await generateMcpServerBundle({
    sourcePluginName: options.pluginName,
    sourcePluginRoot: pluginRoot,
    serverName,
    bundleId: serverName,
    bindings: [bindingFromToolSource(options.pluginName, join(pluginRoot, "tools", "echo.tool.ts"))],
  });
  const toolName = bundle.toolNames[0];
  if (!toolName) throw new Error(`fixture bundle for ${options.pluginName} produced no tools`);

  const serverPath = join(root, "server.mjs");
  await writeText(serverPath, bundle.content);

  const socketPath = join(root, "d.sock");
  const child = spawn("bun", [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      HOME: options.home,
      PRISM_MCP_UDS_PATH: socketPath,
      PRISM_MCP_REGISTRY_PLUGIN_NAME: options.pluginName,
      PRISM_MCP_REGISTRY_BUNDLE_HASH: `test-hash-${options.pluginName}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveDaemons.push(child);

  await waitForUdsSocket(socketPath);
  await waitForUdsHealthy(socketPath);

  return { pluginName: options.pluginName, toolName, socketPath, child };
};

test("shim aggregates tools/list, dispatches tools/call, and isolates a dead plugin", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "prism-shim-home-"));
  tempRoots.push(homeRoot);

  const daemonA = await spawnFixtureDaemon({ pluginName: "shim-fixture-a", outputField: "echoed", home: homeRoot });
  const daemonB = await spawnFixtureDaemon({ pluginName: "shim-fixture-b", outputField: "reechoed", home: homeRoot });

  const shimMainPath = join(process.cwd(), "src", "mcp", "shim-main.ts");
  const transport = new StdioClientTransport({
    command: "bun",
    args: [shimMainPath],
    env: {
      ...(process.env as Record<string, string>),
      HOME: homeRoot,
      PRISM_SHIM_PLUGINS: `${daemonA.pluginName},${daemonB.pluginName}`,
      PRISM_SHIM_DAEMON_TIMEOUT_MS: "2000",
    },
  });
  const client = new Client({ name: "prism-shim-test-client", version: "0.1.0" });

  try {
    await client.connect(transport);

    // tools/list: merged, namespaced, and in configured-plugin order.
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(2);

    const namespaceA = pluginWireNamespace(daemonA.pluginName);
    const namespaceB = pluginWireNamespace(daemonB.pluginName);
    const fqNameA = `${namespaceA}__${daemonA.toolName}`;
    const fqNameB = `${namespaceB}__${daemonB.toolName}`;

    expect(listed.tools.map((tool) => tool.name)).toEqual([fqNameA, fqNameB]);

    // tools/call: both plugins alive, both dispatch correctly to their own daemon.
    const calledA = await client.callTool({ name: fqNameA, arguments: { message: "hello-a" } });
    expect(calledA.structuredContent).toEqual({ echoed: "hello-a" });

    const calledB = await client.callTool({ name: fqNameB, arguments: { message: "hello-b" } });
    expect(calledB.structuredContent).toEqual({ reechoed: "hello-b" });

    // Kill daemon B; wait for full exit (its SIGTERM handler unregisters
    // itself from the UDS registry and unlinks its socket before exiting).
    // Drop it from `liveDaemons` first so `afterEach`'s sweep doesn't try to
    // kill an already-dead process.
    const liveIndex = liveDaemons.indexOf(daemonB.child);
    if (liveIndex >= 0) liveDaemons.splice(liveIndex, 1);
    daemonB.child.kill("SIGTERM");
    await waitForChildClose(daemonB.child).catch(() => undefined);

    // B's calls now fail with a typed MCP error; A is untouched and still serves.
    await expect(client.callTool({ name: fqNameB, arguments: { message: "hello-b-again" } })).rejects.toBeInstanceOf(
      McpError,
    );

    const calledAAgain = await client.callTool({ name: fqNameA, arguments: { message: "still-fine" } });
    expect(calledAAgain.structuredContent).toEqual({ echoed: "still-fine" });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
