import { afterEach, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server as NetServer } from "node:net";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  formatMcpStatus,
  getMcpStatus,
  restartMcp,
  serveMcp,
  stopMcp,
} from "./lifecycle.js";
import { McpPortConflictError } from "../errors.js";
import {
  MCP_RUNTIME_METADATA_SCHEMA,
  computeFileSha256,
  parseMcpRuntimeHealth,
  writeMcpRuntimeMetadata,
} from "./runtime-metadata.js";
import { resolveBunExecutable } from "../bun-runtime.js";
import { createMinimalMcpPluginFixture, type MinimalMcpPluginFixture } from "../testing/mcp-fixture.js";
import { countPrismMcpProcessesUnder } from "../testing/mcp-process-cleanup.js";

const execFileAsync = promisify(execFile);
const fixtures: MinimalMcpPluginFixture[] = [];

const createFixture = async (): Promise<MinimalMcpPluginFixture> => {
  const fixture = await createMinimalMcpPluginFixture();
  fixtures.push(fixture);
  return fixture;
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.sandbox.cleanup().catch(() => undefined);
  }
});

const pidIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidExit = async (pid: number, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsRunning(pid)) return;
    await delay(100);
  }
  throw new Error(`pid ${pid} did not exit within ${timeoutMs}ms`);
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

const getFreePort = (host = "127.0.0.1"): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
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

const listenOnPort = (host: string, port: number): Promise<NetServer> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });

const closeServer = (server: NetServer): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const fetchHealth = async (port: number): Promise<ReturnType<typeof parseMcpRuntimeHealth>> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return parseMcpRuntimeHealth(await response.json());
    } catch {
      // Server not listening yet.
    }
    await delay(100);
  }
  throw new Error(`server on port ${port} did not become healthy`);
};

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
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countServerProcesses(serverPath)) === expected) return;
    await delay(100);
  }
  expect(await countServerProcesses(serverPath)).toBe(expected);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const rogueHealthServerScript = (options: {
  readonly serverName: string;
  readonly returnedSha256?: string;
  readonly returnedPid: number | "self";
}): string => {
  const returnedPid = options.returnedPid === "self" ? "process.pid" : String(options.returnedPid);
  const sha256Line =
    options.returnedSha256 !== undefined
      ? `const returnedSha256 = ${JSON.stringify(options.returnedSha256)};`
      : "const returnedSha256 = process.env.PRISM_MCP_SERVER_SHA256 ?? \"0\".repeat(64);";
  return `import { createServer } from "node:http";

const host = process.env.PRISM_MCP_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.PRISM_MCP_HTTP_PORT ?? "0");
const serverName = process.env.PRISM_MCP_SERVER_NAME ?? ${JSON.stringify(options.serverName)};
${sha256Line}
const returnedPid = ${returnedPid};

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      schema: "prism.mcp-health.v1",
      serverName,
      transport: "streamable-http",
      startedAt: new Date().toISOString(),
      uptimeMs: 1,
      pid: returnedPid,
      toolCount: 0,
      serverSha256: returnedSha256,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, host, () => {});
`;
};

const spawnServerScript = async (
  serverPath: string,
  env: Record<string, string>,
): Promise<{ readonly child: ChildProcess; readonly port: number }> => {
  const port = await getFreePort("127.0.0.1");
  const child = spawn(resolveBunExecutable(), [serverPath], {
    env: { ...process.env, ...env, PRISM_MCP_HTTP_PORT: String(port) },
    stdio: "ignore",
  });
  if (!child.pid) {
    child.kill();
    throw new Error("failed to spawn server script");
  }
  try {
    await fetchHealth(port);
  } catch (error) {
    child.kill("SIGTERM");
    await waitForPidExit(child.pid, 2_000).catch(() => undefined);
    throw error;
  }
  return { child, port };
};

test("MCP lifecycle serve → status → stop leaves no orphan process", async () => {
  const fixture = await createFixture();
  const started = await serveMcp(fixture.serveOptions());
  expect(started.state).toBe("started");
  expect(started.metadata?.pid).toBeGreaterThan(0);
  expect(started.metadata?.serverName).toBe(`prism-generated-${fixture.pluginName}`);
  await waitForServerProcessCount(fixture.serverPath, 1);

  const status = await getMcpStatus(fixture.statusOptions());
  expect(status.state).toBe("running");
  expect(status.health?.pid).toBe(started.metadata?.pid);
  expect(formatMcpStatus(status)).toContain(`pid=${started.metadata?.pid}`);

  const stopped = await stopMcp(fixture.stopOptions());
  expect(stopped.state).toBe("stopped");
  await waitForPidExit(started.metadata!.pid!);

  const afterStatus = await getMcpStatus(fixture.statusOptions());
  expect(afterStatus.state).toBe("stopped");
  await waitForServerProcessCount(fixture.serverPath, 0);
});

test("MCP lifecycle reaps temp-home daemon when the spawning parent exits", async () => {
  const fixture = await createFixture();
  const lifecycleModule = pathToFileURL(join(process.cwd(), "src", "mcp", "lifecycle.ts")).href;
  const script = `
const { serveMcp } = await import(${JSON.stringify(lifecycleModule)});
const result = await serveMcp(${JSON.stringify(fixture.serveOptions({ startupTimeoutMs: 5_000 }))});
console.log(JSON.stringify({ pid: result.metadata?.pid }));
`;

  const { stdout } = await execFileAsync(resolveBunExecutable(), ["--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_MCP_DISABLE_LAUNCHD: "1",
      PRISM_MCP_SUPERVISE_DAEMONS: "1",
    },
    timeout: 20_000,
    maxBuffer: 10_000_000,
  });
  const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { readonly pid?: number };
  expect(report.pid).toBeGreaterThan(0);
  await waitForPidExit(report.pid!, 5_000);
  await waitForServerProcessCount(fixture.serverPath, 0);
  expect(await countPrismMcpProcessesUnder(fixture.sandbox.root)).toBe(0);
}, 30_000);

test("MCP lifecycle restart stops the old pid and starts a new pid", async () => {
  const fixture = await createFixture();
  const first = await serveMcp(fixture.serveOptions());
  expect(first.state).toBe("started");
  const firstPid = first.metadata?.pid;
  expect(firstPid).toBeGreaterThan(0);

  const second = await restartMcp(fixture.serveOptions());
  expect(second.state).toBe("started");
  const secondPid = second.metadata?.pid;
  expect(secondPid).toBeGreaterThan(0);
  expect(secondPid).not.toBe(firstPid);

  await waitForPidExit(firstPid!);
  const status = await getMcpStatus(fixture.statusOptions());
  expect(status.state).toBe("running");
  expect(status.metadata?.pid).toBe(secondPid);

  await stopMcp(fixture.stopOptions());
  await waitForPidExit(secondPid!);
});

test("MCP lifecycle survives 50 sequential serve/stop cycles without process leaks", async () => {
  const fixture = await createFixture();
  const pids: number[] = [];

  for (let cycle = 0; cycle < 50; cycle += 1) {
    const started = await serveMcp(fixture.serveOptions());
    expect(started.state).toBe("started");
    const pid = started.metadata?.pid;
    expect(pid).toBeGreaterThan(0);
    pids.push(pid!);

    const running = await getMcpStatus(fixture.statusOptions());
    expect(running.state).toBe("running");

    const stopped = await stopMcp(fixture.stopOptions());
    expect(stopped.state).toBe("stopped");
    await waitForPidExit(pid!, 5_000);
  }

  for (const pid of pids) {
    expect(pidIsRunning(pid)).toBe(false);
  }
  await waitForServerProcessCount(fixture.serverPath, 0);
}, 120_000);

test("MCP lifecycle overwrites a stale lifecycle lock with a dead pid", async () => {
  const fixture = await createFixture();
  const lockDir = dirname(fixture.serverPath);
  const lockPath = join(lockDir, ".lifecycle.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: 99999999, serverName: fixture.pluginName, createdAt: new Date().toISOString() })}\n`,
  );

  await withEnv({ PRISM_MCP_LOCK_STALE_MS: "1" }, async () => {
    await delay(50);
    const started = await serveMcp(fixture.serveOptions());
    try {
      expect(started.state).toBe("started");
      expect(await pathExists(lockPath)).toBe(false);
    } finally {
      await stopMcp(fixture.stopOptions()).catch(() => undefined);
      if (started.metadata?.pid) await waitForPidExit(started.metadata.pid, 2_000).catch(() => undefined);
    }
  });
});

test("MCP lifecycle explicit port conflict fails closed with a typed error", async () => {
  const fixture = await createFixture();
  const port = await getFreePort("127.0.0.1");
  const occupant = await listenOnPort("127.0.0.1", port);
  try {
    const failure = await serveMcp(fixture.serveOptions({ port })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect((failure as { _tag?: string })._tag).toBe("McpPortConflictError");
    expect(failure).toBeInstanceOf(McpPortConflictError);
    expect((failure as Error).message).toContain(`Port ${port}`);
  } finally {
    await closeServer(occupant);
  }
});

test("MCP lifecycle serve rejects a server that returns the wrong sha256 in health", async () => {
  const fixture = await createFixture();
  await fixture.writeServerScript(
    rogueHealthServerScript({
      serverName: `prism-generated-${fixture.pluginName}`,
      returnedSha256: "f".repeat(64),
      returnedPid: "self",
    }),
  );

  const failure = await serveMcp(fixture.serveOptions({ startupTimeoutMs: 3_000 })).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeDefined();
  expect(String((failure as Error).message)).toMatch(/did not become healthy/i);
  await waitForServerProcessCount(fixture.serverPath, 0);
}, 15_000);

test("MCP lifecycle status reports stale-health when the health endpoint returns the wrong pid", async () => {
  const fixture = await createFixture();
  const serverName = `prism-generated-${fixture.pluginName}`;

  await fixture.writeServerScript(
    rogueHealthServerScript({
      serverName,
      returnedPid: 123456,
    }),
  );

  const serverSha256 = await computeFileSha256(fixture.serverPath);
  const { child, port } = await spawnServerScript(fixture.serverPath, {
    PRISM_MCP_SERVER_NAME: serverName,
    PRISM_MCP_SERVER_SHA256: serverSha256,
  });

  try {
    await writeMcpRuntimeMetadata(fixture.runtimePath, {
      schema: MCP_RUNTIME_METADATA_SCHEMA,
      serverName,
      transport: "streamable-http",
      host: "127.0.0.1",
      port,
      pid: child.pid!,
      serverSha256,
      startedAt: new Date().toISOString(),
      healthUrl: fixture.healthUrlFor(port),
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
    });

    const status = await getMcpStatus(fixture.statusOptions());
    expect(status.state).toBe("stale-health");
    expect(status.staleReasons).toContain("health-pid-mismatch");
    expect(status.health?.pid).toBe(123456);
  } finally {
    child.kill("SIGTERM");
    await waitForPidExit(child.pid!, 2_000).catch(() => undefined);
  }
});
