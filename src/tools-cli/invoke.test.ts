import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateMcpServerBundle } from "../compile/mcp-bundle.js";
import { bindingFromToolSource } from "../compile/tool-bindings.js";
import {
  waitForChildClose,
  waitForUdsSocket,
} from "../compile/test-helpers/mcp-http-roundtrip.js";
import { callDaemonTool } from "./invoke.js";

const tempRoots: string[] = [];
const liveDaemons: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of liveDaemons.splice(0)) {
    child.kill("SIGTERM");
    await waitForChildClose(child).catch(() => undefined);
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const waitForUdsHealthy = async (socketPath: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch("http://localhost/healthz", {
        unix: socketPath,
      } as RequestInit);
      if (response.status === 200) return;
    } catch {
      // The daemon has not finished binding yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`UDS daemon did not become healthy at ${socketPath}`);
};

test("one-shot CLI calls terminate every MCP session across success and error paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-tools-invoke-session-"));
  tempRoots.push(root);
  const pluginName = "session-cleanup";
  const pluginRoot = join(root, "plugin");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");
  const effectImportPath = join(
    process.cwd(),
    "node_modules",
    "effect",
    "dist",
    "esm",
    "index.js",
  ).replace(/\\/g, "/");

  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};

export default {
  name: "echo",
  description: "Exercise one-shot MCP session cleanup.",
  input: Schema.Struct({ message: Schema.String, fail: Schema.optional(Schema.Boolean) }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    if (input.fail) throw new Error("fixture tool failure");
    return { echoed: input.message };
  },
};
`,
  );

  const bindings = [bindingFromToolSource(pluginName, toolPath)];
  const bundle = await generateMcpServerBundle({
    sourcePluginName: pluginName,
    sourcePluginRoot: pluginRoot,
    serverName: `prism-generated-${pluginName}`,
    bundleId: pluginName,
    bindings,
  });
  const wireName = bundle.toolNames[0];
  if (!wireName) throw new Error("session cleanup fixture produced no MCP tool");

  const serverPath = join(root, "server.mjs");
  const socketPath = join(root, "daemon.sock");
  await writeText(serverPath, bundle.content);
  const child = spawn("bun", [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PRISM_MCP_UDS_PATH: socketPath,
      PRISM_MCP_MAX_SESSIONS: "1",
      PRISM_MCP_IDLE_TTL_MS: "60000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveDaemons.push(child);
  await waitForUdsSocket(socketPath);
  await waitForUdsHealthy(socketPath);

  const invoke = (args: Record<string, unknown>) =>
    callDaemonTool({
      pluginName,
      socketPath,
      wireName,
      args,
      timeoutMs: 5_000,
    });

  // Production defaults retain sessions for one hour and cap them at 128.
  // A cap of one makes a single missed DELETE fail the very next iteration;
  // 129 sequential calls also reproduces the real exhaustion threshold.
  for (let index = 0; index < 129; index += 1) {
    await expect(invoke({ message: `call-${index}` })).resolves.toMatchObject({
      structuredContent: { echoed: `call-${index}` },
    });
  }

  const failed = await invoke({ message: "ignored", fail: true });
  expect(failed).toMatchObject({ isError: true });

  await expect(
    callDaemonTool({
      pluginName,
      socketPath,
      wireName: "missing_tool",
      args: {},
      timeoutMs: 5_000,
    }),
  ).resolves.toMatchObject({ isError: true });

  await expect(invoke({ message: "after-error" })).resolves.toMatchObject({
    structuredContent: { echoed: "after-error" },
  });
});
