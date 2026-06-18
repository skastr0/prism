import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateMcpServerBundle } from "./mcp-bundle.js";
import { bindingFromToolSource } from "./tool-bindings.js";
import {
  getFreePort,
  waitForChildClose,
  waitForHttpServer,
} from "./test-helpers/mcp-http-roundtrip.js";
import {
  McpHttpClient,
  McpHttpTimeoutError,
} from "../mcp/http-client.js";

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
  const root = await mkdtemp(join(tmpdir(), "prism-mcp-resilience-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

interface ResilienceFixture {
  readonly root: string;
  readonly serverPath: string;
  readonly toolName: string;
  readonly port: number;
  spawnServer(): ChildProcessWithoutNullStreams;
}

const createEchoToolFixture = async (): Promise<ResilienceFixture> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "echo-plugin");
  const projectRoot = join(root, "project");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");

  await mkdir(projectRoot, { recursive: true });
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name: "echo-plugin", version: "0.1.0" }, null, 2)}\n`,
  );
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo for resilience tests",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );

  const bundle = await generateMcpServerBundle({
    sourcePluginName: "echo-plugin",
    sourcePluginRoot: pluginRoot,
    serverName: "prism-mcp-echo",
    bundleId: "echo-plugin",
    bindings: [bindingFromToolSource("echo-plugin", toolPath)],
  });

  const serverPath = join(projectRoot, bundle.relativePath);
  await writeText(serverPath, bundle.content);

  const port = await getFreePort();

  return {
    root,
    serverPath,
    toolName: "echo_plugin_echo",
    port,
    spawnServer: () =>
      spawn("bun", [serverPath], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PRISM_MCP_HTTP_PORT: String(port),
        },
        stdio: ["pipe", "pipe", "pipe"],
      }),
  };
};

const stopServer = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  child.kill("SIGTERM");
  await waitForChildClose(child).catch(() => undefined);
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("MCP HTTP client recovers after transient server restart on the same port", async () => {
  const fixture = await createEchoToolFixture();
  const client = new McpHttpClient({
    baseUrl: `http://127.0.0.1:${fixture.port}/mcp`,
    timeoutMs: 2_000,
    retries: 5,
    retryDelayMs: 50,
  });

  const first = fixture.spawnServer();
  try {
    await waitForHttpServer(fixture.port);
    await client.connect();
    const firstList = await client.listTools();
    expect(firstList.map((tool) => tool.name)).toContain(fixture.toolName);
  } finally {
    await stopServer(first);
  }

  await expect(client.listTools()).rejects.toThrow();

  const second = fixture.spawnServer();
  try {
    await waitForHttpServer(fixture.port);
    await client.connect();
    const secondList = await client.listTools();
    expect(secondList.map((tool) => tool.name)).toContain(fixture.toolName);

    const called = await client.callTool(fixture.toolName, { message: "hello again" });
    expect(called.text).toContain("hello again");
  } finally {
    await stopServer(second);
  }
}, 15_000);

test("MCP HTTP client surfaces a typed timeout instead of hanging", async () => {
  const fixture = await createEchoToolFixture();
  const client = new McpHttpClient({
    baseUrl: `http://127.0.0.1:${fixture.port}/mcp`,
    timeoutMs: 1,
    retries: 0,
  });

  const child = fixture.spawnServer();
  try {
    await waitForHttpServer(fixture.port);
    const error = await client.connect().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(McpHttpTimeoutError);
    expect((error as McpHttpTimeoutError).method).toBe("initialize");
  } finally {
    await stopServer(child);
  }
}, 5_000);

test("MCP HTTP client pipelines initialize -> tools/list -> tools/call without stream corruption", async () => {
  const fixture = await createEchoToolFixture();
  const client = new McpHttpClient({
    baseUrl: `http://127.0.0.1:${fixture.port}/mcp`,
    timeoutMs: 2_000,
    retries: 2,
  });

  const child = fixture.spawnServer();
  try {
    await waitForHttpServer(fixture.port);
    await client.connect();

    const [listed, called] = await Promise.all([
      client.listTools(),
      client.callTool(fixture.toolName, { message: "pipelined" }),
    ]);

    expect(listed.map((tool) => tool.name)).toContain(fixture.toolName);
    expect(called.text).toContain("pipelined");

    const secondCall = await client.callTool(fixture.toolName, { message: "after pipeline" });
    expect(secondCall.text).toContain("after pipeline");
  } finally {
    await stopServer(child);
  }
}, 10_000);

test("MCP HTTP client retries through transient connection refused before server starts", async () => {
  const fixture = await createEchoToolFixture();
  const client = new McpHttpClient({
    baseUrl: `http://127.0.0.1:${fixture.port}/mcp`,
    timeoutMs: 1_000,
    retries: 10,
    retryDelayMs: 50,
  });

  const child = fixture.spawnServer();
  try {
    await waitForHttpServer(fixture.port);
    await client.connect();
    const listed = await client.listTools();
    expect(listed.map((tool) => tool.name)).toContain(fixture.toolName);
  } finally {
    await stopServer(child);
  }
}, 10_000);
