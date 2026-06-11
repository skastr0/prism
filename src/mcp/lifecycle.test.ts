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
  rotateMcpBearerToken,
  restartMcp,
  serveMcp,
  stopMcp,
  type McpServeOptions,
} from "./lifecycle.js";
import { parseMcpRuntimeHealth } from "./runtime-metadata.js";
import { generateMcpServerBundle } from "../compile/mcp-bundle.js";
import { writePrismMcpServerBundle } from "../compile/mcp-runtime-path.js";
import { bindingFromToolSource } from "../compile/tool-bindings.js";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);
const lifecycleTestToken = "prism-lifecycle-test-token-with-enough-entropy";

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

const buildCanonicalFixtureBundle = async (
  pluginRoot: string,
  prismHome: string,
): Promise<string> => {
  const bundle = await generateMcpServerBundle({
    sourcePluginName: "hermes-tools",
    sourcePluginRoot: pluginRoot,
    serverName: "prism-generated-hermes-tools",
    bundleId: "prism-generated-hermes-tools",
    bindings: [
      bindingFromToolSource("hermes-tools", join(pluginRoot, "tools", "echo.tool.ts")),
    ],
  });
  const write = await writePrismMcpServerBundle(prismHome, "hermes-tools", bundle.content);
  return write.path;
};

const createHermesToolFixture = async (): Promise<{
  readonly pluginRoot: string;
  readonly prismHome: string;
  readonly toolPath: string;
  readonly rebuildBundle: () => Promise<string>;
}> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, "hermes-tools");
  const prismHome = join(root, "prism-home");
  await mkdir(prismHome, { recursive: true });
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
  await buildCanonicalFixtureBundle(pluginRoot, prismHome);
  return {
    pluginRoot,
    prismHome,
    toolPath,
    rebuildBundle: () => buildCanonicalFixtureBundle(pluginRoot, prismHome),
  };
};

const withTokenEnv = <A>(name: string, value: string, run: () => Promise<A>): Promise<A> => {
  const previous = process.env[name];
  process.env[name] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};

const withEnv = <A>(
  values: Readonly<Record<string, string>>,
  run: () => Promise<A>,
): Promise<A> => {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  prismHome: string,
  tokenEnv: string,
): McpServeOptions => ({
  pluginPath: pluginRoot,
  harness: "hermes",
  scope: "global",
  prismHome,
  port: "auto",
  tokenEnv,
  startupTimeoutMs: 5_000,
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("MCP lifecycle serializes mutations with a per-server lock", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_LOCK";
  const lockDir = join(prismHome, "runtime", "mcp", "hermes-tools");
  const lockPath = join(lockDir, ".lifecycle.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(lockPath, "busy\n");

  await withEnv({ PRISM_MCP_LOCK_WAIT_MS: "50" }, async () => {
    await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
      await expect(
        serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv)),
      ).rejects.toThrow(/Timed out waiting for MCP lifecycle lock/);
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  await withEnv({ PRISM_MCP_LOCK_WAIT_MS: "1000", PRISM_MCP_LOCK_STALE_MS: "1" }, async () => {
    await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
      const started = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
      try {
        expect(started.state).toBe("started");
        expect(await pathExists(lockPath)).toBe(false);
      } finally {
        await stopMcp({
          pluginPath: pluginRoot,
          harness: "hermes",
          scope: "global",
          prismHome,
          tokenEnv,
        }).catch(() => undefined);
      }
    });
  });
}, 15_000);

test("MCP lifecycle serve starts one daemon and repeated serve is idempotent", async () => {
  const { pluginRoot, prismHome, toolPath, rebuildBundle } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_IDEMPOTENT";

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const first = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    try {
      expect(first.state).toBe("started");
      expect(first.metadata?.pid).toBeGreaterThan(0);
      expect(first.metadata?.mcpUrl).toContain("/mcp");
      expect(first.metadata?.healthUrl).toContain("/healthz");
      await waitForServerProcessCount(first.descriptor.serverPath, 1);

      const second = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
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
      // The lifecycle consumes compiled bundles: rebuilding the canonical
      // bundle makes the running daemon stale.
      await rebuildBundle();
      const rebuilt = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
      expect(rebuilt.state).toBe("started");
      expect(rebuilt.metadata?.pid).toBeGreaterThan(0);
      expect(rebuilt.metadata?.pid).not.toBe(first.metadata?.pid);
      await waitForPidExit(first.metadata!.pid!);

      const status = await getMcpStatus({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      });
      expect(status.state).toBe("running");
      expect(status.health?.serverName).toBe("prism-generated-hermes-tools");
      expect(formatMcpStatus(status)).toContain(`pid=${rebuilt.metadata?.pid}`);
      expect(formatMcpStatus(status)).toContain("url=http://127.0.0.1:");

      const runtimeWithDeadPid = JSON.parse(
        await readFile(rebuilt.descriptor.runtimePath, "utf8"),
      ) as Record<string, unknown>;
      runtimeWithDeadPid.pid = 99999999;
      await writeFile(
        rebuilt.descriptor.runtimePath,
        `${JSON.stringify(runtimeWithDeadPid, null, 2)}\n`,
      );
      const adoptedStatus = await getMcpStatus({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      });
      expect(adoptedStatus.state).toBe("running");
      expect(adoptedStatus.metadata?.pid).toBe(rebuilt.metadata?.pid);

      const adoptedServe = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
      expect(adoptedServe.state).toBe("already-running");
      const adoptedRuntime = JSON.parse(
        await readFile(rebuilt.descriptor.runtimePath, "utf8"),
      ) as Record<string, unknown>;
      expect(adoptedRuntime.pid).toBe(rebuilt.metadata?.pid);

      const runtimeWithoutPid = JSON.parse(
        await readFile(rebuilt.descriptor.runtimePath, "utf8"),
      ) as Record<string, unknown>;
      delete runtimeWithoutPid.pid;
      await writeFile(
        rebuilt.descriptor.runtimePath,
        `${JSON.stringify(runtimeWithoutPid, null, 2)}\n`,
      );
      const noPidAdoptedStatus = await getMcpStatus({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      });
      expect(noPidAdoptedStatus.state).toBe("running");
      expect(noPidAdoptedStatus.metadata?.pid).toBe(rebuilt.metadata?.pid);
      const noPidAdoptedServe = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
      expect(noPidAdoptedServe.state).toBe("already-running");
      const noPidAdoptedRuntime = JSON.parse(
        await readFile(rebuilt.descriptor.runtimePath, "utf8"),
      ) as Record<string, unknown>;
      expect(noPidAdoptedRuntime.pid).toBe(rebuilt.metadata?.pid);

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
          prismHome,
          tokenEnv,
        });
        expect(listenerMismatch.state).toBe("stale-health");
        expect(listenerMismatch.staleReasons).toContain("listener-pid-mismatch");
        await expect(
          stopMcp({
            pluginPath: pluginRoot,
            harness: "hermes",
            scope: "global",
            prismHome,
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
          prismHome,
          tokenEnv,
        });
        expect(pidMismatch.state).toBe("stale-health");
        expect(pidMismatch.staleReasons).toContain("pid-command-mismatch");
        await expect(
          stopMcp({
            pluginPath: pluginRoot,
            harness: "hermes",
            scope: "global",
            prismHome,
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
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle moves a running daemon when a configured port appears", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_CONFIGURED_PORT";

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const first = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    try {
      expect(first.state).toBe("started");
      expect(first.metadata?.port).toBeGreaterThan(0);
      const configuredPort = await getFreePort("127.0.0.1");
      await writeText(
        join(pluginRoot, "plugin.json"),
        `${JSON.stringify(
          {
            name: "hermes-tools",
            version: "0.1.0",
            targets: { tools: ["hermes"] },
            runtime: {
              mcp: {
                hermes: {
                  transport: "streamable-http",
                  host: "127.0.0.1",
                  port: configuredPort,
                  tokenEnv,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const moved = await serveMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
        startupTimeoutMs: 5_000,
      });
      expect(moved.state).toBe("started");
      expect(moved.metadata?.port).toBe(configuredPort);
      expect(moved.metadata?.pid).toBeGreaterThan(0);
      expect(moved.metadata?.pid).not.toBe(first.metadata?.pid);
      await waitForPidExit(first.metadata!.pid!);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle stop and restart update runtime metadata safely", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_RESTART";

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const started = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    expect(started.state).toBe("started");
    const firstPid = started.metadata?.pid;

    const restartedLive = await restartMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    expect(restartedLive.state).toBe("started");
    expect(restartedLive.metadata?.pid).toBeGreaterThan(0);
    expect(restartedLive.metadata?.pid).not.toBe(firstPid);
    await waitForPidExit(firstPid!);

    const stopped = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(stopped.state).toBe("stopped");

    const stoppedStatus = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(stoppedStatus.state).toBe("stopped");

    const restarted = await restartMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    try {
      expect(restarted.state).toBe("started");
      expect(restarted.metadata?.pid).toBeGreaterThan(0);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle foreground serve exits without writing runtime metadata", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_FOREGROUND";
  const port = await getFreePort("127.0.0.1");

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const foreground = serveMcp({
      ...serveOptions(pluginRoot, prismHome, tokenEnv),
      port,
      foreground: true,
    });
    const health = await fetchHealth(port, lifecycleTestToken);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.kill(health.pid, "SIGTERM");

    const result = await foreground;
    expect(result.state).toBe("foreground-exited");
    expect(await pathExists(result.descriptor.runtimePath)).toBe(false);
  });
}, 15_000);

test("MCP lifecycle status uses stored tokens and reports stale pid states", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_STATES";

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const started = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    const pid = started.metadata?.pid;
    expect(pid).toBeGreaterThan(0);

    delete process.env[tokenEnv];
    const storedTokenStatus = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(storedTokenStatus.state).toBe("running");
    const stoppedWithoutToken = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(stoppedWithoutToken.state).toBe("stopped");
    await waitForPidExit(pid!);

    process.env[tokenEnv] = lifecycleTestToken;
    const restarted = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    const stalePidValue = restarted.metadata?.pid;
    expect(stalePidValue).toBeGreaterThan(0);
    process.kill(stalePidValue!, "SIGKILL");
    await waitForPidExit(stalePidValue!);
    const stalePid = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(stalePid.state).toBe("stale-pid");
    const stoppedStalePid = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(stoppedStalePid.state).toBe("already-stopped");
    expect(stoppedStalePid.metadata?.pid).toBeUndefined();

    const restartedAfterStalePid = await restartMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    try {
      expect(restartedAfterStalePid.state).toBe("started");
      expect(restartedAfterStalePid.metadata?.pid).toBeGreaterThan(0);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle status reports stale build and port conflict states", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_CONFLICT";

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const started = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    const pid = started.metadata?.pid;
    const serverPath = started.descriptor.serverPath;
    let originalServer = await readFile(serverPath, "utf8");
    await writeFile(serverPath, `${originalServer}\n// tampered\n`);
    const staleBuild = await getMcpStatus({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
      tokenEnv,
    });
    expect(staleBuild.state).toBe("stale-build");
    expect(staleBuild.staleReasons).toContain("server-file-sha256-mismatch");
    expect(formatMcpStatus(staleBuild)).toContain("reasons=server-file-sha256-mismatch");
    const restarted = await restartMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
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
      prismHome,
      tokenEnv,
    });
    expect(missingServer.state).toBe("stale-build");
    expect(missingServer.staleReasons).toContain("missing-server-file");

    const stopped = await stopMcp({
      pluginPath: pluginRoot,
      harness: "hermes",
      scope: "global",
      prismHome,
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
        prismHome,
        tokenEnv,
      });
      expect(conflict.state).toBe("port-conflict");
      const stopConflict = await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      });
      expect(stopConflict.state).toBe("already-stopped");
      const recoveredFromConflict = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
      try {
        expect(recoveredFromConflict.state).toBe("started");
        expect(recoveredFromConflict.metadata?.port).toBeGreaterThan(0);
        expect(recoveredFromConflict.metadata?.port).not.toBe(stopped.metadata?.port);
      } finally {
        await stopMcp({
          pluginPath: pluginRoot,
          harness: "hermes",
          scope: "global",
          prismHome,
          tokenEnv,
        }).catch(() => undefined);
      }
    } finally {
      await closeServer(dummy);
    }

    const recovered = await restartMcp(serveOptions(pluginRoot, prismHome, tokenEnv));
    try {
      expect(recovered.state).toBe("started");
      expect(recovered.metadata?.pid).toBeGreaterThan(0);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "hermes",
        scope: "global",
        prismHome,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 15_000);

test("MCP lifecycle rotates tokens only through the explicit rotation path", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_ROTATE";
  const firstToken = "prism-lifecycle-first-token-with-enough-entropy";
  const secondToken = "prism-lifecycle-second-token-with-enough-entropy";

  await withTokenEnv(tokenEnv, firstToken, async () => {
    const codexServeOptions = {
      ...serveOptions(pluginRoot, prismHome, tokenEnv),
      harness: "codex-cli" as const,
    };
    delete process.env[tokenEnv];
    await expect(serveMcp(codexServeOptions)).rejects.toThrow(/must be set to a usable bearer token/);

    process.env[tokenEnv] = firstToken;
    const started = await serveMcp(codexServeOptions);
    try {
      const firstHash = started.metadata?.tokenSha256;
      expect(firstHash).toBeDefined();

      const stable = await restartMcp(codexServeOptions);
      const stableHash = stable.metadata?.tokenSha256;
      expect(stableHash).toBe(firstHash);

      process.env[tokenEnv] = secondToken;
      const rotated = await rotateMcpBearerToken({
        pluginPath: pluginRoot,
        harness: "codex-cli",
        scope: "global",
        prismHome,
        tokenEnv,
      });
      expect(rotated.state).toBe("rotated-and-restarted");
      expect(rotated.tokenSha256).not.toBe(firstHash);
      expect(rotated.metadata?.tokenSha256).toBe(rotated.tokenSha256);

      await expect(
        rotateMcpBearerToken({
          pluginPath: pluginRoot,
          harness: "hermes",
          scope: "global",
          prismHome,
          tokenEnv,
        }),
      ).rejects.toThrow(/disabled until that harness renders HTTP bearer tokens/);
    } finally {
      await stopMcp({
        pluginPath: pluginRoot,
        harness: "codex-cli",
        scope: "global",
        prismHome,
        tokenEnv,
      }).catch(() => undefined);
    }
  });
}, 20_000);

test("MCP lifecycle serve fails typed when the compiled canonical bundle is missing", async () => {
  const { pluginRoot, prismHome } = await createHermesToolFixture();
  const tokenEnv = "PRISM_MCP_TEST_TOKEN_MISSING_BUNDLE";
  await rm(join(prismHome, "runtime", "mcp", "hermes-tools", "server.mjs"));

  await withTokenEnv(tokenEnv, lifecycleTestToken, async () => {
    const failure = await serveMcp(serveOptions(pluginRoot, prismHome, tokenEnv)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect((failure as { _tag?: string })._tag).toBe("McpBundleMissingError");
    expect(String((failure as Error).message)).toContain(
      "Compiled MCP server bundle for plugin 'hermes-tools' is missing",
    );
    expect(String((failure as { hint?: string }).hint)).toContain("prism refresh");
  });
}, 15_000);
