/**
 * Minimal MCP plugin fixture for lifecycle stress tests.
 *
 * Creates a sandboxed PRISM_HOME, a tiny plugin with one canonical tool, and
 * compiles the canonical MCP server bundle. All paths point inside the sandbox,
 * so tests never touch the real harness roots or launchd.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPrismSandbox, type PrismSandbox } from "../../testing/prism-sandbox.js";
import { generateMcpServerBundle } from "../../compile/mcp-bundle.js";
import { writePrismMcpServerBundle } from "../../compile/mcp-runtime-path.js";
import { bindingFromToolSource } from "../../compile/tool-bindings.js";
import type { McpServeOptions, McpStatusOptions, McpStopOptions } from "../lifecycle.js";

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js",
).replace(/\\/g, "/");

const prismImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

export interface MinimalMcpPluginFixture {
  readonly sandbox: PrismSandbox;
  readonly pluginRoot: string;
  readonly pluginName: string;
  readonly prismHome: string;
  readonly serverPath: string;
  readonly runtimePath: string;
  readonly healthUrlFor: (port: number) => string;
  readonly serveOptions: (overrides?: Partial<McpServeOptions>) => McpServeOptions;
  readonly stopOptions: (overrides?: Partial<McpStopOptions>) => McpStopOptions;
  readonly statusOptions: (overrides?: Partial<McpStatusOptions>) => McpStatusOptions;
  readonly writeServerScript: (content: string) => Promise<void>;
}

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const buildBundle = async (
  pluginRoot: string,
  prismHome: string,
  pluginName: string,
): Promise<void> => {
  const serverName = `prism-generated-${pluginName}`;
  const bundle = await generateMcpServerBundle({
    sourcePluginName: pluginName,
    sourcePluginRoot: pluginRoot,
    serverName,
    bundleId: serverName,
    bindings: [bindingFromToolSource(pluginName, join(pluginRoot, "tools", "echo.tool.ts"))],
  });
  await writePrismMcpServerBundle(prismHome, pluginName, bundle.content);
};

export const createMinimalMcpPluginFixture = async (
  options: {
    readonly pluginName?: string;
    readonly harness?: "hermes";
  } = {},
): Promise<MinimalMcpPluginFixture> => {
  const pluginName = options.pluginName ?? "stress-tools";
  const harness = options.harness ?? "hermes";
  const sandbox = await createPrismSandbox();
  const pluginRoot = join(sandbox.root, "plugin");
  const prismHome = sandbox.prismHome;

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: pluginName,
        version: "0.1.0",
        targets: { tools: [harness] },
      },
      null,
      2,
    )}\n`,
  );

  await writeText(
    join(pluginRoot, "tools", "echo.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo from stress tests.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  await buildBundle(pluginRoot, prismHome, pluginName);

  const serverPath = join(prismHome, "runtime", "mcp", pluginName, "server.mjs");
  const runtimePath = join(prismHome, "runtime", "mcp", pluginName, "runtime.json");

  const serveOptions = (overrides: Partial<McpServeOptions> = {}): McpServeOptions => ({
    pluginPath: pluginRoot,
    harness,
    scope: "global",
    prismHome,
    port: "auto",
    startupTimeoutMs: 5_000,
    ...overrides,
  });

  const stopOptions = (overrides: Partial<McpStopOptions> = {}): McpStopOptions => ({
    pluginPath: pluginRoot,
    harness,
    scope: "global",
    prismHome,
    timeoutMs: 5_000,
    ...overrides,
  });

  const statusOptions = (overrides: Partial<McpStatusOptions> = {}): McpStatusOptions => ({
    pluginPath: pluginRoot,
    harness,
    scope: "global",
    prismHome,
    ...overrides,
  });

  const writeServerScript = async (content: string): Promise<void> => {
    await writeText(serverPath, content);
  };

  const healthUrlFor = (port: number): string => `http://127.0.0.1:${port}/healthz`;

  return {
    sandbox,
    pluginRoot,
    pluginName,
    prismHome,
    serverPath,
    runtimePath,
    healthUrlFor,
    serveOptions,
    stopOptions,
    statusOptions,
    writeServerScript,
  };
};
