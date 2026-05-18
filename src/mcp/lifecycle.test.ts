import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  formatMcpStatus,
  getMcpStatus,
  restartMcp,
  serveMcp,
  stopMcp,
  type McpServeOptions,
} from "./lifecycle.js";
import { parseMcpRuntimeHealth } from "./runtime-metadata.js";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

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
  const root = await mkdtemp(join(tmpdir(), "prism-mcp-lifecycle-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const createHermesToolFixture = async (): Promise<{
  readonly pluginRoot: string;
  readonly hermesRoot: string;
  readonly toolPath: string;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "hermes-tools");
  const hermesRoot = join(root, "hermes-root");
  await mkdir(hermesRoot, { recursive: true });
  await writeFile(join(hermesRoot, "config.yaml"), "existing: true\n");
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "hermes-tools",
        version: "0.1.0",
        targets: { tools: ["hermes"] },
      },
      null,
      2,
    )}\n`,
  );
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo from lifecycle tests.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );
  return { pluginRoot, hermesRoot, toolPath };
};

const withTokenEnv = <A>(name: string, value: string, run: () => Promise<A>): Promise<A> => {
  const previous = process.env[name];
  process.env[name] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};

const pidIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!pidIsRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pid ${pid} did not exit`);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const getFreePort = (host: string): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });

const countServerProcesses = async (serverPath: string): Promise<number> => {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return stdout
    .split("\n")
    .filter((line) => line.includes(serverPath))
    .length;
};

const waitForServerProcessCount = async (
  serverPath: string,
  expected: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await countServerProcesses(serverPath) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await countServerProcesses(serverPath)).toBe(expected);
};

const fetchHealth = async (
  port: number,
  token: string,
): Promise<ReturnType<typeof parseMcpRuntimeHealth>> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return parseMcpRuntimeHealth(await response.json());
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server on port ${port} did not become healthy`);
};

const listenOnPort = (host: string, port: number): Promise<NetServer> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });

const closeServer = (server: NetServer | HttpServer): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

const listenWithHttpHandler = (
  host: string,
  port: number,
  onRequest: () => void,
): Promise<HttpServer> =>
  new Promise((resolve, reject) => {
    const server = createHttpServer((_, response) => {
      onRequest();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schema: "prism.mcp-health.v1",
        serverName: "attacker",
        transport: "streamable-http",
        startedAt: "2026-05-17T00:00:00.000Z",
        uptimeMs: 1,
        pid: process.pid,
        toolCount: 0,
        serverSha256: "0".repeat(64),
      }));
    });
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });

const serveOptions = (
  pluginRoot: string,
  hermesRoot: string,
  tokenEnv: string,
): McpServeOptions => ({
  pluginPath: pluginRoot,
  harness: "hermes",
  scope: "global",
  root: hermesRoot,
  port: "auto",
  tokenEnv,
  startupTimeoutMs: 5_000,
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("MCP lifecycle serve starts one daemon and repeated serve is idempotent", async () => {
  const { pluginRoot, hermesRoot, toolPath } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_IDEMPOTENT";

  await withTokenEnv(tokenEnv, "test-token", async () => {
    const originalConfig = await readFile(join(hermesRoot, "config.yaml"), "utf8");
    const first = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    try {
      expect(first.state).toBe("started");
      expect(first.metadata?.pid).toBeGreaterThan(0);
      expect(first.metadata?.mcpUrl).toContain("/mcp");
      expect(first.metadata?.healthUrl).toContain("/healthz");
      await waitForServerProcessCount(first.descriptor.serverPath, 1);

      const second = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
      expect(second.state).toBe("already-running");
      expect(second.metadata?.pid).toBe(first.metadata?.pid);
      await waitForServerProcessCount(first.descriptor.serverPath, 1);

      await writeText(
        toolPath,
        (await readFile(toolPath, "utf8")).replace(
          "Echo from lifecycle tests.",
          "Echo from changed lifecycle tests.",
        ),
      );
      const rebuilt = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
      expect(rebuilt.state).toBe("started");
      expect(rebuilt.metadata?.pid).toBeGreaterThan(0);
      expect(rebuilt.metadata?.pid).not.toBe(first.metadata?.pid);
      await waitForPidExit(first.metadata!.pid!);

      const status = await getMcpStatus({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      });
      expect(status.state).toBe("running");
      expect(status.health?.serverName).toBe("prism-generated-hermes-tools");
      expect(formatMcpStatus(status)).toContain(`pid=${rebuilt.metadata?.pid}`);
      expect(formatMcpStatus(status)).toContain("url=http://127.0.0.1:");

      const attackerPort = await getFreePort("127.0.0.1");
      let attackerHits = 0;
      const attacker = await listenWithHttpHandler("127.0.0.1", attackerPort, () => {
        attackerHits += 1;
      });
      let originalRuntimeText: string | undefined;
      try {
        originalRuntimeText = await readFile(first.descriptor.runtimePath, "utf8");
        const runtime = JSON.parse(originalRuntimeText) as Record<string, unknown>;
        runtime.tokenEnv = "PATH";
        runtime.healthUrl = `http://127.0.0.1:${attackerPort}/healthz`;
        runtime.port = attackerPort;
        await writeFile(first.descriptor.runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);

        const listenerMismatch = await getMcpStatus({
          pluginPath: pluginRoot,
          harness: "hermes",
          scope: "global",
          root: hermesRoot,
          tokenEnv,
        });
        expect(listenerMismatch.state).toBe("stale-health");
        expect(listenerMismatch.staleReasons).toContain("listener-pid-mismatch");
        await expect(
          stopMcp({
            pluginPath: pluginRoot,
            harness: "hermes",
            scope: "global",
            root: hermesRoot,
            tokenEnv,
          }),
        ).rejects.toThrow(/Refusing to stop MCP daemon/);
        expect(pidIsRunning(rebuilt.metadata!.pid!)).toBe(true);
        expect(pidIsRunning(process.pid)).toBe(true);
        expect(attackerHits).toBe(0);

        runtime.pid = process.pid;
        await writeFile(first.descriptor.runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
        const pidMismatch = await getMcpStatus({
          pluginPath: pluginRoot,
          harness: "hermes",
          scope: "global",
          root: hermesRoot,
          tokenEnv,
        });
        expect(pidMismatch.state).toBe("stale-health");
        expect(pidMismatch.staleReasons).toContain("pid-command-mismatch");
        await expect(
          stopMcp({
            pluginPath: pluginRoot,
            harness: "hermes",
            scope: "global",
            root: hermesRoot,
            tokenEnv,
          }),
        ).rejects.toThrow(/Refusing to stop MCP daemon/);
        expect(pidIsRunning(process.pid)).toBe(true);
        expect(attackerHits).toBe(0);
      } finally {
        if (originalRuntimeText) {
          await writeFile(first.descriptor.runtimePath, originalRuntimeText);
        }
        await closeServer(attacker);
      }
      expect(await readFile(join(hermesRoot, "config.yaml"), "utf8")).toBe(originalConfig);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle stop and restart update runtime metadata safely", async () => {
  const { pluginRoot, hermesRoot } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_RESTART";

  await withTokenEnv(tokenEnv, "test-token", async () => {
    const started = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    expect(started.state).toBe("started");
    const firstPid = started.metadata?.pid;

    const restartedLive = await restartMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    expect(restartedLive.state).toBe("started");
    expect(restartedLive.metadata?.pid).toBeGreaterThan(0);
    expect(restartedLive.metadata?.pid).not.toBe(firstPid);
    await waitForPidExit(firstPid!);

    const stopped = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(stopped.state).toBe("stopped");

    const stoppedStatus = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(stoppedStatus.state).toBe("stopped");

    const restarted = await restartMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    try {
      expect(restarted.state).toBe("started");
      expect(restarted.metadata?.pid).toBeGreaterThan(0);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle foreground serve exits without writing runtime metadata", async () => {
  const { pluginRoot, hermesRoot } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_FOREGROUND";
  const port = await getFreePort("127.0.0.1");

  await withTokenEnv(tokenEnv, "test-token", async () => {
    const foreground = serveMcp({
      ...serveOptions(pluginRoot, hermesRoot, tokenEnv),
      port,
      foreground: true,
    });
    const health = await fetchHealth(port, "test-token");
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.kill(health.pid, "SIGTERM");

    const result = await foreground;
    expect(result.state).toBe("foreground-exited");
    expect(await pathExists(result.descriptor.runtimePath)).toBe(false);
  });
}, 15_000);

test("MCP lifecycle status uses stored tokens and reports stale pid states", async () => {
  const { pluginRoot, hermesRoot } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_STATES";

  await withTokenEnv(tokenEnv, "test-token", async () => {
    const started = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    const pid = started.metadata?.pid;
    expect(pid).toBeGreaterThan(0);

    delete process.env[tokenEnv];
    const storedTokenStatus = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(storedTokenStatus.state).toBe("running");
    const stoppedWithoutToken = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(stoppedWithoutToken.state).toBe("stopped");
    await waitForPidExit(pid!);

    process.env[tokenEnv] = "test-token";
    const restarted = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    const stalePidValue = restarted.metadata?.pid;
    expect(stalePidValue).toBeGreaterThan(0);
    process.kill(stalePidValue!, "SIGKILL");
    await waitForPidExit(stalePidValue!);
    const stalePid = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(stalePid.state).toBe("stale-pid");
    const stoppedStalePid = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(stoppedStalePid.state).toBe("already-stopped");
    expect(stoppedStalePid.metadata?.pid).toBeUndefined();

    const restartedAfterStalePid = await restartMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    try {
      expect(restartedAfterStalePid.state).toBe("started");
      expect(restartedAfterStalePid.metadata?.pid).toBeGreaterThan(0);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle status reports stale build and port conflict states", async () => {
  const { pluginRoot, hermesRoot } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_CONFLICT";

  await withTokenEnv(tokenEnv, "test-token", async () => {
    const started = await serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    const pid = started.metadata?.pid;
    const serverPath = started.descriptor.serverPath;
    let originalServer = await readFile(serverPath, "utf8");
    await writeFile(serverPath, `${originalServer}\n// tampered\n`);
    const staleBuild = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(staleBuild.state).toBe("stale-build");
    expect(staleBuild.staleReasons).toContain("server-file-sha256-mismatch");
    expect(formatMcpStatus(staleBuild)).toContain("reasons=server-file-sha256-mismatch");
    const restarted = await restartMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    expect(restarted.state).toBe("started");
    expect(restarted.metadata?.pid).toBeGreaterThan(0);
    expect(restarted.metadata?.pid).not.toBe(pid);
    await waitForPidExit(pid!);
    originalServer = await readFile(serverPath, "utf8");

    await rm(serverPath);
    const missingServer = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(missingServer.state).toBe("stale-build");
    expect(missingServer.staleReasons).toContain("missing-server-file");

    const stopped = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      root: hermesRoot,
      tokenEnv,
    });
    expect(stopped.state).toBe("stopped");
    expect(stopped.metadata?.port).toBeGreaterThan(0);
    await waitForPidExit(restarted.metadata!.pid!);
    await writeFile(serverPath, originalServer);

    const dummy = await listenOnPort("127.0.0.1", stopped.metadata!.port!);
    try {
      const conflict = await getMcpStatus({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      });
      expect(conflict.state).toBe("port-conflict");
      const stopConflict = await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      });
      expect(stopConflict.state).toBe("already-stopped");
      await expect(
        serveMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv)),
      ).rejects.toThrow(/Port \d+ on 127\.0\.0\.1 is already in use/);
      await expect(
        restartMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv)),
      ).rejects.toThrow(/Port \d+ on 127\.0\.0\.1 is already in use/);
    } finally {
      await closeServer(dummy);
    }

    const recovered = await restartMcp(serveOptions(pluginRoot, hermesRoot, tokenEnv));
    try {
      expect(recovered.state).toBe("started");
      expect(recovered.metadata?.pid).toBeGreaterThan(0);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        root: hermesRoot,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);
