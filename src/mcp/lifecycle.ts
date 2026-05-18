import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, open, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { getHarness, harnessSupportsProjectScope } from "../harnesses.js";
import { expandPath } from "../fs.js";
import type { HarnessId, HarnessScope } from "../types.js";
import { loadPlugin } from "../compile/load.js";
import { generateMcpServerBundle } from "../compile/mcp-bundle.js";
import type { PluginRegistry } from "../compile/registry.js";
import { bindingsFromCanonicalTools } from "../compile/tool-bindings.js";
import {
  assertMcpHttpTargetSupported,
  assertMcpTokenEnvName,
  assertPluginTargetsMcpTools,
  defaultMcpRuntimeRoot,
  generatedMcpServerName,
  isMcpTokenEnvName,
  isLoopbackMcpHost,
  resolveMcpRuntime,
  runtimeMcpServerDescriptor,
} from "../compile/mcp-runtime.js";
import {
  MCP_RUNTIME_METADATA_SCHEMA,
  computeFileSha256,
  detectMcpRuntimeStaleReasons,
  hashMcpRuntimeToken,
  parseMcpRuntimeHealth,
  readMcpRuntimeMetadata,
  sha256Hex,
  writeMcpRuntimeMetadata,
  type McpRuntimeHealth,
  type McpRuntimeMetadata,
  type McpRuntimeStaleReason,
} from "./runtime-metadata.js";
import { ensureMcpToken, normalizePreferredMcpBearerToken, readMcpToken } from "./token-store.js";
import {
  installLaunchAgent,
  launchAgentLabelForServer,
  stopLaunchAgent,
} from "./launchd.js";

export type McpLifecycleHarness = HarnessId;
export type McpPortSelection = "auto" | number;
export type McpDaemonState =
  | "running"
  | "stopped"
  | "missing-token"
  | "stale-pid"
  | "stale-build"
  | "stale-health"
  | "port-conflict";

export interface McpLifecycleCommonOptions {
  readonly pluginPath: string;
  readonly harness: McpLifecycleHarness;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  /** Override the Prism MCP runtime root. Defaults to ~/.config. */
  readonly root?: string;
}

export interface McpServeOptions extends McpLifecycleCommonOptions {
  readonly host?: string;
  readonly port?: McpPortSelection;
  readonly tokenEnv?: string;
  readonly foreground?: boolean;
  readonly launchAgent?: boolean;
  readonly startupTimeoutMs?: number;
}

export interface McpStatusOptions extends McpLifecycleCommonOptions {
  readonly tokenEnv?: string;
  readonly expectedServerSha256?: string;
}

export interface McpStopOptions extends McpLifecycleCommonOptions {
  readonly timeoutMs?: number;
  readonly tokenEnv?: string;
}

export interface McpRuntimeDescriptor {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly harnessRoot: string;
  readonly serverName: string;
  readonly serverPath: string;
  readonly runtimePath: string;
}

export interface McpPreparedServer {
  readonly descriptor: McpRuntimeDescriptor;
  readonly host: string;
  readonly port: number;
  readonly tokenEnv: string;
  readonly token: string;
  readonly tokenSha256: string;
  readonly serverSha256: string;
  readonly mcpUrl: string;
  readonly healthUrl: string;
  readonly toolNames: ReadonlyArray<string>;
}

export interface McpServeResult {
  readonly state: "started" | "already-running" | "foreground-exited";
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata?: McpRuntimeMetadata;
  readonly health?: McpRuntimeHealth;
}

export interface McpStatusResult {
  readonly state: McpDaemonState;
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata?: McpRuntimeMetadata;
  readonly health?: McpRuntimeHealth;
  readonly staleReasons: ReadonlyArray<McpRuntimeStaleReason>;
  readonly detail: string;
}

export interface McpStopResult {
  readonly state: "stopped" | "already-stopped";
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata?: McpRuntimeMetadata;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_WAIT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 120_000;
const execFileAsync = promisify(execFile);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const generatedMcpServerFile = (harnessRoot: string, pluginName: string): string =>
  runtimeMcpServerDescriptor(harnessRoot, pluginName).absolutePath;

const runtimeFileForServer = (serverPath: string): string => join(dirname(serverPath), "runtime.json");
const lifecycleLockPathForServer = (serverPath: string): string =>
  join(dirname(serverPath), ".lifecycle.lock");

const positiveNumberEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const lockErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
};

const acquireMcpServerLock = async (
  descriptor: McpRuntimeDescriptor,
): Promise<{ readonly path: string }> => {
  const lockPath = lifecycleLockPathForServer(descriptor.serverPath);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      serverName: descriptor.serverName,
      createdAt: new Date().toISOString(),
    })}\n`);
  } finally {
    await handle.close();
  }
  return { path: lockPath };
};

const lockIsStale = async (lockPath: string): Promise<boolean> => {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= positiveNumberEnv("PRISM_MCP_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS)) {
      return false;
    }
    const content = await readFile(lockPath, "utf8").catch(() => "");
    const parsed = JSON.parse(content || "{}") as { readonly pid?: unknown };
    return typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || !processIsRunning(parsed.pid);
  } catch (error) {
    if (lockErrorCode(error) === "ENOENT") return true;
    if (error instanceof SyntaxError) return true;
    throw error;
  }
};

const withMcpServerLock = async <A>(
  descriptor: McpRuntimeDescriptor,
  operation: () => Promise<A>,
): Promise<A> => {
  const lockPath = lifecycleLockPathForServer(descriptor.serverPath);
  const deadline = Date.now() + positiveNumberEnv("PRISM_MCP_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS);
  while (true) {
    let lock: { readonly path: string } | undefined;
    try {
      lock = await acquireMcpServerLock(descriptor);
    } catch (error) {
      if (lockErrorCode(error) !== "EEXIST") throw error;
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
    }

    if (lock) {
      try {
        return await operation();
      } finally {
        await rm(lock.path, { force: true }).catch(() => undefined);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for MCP lifecycle lock for '${descriptor.serverName}'.`);
    }
    await delay(100);
  }
};

const assertSupportedLifecycleTarget = (options: McpLifecycleCommonOptions): void => {
  assertMcpHttpTargetSupported(options.harness, "lifecycle");

  const harness = getHarness(options.harness);
  if (options.scope === "project" && !harnessSupportsProjectScope(harness) && !options.root) {
    throw new Error(`${harness.name} MCP lifecycle does not support project scope.`);
  }
};

const resolveLifecycleHarnessRoot = (options: McpLifecycleCommonOptions): string => {
  if (options.root) return expandPath(options.root);
  return defaultMcpRuntimeRoot();
};

const loadRegistry = async (pluginPath: string): Promise<PluginRegistry> =>
  Effect.runPromise(loadPlugin(expandPath(pluginPath)));

const descriptorForRegistry = (options: {
  readonly pluginPath: string;
  readonly registry: PluginRegistry;
  readonly harnessRoot: string;
}): McpRuntimeDescriptor => {
  const serverName = generatedMcpServerName(options.registry.pluginName);
  const serverPath = generatedMcpServerFile(options.harnessRoot, options.registry.pluginName);
  return {
    pluginPath: resolve(options.pluginPath),
    pluginName: options.registry.pluginName,
    pluginVersion: options.registry.pluginVersion,
    harnessRoot: options.harnessRoot,
    serverName,
    serverPath,
    runtimePath: runtimeFileForServer(serverPath),
  };
};

const resolveLifecycleContext = async (
  options: McpLifecycleCommonOptions,
): Promise<{ readonly registry: PluginRegistry; readonly descriptor: McpRuntimeDescriptor }> => {
  assertSupportedLifecycleTarget(options);
  const pluginPath = expandPath(options.pluginPath);
  const registry = await loadRegistry(pluginPath);
  const harnessRoot = resolveLifecycleHarnessRoot(options);
  return { registry, descriptor: descriptorForRegistry({ pluginPath, registry, harnessRoot }) };
};

const assertLoopbackHost = (host: string): void => {
  if (!isLoopbackMcpHost(host)) {
    throw new Error("Prism MCP lifecycle only serves loopback HTTP hosts.");
  }
};

const resolvePort = async (
  selection: McpPortSelection | undefined,
  registry: PluginRegistry,
  targetId: HarnessId,
  host: string,
): Promise<number> => {
  const configured = resolveMcpRuntime(registry, targetId).port;
  const selected = selection ?? configured ?? "auto";
  if (selected === "auto") return getFreePort(host);
  if (!Number.isInteger(selected) || selected <= 0 || selected > 65535) {
    throw new Error("--port must be 'auto' or an integer from 1 to 65535.");
  }
  return selected;
};

const getFreePort = (host: string): Promise<number> =>
  new Promise((resolvePortValue, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate TCP port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePortValue(port));
    });
  });

const isPortAvailable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });

const pidIsRunning = processIsRunning;

const waitForPidExit = async (pid: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsRunning(pid)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for MCP daemon pid ${pid} to stop.`);
};

const terminatePid = async (
  pid: number,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> => {
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
  await waitForPidExit(pid, timeoutMs);
};

const bunCommand = (): string =>
  /(?:^|[/\\])bun(?:\.exe)?$/iu.test(process.execPath) ? process.execPath : "bun";

const buildServerBundle = async (options: {
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly descriptor: McpRuntimeDescriptor;
  readonly host: string;
  readonly port: number;
  readonly tokenEnv: string;
}): Promise<{ readonly content: string; readonly serverSha256: string; readonly toolNames: ReadonlyArray<string> }> => {
  assertPluginTargetsMcpTools(options.registry, options.targetId);
  const bundle = await generateMcpServerBundle({
    sourcePluginName: options.registry.pluginName,
    sourcePluginRoot: options.registry.pluginPath,
    dependencyPluginRoots: Object.entries(options.registry.dependencyPaths),
    serverName: options.descriptor.serverName,
    version: options.registry.pluginVersion,
    bundleId: options.descriptor.serverName,
    transport: "streamable-http",
    http: {
      host: options.host,
      port: options.port,
      tokenEnv: options.tokenEnv,
    },
    bindings: bindingsFromCanonicalTools(
      options.registry.pluginName,
      [...options.registry.tools.values()].sort((left, right) => left.name.localeCompare(right.name)),
    ),
  });
  return {
    content: bundle.content,
    serverSha256: sha256Hex(bundle.content),
    toolNames: bundle.toolNames,
  };
};

const writeServerBundle = async (
  descriptor: McpRuntimeDescriptor,
  content: string,
): Promise<void> => {
  await mkdir(dirname(descriptor.serverPath), { recursive: true });
  await writeFile(descriptor.serverPath, content);
};

const snapshotServerBundle = async (
  descriptor: McpRuntimeDescriptor,
): Promise<string | undefined> =>
  (await fileExists(descriptor.serverPath))
    ? await readFile(descriptor.serverPath, "utf8")
    : undefined;

const restoreServerBundle = async (
  descriptor: McpRuntimeDescriptor,
  previousContent: string | undefined,
): Promise<void> => {
  if (previousContent === undefined) {
    await rm(descriptor.serverPath, { force: true });
    return;
  }
  await writeServerBundle(descriptor, previousContent);
};

const currentServerHash = async (descriptor: McpRuntimeDescriptor): Promise<string | undefined> =>
  (await fileExists(descriptor.serverPath)) ? computeFileSha256(descriptor.serverPath) : undefined;

const readRuntimeMetadataIfPresent = async (
  descriptor: McpRuntimeDescriptor,
): Promise<McpRuntimeMetadata | undefined> =>
  (await fileExists(descriptor.runtimePath))
    ? await readMcpRuntimeMetadata(descriptor.runtimePath)
    : undefined;

const tokenForEnv = (tokenEnv: string): string | undefined => process.env[tokenEnv];

const resolveTokenForServer = async (options: {
  readonly descriptor: McpRuntimeDescriptor;
  readonly tokenEnv?: string;
  readonly create: boolean;
}): Promise<string | undefined> => {
  const envToken = options.tokenEnv && isMcpTokenEnvName(options.tokenEnv)
    ? tokenForEnv(options.tokenEnv)
    : undefined;
  if (options.create) {
    return ensureMcpToken(options.descriptor.harnessRoot, options.descriptor.serverName, {
      ...(envToken ? { preferredToken: envToken } : {}),
      ...(options.tokenEnv ? { preferredTokenEnv: options.tokenEnv } : {}),
    });
  }
  return normalizePreferredMcpBearerToken({
    preferredToken: envToken,
    preferredTokenEnv: options.tokenEnv,
  }) ?? readMcpToken(options.descriptor.harnessRoot, options.descriptor.serverName);
};

const fetchHealth = async (
  healthUrl: string | undefined,
  token: string,
): Promise<McpRuntimeHealth | undefined> => {
  if (!healthUrl) return undefined;
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    return parseMcpRuntimeHealth(await response.json());
  } catch {
    return undefined;
  }
};

const trustedHealthUrl = (metadata: McpRuntimeMetadata): {
  readonly url?: string;
  readonly reason?: McpRuntimeStaleReason;
} => {
  if (!metadata.host || !isLoopbackMcpHost(metadata.host)) {
    return { reason: "metadata-host-non-loopback" };
  }
  if (!metadata.port) return { reason: "missing-runtime-port" };
  return { url: `http://${metadata.host}:${metadata.port}/healthz` };
};

const pidCommand = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    return command.length > 0 ? command : undefined;
  } catch {
    return undefined;
  }
};

const commandLooksLikeGeneratedServer = (command: string, serverPath: string): boolean =>
  /(?:^|\s)(?:\S*[/\\])?bun(?:\.exe)?(?:\s|$)/iu.test(command) &&
  command.trimEnd().endsWith(serverPath);

const pidCommandReason = async (
  descriptor: McpRuntimeDescriptor,
  metadata: McpRuntimeMetadata,
): Promise<McpRuntimeStaleReason | undefined> => {
  if (!metadata.pid) return undefined;
  const command = await pidCommand(metadata.pid);
  if (!command) return "missing-pid-command";
  return commandLooksLikeGeneratedServer(command, descriptor.serverPath)
    ? undefined
    : "pid-command-mismatch";
};

const listenerPidsFromLsof = async (port: number): Promise<ReadonlyArray<number>> => {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    return [...new Set(stdout
      .split("\n")
      .map((line) => line.startsWith("p") ? Number(line.slice(1)) : undefined)
      .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0))];
  } catch {
    return [];
  }
};

const tcpListenSocketInodesForPort = async (path: string, port: number): Promise<Set<string>> => {
  const inodes = new Set<string>();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return inodes;
  }

  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of content.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 10) continue;
    const localAddress = columns[1];
    const state = columns[3];
    const inode = columns[9];
    if (!localAddress || !state || !inode) continue;
    const actualPort = localAddress.split(":").at(-1)?.toUpperCase();
    if (state === "0A" && actualPort === expectedPort && inode) {
      inodes.add(inode);
    }
  }
  return inodes;
};

const listenerPidsFromProc = async (port: number): Promise<ReadonlyArray<number>> => {
  const [tcpInodes, tcp6Inodes] = await Promise.all([
    tcpListenSocketInodesForPort("/proc/net/tcp", port),
    tcpListenSocketInodesForPort("/proc/net/tcp6", port),
  ]);
  const inodes = new Set([...tcpInodes, ...tcp6Inodes]);
  if (inodes.size === 0) return [];

  const procEntries = await readdir("/proc", { withFileTypes: true }).catch(() => []);

  const pids = new Set<number>();
  await Promise.all(procEntries.map(async (entry) => {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return;
    const pid = Number(entry.name);
    const fdEntries = await readdir(join("/proc", entry.name, "fd"), { withFileTypes: true })
      .catch(() => []);
    for (const fd of fdEntries) {
      try {
        const target = await readlink(join("/proc", entry.name, "fd", fd.name));
        const match = /^socket:\[(\d+)\]$/u.exec(target);
        const inode = match?.[1];
        if (inode && inodes.has(inode)) {
          pids.add(pid);
          return;
        }
      } catch {
        // Processes and file descriptors can disappear while scanning /proc.
      }
    }
  }));

  return [...pids];
};

const listenerPidsForPort = async (port: number): Promise<ReadonlyArray<number>> => {
  const lsofPids = await listenerPidsFromLsof(port);
  if (lsofPids.length > 0) return lsofPids;
  return listenerPidsFromProc(port);
};

const listenerPidReason = async (
  metadata: McpRuntimeMetadata,
): Promise<McpRuntimeStaleReason | undefined> => {
  if (!metadata.pid || !metadata.port) return undefined;
  const pids = await listenerPidsForPort(metadata.port);
  if (pids.length === 0) return "missing-listener-pid";
  return pids.includes(metadata.pid) ? undefined : "listener-pid-mismatch";
};

const uniqueStaleReasons = (
  reasons: ReadonlyArray<McpRuntimeStaleReason>,
): ReadonlyArray<McpRuntimeStaleReason> => [...new Set(reasons)];

const hasUnsafePidReason = (reasons: ReadonlyArray<McpRuntimeStaleReason>): boolean =>
  reasons.includes("missing-pid-command") ||
  reasons.includes("pid-command-mismatch") ||
  reasons.includes("missing-listener-pid") ||
  reasons.includes("listener-pid-mismatch");

const hasStalePidReason = (reasons: ReadonlyArray<McpRuntimeStaleReason>): boolean =>
  reasons.includes("pid-not-running") ||
  reasons.includes("missing-pid");

const hasStaleBuildReason = (reasons: ReadonlyArray<McpRuntimeStaleReason>): boolean =>
  reasons.includes("server-sha256-mismatch") ||
  reasons.includes("missing-server-sha256") ||
  reasons.includes("missing-server-file") ||
  reasons.includes("server-file-sha256-mismatch") ||
  reasons.includes("health-server-sha256-mismatch") ||
  reasons.includes("missing-health-server-sha256");

const metadataForPreparedServer = (
  prepared: McpPreparedServer,
  pid: number,
  health: McpRuntimeHealth,
): McpRuntimeMetadata => ({
  schema: MCP_RUNTIME_METADATA_SCHEMA,
  serverName: prepared.descriptor.serverName,
  transport: "streamable-http",
  host: prepared.host,
  port: prepared.port,
  pid,
  tokenEnv: prepared.tokenEnv,
  tokenSha256: prepared.tokenSha256,
  serverSha256: prepared.serverSha256,
  startedAt: health.startedAt,
  healthUrl: prepared.healthUrl,
  mcpUrl: prepared.mcpUrl,
});

const stoppedMetadata = (metadata: McpRuntimeMetadata): McpRuntimeMetadata => ({
  schema: MCP_RUNTIME_METADATA_SCHEMA,
  serverName: metadata.serverName,
  transport: metadata.transport,
  ...(metadata.host ? { host: metadata.host } : {}),
  ...(metadata.port ? { port: metadata.port } : {}),
  ...(metadata.tokenEnv ? { tokenEnv: metadata.tokenEnv } : {}),
  ...(metadata.tokenSha256 ? { tokenSha256: metadata.tokenSha256 } : {}),
  ...(metadata.serverSha256 ? { serverSha256: metadata.serverSha256 } : {}),
  ...(metadata.healthUrl ? { healthUrl: metadata.healthUrl } : {}),
  ...(metadata.mcpUrl ? { mcpUrl: metadata.mcpUrl } : {}),
});

const daemonEnv = (prepared: McpPreparedServer): NodeJS.ProcessEnv => ({
  ...process.env,
  [prepared.tokenEnv]: prepared.token,
  PRISM_MCP_SERVER_NAME: prepared.descriptor.serverName,
  PRISM_MCP_WORKING_DIRECTORY: prepared.descriptor.harnessRoot,
  PRISM_MCP_REPO_ROOT: prepared.descriptor.harnessRoot,
  PRISM_MCP_HTTP_HOST: prepared.host,
  PRISM_MCP_HTTP_PORT: String(prepared.port),
  PRISM_MCP_HTTP_PATH: "/mcp",
  PRISM_MCP_HTTP_HEALTH_PATH: "/healthz",
  PRISM_MCP_SERVER_SHA256: prepared.serverSha256,
});

const waitForHealth = async (
  prepared: McpPreparedServer,
  pid: number | undefined,
  timeoutMs: number,
): Promise<McpRuntimeHealth> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const health = await fetchHealth(
        prepared.healthUrl,
        prepared.token,
      );
      if (
        health &&
        (pid === undefined || health.pid === pid) &&
        health.serverName === prepared.descriptor.serverName &&
        health.serverSha256 === prepared.serverSha256
      ) {
        return health;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(
    `MCP server '${prepared.descriptor.serverName}' did not become healthy at ${prepared.healthUrl}: ${
      lastError instanceof Error ? lastError.message : "timed out"
    }`,
  );
};

const spawnServerProcess = (
  prepared: McpPreparedServer,
  options: { readonly foreground: boolean },
): ChildProcess => {
  const child = spawn(bunCommand(), [prepared.descriptor.serverPath], {
    cwd: prepared.descriptor.harnessRoot,
    env: daemonEnv(prepared),
    detached: !options.foreground,
    stdio: options.foreground ? "inherit" : "ignore",
  });

  if (!child.pid) {
    throw new Error("Failed to start MCP server process.");
  }
  if (!options.foreground) child.unref();
  return child;
};

const waitForChildExit = (
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });

const spawnDaemon = (prepared: McpPreparedServer): number => {
  const child = spawnServerProcess(prepared, { foreground: false });
  return child.pid!;
};

const launchdEnvironment = (prepared: McpPreparedServer): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  [prepared.tokenEnv]: prepared.token,
  PRISM_MCP_SERVER_NAME: prepared.descriptor.serverName,
  PRISM_MCP_WORKING_DIRECTORY: prepared.descriptor.harnessRoot,
  PRISM_MCP_REPO_ROOT: prepared.descriptor.harnessRoot,
  PRISM_MCP_HTTP_HOST: prepared.host,
  PRISM_MCP_HTTP_PORT: String(prepared.port),
  PRISM_MCP_HTTP_PATH: "/mcp",
  PRISM_MCP_HTTP_HEALTH_PATH: "/healthz",
  PRISM_MCP_SERVER_SHA256: prepared.serverSha256,
});

const shouldUseLaunchAgent = (options: McpServeOptions): boolean =>
  process.platform === "darwin" &&
  options.foreground !== true &&
  options.launchAgent !== false &&
  process.env.PRISM_MCP_DISABLE_LAUNCHD !== "1" &&
  (options.root === undefined || resolve(expandPath(options.root)) === resolve(defaultMcpRuntimeRoot()));

const startLaunchAgent = async (
  prepared: McpPreparedServer,
): Promise<void> => {
  const label = launchAgentLabelForServer(prepared.descriptor.serverName);
  const logRoot = join(prepared.descriptor.harnessRoot, "prism", "logs");
  await installLaunchAgent({
    label,
    programArguments: [bunCommand(), prepared.descriptor.serverPath],
    workingDirectory: prepared.descriptor.harnessRoot,
    environment: launchdEnvironment(prepared),
    standardOutPath: join(logRoot, `${prepared.descriptor.serverName}.out.log`),
    standardErrorPath: join(logRoot, `${prepared.descriptor.serverName}.err.log`),
  });
};

const classifyStatus = async (options: {
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata?: McpRuntimeMetadata;
  readonly expectedServerSha256?: string;
  readonly tokenEnv?: string;
  readonly token?: string;
}): Promise<McpStatusResult> => {
  const { descriptor, metadata } = options;
  if (!metadata) {
    return {
      state: "stopped",
      descriptor,
      staleReasons: [],
      detail: "runtime metadata is missing",
    };
  }

  if (!metadata.pid) {
    const staleReasons = metadata.host && !isLoopbackMcpHost(metadata.host)
      ? (["metadata-host-non-loopback"] as const)
      : [];
    if (
      metadata.host &&
      isLoopbackMcpHost(metadata.host) &&
      metadata.port &&
      !(await isPortAvailable(metadata.host, metadata.port))
    ) {
      return {
        state: "port-conflict",
        descriptor,
        metadata,
        staleReasons,
        detail: `port ${metadata.port} is occupied but no Prism pid is recorded`,
      };
    }
    return {
      state: "stopped",
      descriptor,
      metadata,
      staleReasons,
      detail: staleReasons.length > 0
        ? "runtime metadata is present but no daemon pid is recorded and host is not loopback"
        : "runtime metadata is present but no daemon pid is recorded",
    };
  }

  const currentHash = await currentServerHash(descriptor);
  const expectedServerSha256 = options.expectedServerSha256 ?? metadata.serverSha256 ?? currentHash;
  const healthTarget = trustedHealthUrl(metadata);
  const pidReason = await pidCommandReason(descriptor, metadata);
  const listenerReason = await listenerPidReason(metadata);
  const localStaleReasons = uniqueStaleReasons([
    ...detectMcpRuntimeStaleReasons(metadata, {
      requireLivePid: true,
      requireHealth: false,
      expectedServerSha256,
    }),
    ...(healthTarget.reason ? [healthTarget.reason] : []),
    ...(pidReason ? [pidReason] : []),
    ...(listenerReason ? [listenerReason] : []),
    ...(expectedServerSha256 && currentHash === undefined
      ? (["missing-server-file"] as const)
      : []),
    ...(expectedServerSha256 && currentHash !== undefined && currentHash !== expectedServerSha256
      ? (["server-file-sha256-mismatch"] as const)
      : []),
  ]);

  if (hasStalePidReason(localStaleReasons)) {
    return {
      state: "stale-pid",
      descriptor,
      metadata,
      staleReasons: localStaleReasons,
      detail: "recorded pid is not running",
    };
  }

  if (hasStaleBuildReason(localStaleReasons)) {
    return {
      state: "stale-build",
      descriptor,
      metadata,
      staleReasons: localStaleReasons,
      detail: "runtime server hash does not match the generated bundle",
    };
  }

  if (
    localStaleReasons.includes("missing-pid-command") ||
    localStaleReasons.includes("pid-command-mismatch") ||
    localStaleReasons.includes("missing-listener-pid") ||
    localStaleReasons.includes("listener-pid-mismatch") ||
    localStaleReasons.includes("metadata-host-non-loopback") ||
    localStaleReasons.includes("missing-runtime-port")
  ) {
    return {
      state: "stale-health",
      descriptor,
      metadata,
      staleReasons: localStaleReasons,
      detail: `runtime ownership or endpoint mismatch: ${localStaleReasons.join(", ")}`,
    };
  }

  const tokenEnv = options.tokenEnv;
  const token = options.token;
  if (!token) {
    return {
      state: "missing-token",
      descriptor,
      metadata,
      staleReasons: localStaleReasons,
      detail: `missing token env '${tokenEnv ?? "(unknown)"}'`,
    };
  }

  const health = await fetchHealth(healthTarget.url, token);
  const staleReasons = uniqueStaleReasons([
    ...detectMcpRuntimeStaleReasons(metadata, {
      requireLivePid: true,
      expectedServerSha256,
      expectedTokenSha256: hashMcpRuntimeToken(token),
      health,
    }),
    ...localStaleReasons,
  ]);

  if (hasStalePidReason(staleReasons)) {
    return {
      state: "stale-pid",
      descriptor,
      metadata,
      health,
      staleReasons,
      detail: "recorded pid is not running",
    };
  }

  if (hasStaleBuildReason(staleReasons)) {
    return {
      state: "stale-build",
      descriptor,
      metadata,
      health,
      staleReasons,
      detail: "runtime server hash does not match the generated bundle",
    };
  }

  if (staleReasons.length > 0) {
    return {
      state: "stale-health",
      descriptor,
      metadata,
      health,
      staleReasons,
      detail: `runtime health mismatch: ${staleReasons.join(", ")}`,
    };
  }

  return {
    state: "running",
    descriptor,
    metadata,
    health,
    staleReasons,
    detail: `running at ${metadata.mcpUrl ?? preparedUrl(metadata)}`,
  };
};

const preparedUrl = (metadata: McpRuntimeMetadata): string =>
  metadata.host && metadata.port ? `http://${metadata.host}:${metadata.port}/mcp` : "(unknown url)";

const statusWithResolvedContext = async (
  options: McpStatusOptions,
  context: { readonly registry: PluginRegistry; readonly descriptor: McpRuntimeDescriptor },
): Promise<McpStatusResult> => {
  const { registry, descriptor } = context;
  const metadata = await readRuntimeMetadataIfPresent(descriptor);
  const tokenEnv = options.tokenEnv ?? resolveMcpRuntime(registry, options.harness).tokenEnv;
  const token = await resolveTokenForServer({
    descriptor,
    tokenEnv,
    create: false,
  });

  return classifyStatus({
    descriptor,
    metadata,
    expectedServerSha256: options.expectedServerSha256,
    tokenEnv,
    token,
  });
};

const statusWithExpectedBundle = async (options: McpStatusOptions): Promise<McpStatusResult> =>
  statusWithResolvedContext(options, await resolveLifecycleContext(options));

export const getMcpStatus = async (options: McpStatusOptions): Promise<McpStatusResult> =>
  statusWithExpectedBundle(options);

export const listMcpStatuses = async (
  options: Omit<McpLifecycleCommonOptions, "pluginPath"> & {
    readonly root?: string;
    readonly tokenEnv?: string;
  },
): Promise<ReadonlyArray<McpStatusResult>> => {
  assertSupportedLifecycleTarget({ ...options, pluginPath: "." });
  const harnessRoot = resolveLifecycleHarnessRoot({ ...options, pluginPath: "." });
  const mcpRoot = join(harnessRoot, "prism", "mcp");
  if (!(await fileExists(mcpRoot))) return [];
  const entries = await readdir(mcpRoot, { withFileTypes: true });
  const statuses: McpStatusResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const serverPath = join(mcpRoot, entry.name, "server.mjs");
    const runtimePath = join(mcpRoot, entry.name, "runtime.json");
    const metadata = await readRuntimeMetadataIfPresent({
      pluginPath: "",
      pluginName: entry.name,
      harnessRoot,
      serverName: entry.name,
      serverPath,
      runtimePath,
    });
    const descriptor: McpRuntimeDescriptor = {
      pluginPath: "",
      pluginName: entry.name,
      harnessRoot,
      serverName: metadata?.serverName ?? entry.name.replace(/^prism_generated_/u, "prism-generated-"),
      serverPath,
      runtimePath,
    };
    const tokenEnv = options.tokenEnv ?? metadata?.tokenEnv;
    const token = await resolveTokenForServer({
      descriptor,
      tokenEnv,
      create: false,
    });
    statuses.push(await classifyStatus({
      descriptor,
      metadata,
      expectedServerSha256: await currentServerHash(descriptor),
      tokenEnv,
      token,
    }));
  }
  return statuses;
};

const serveMcpResolved = async (
  options: McpServeOptions,
  context: { readonly registry: PluginRegistry; readonly descriptor: McpRuntimeDescriptor },
): Promise<McpServeResult> => {
  const { registry, descriptor } = context;
  const existing = await readRuntimeMetadataIfPresent(descriptor);
  const configured = resolveMcpRuntime(registry, options.harness);
  const host = options.host?.trim() || configured.host;
  assertLoopbackHost(host);
  const portSelection =
    (options.port === undefined || options.port === "auto") && existing?.port
      ? existing.port
      : options.port;
  const selectedPort = await resolvePort(portSelection, registry, options.harness, host);
  const tokenEnv = options.tokenEnv?.trim() || configured.tokenEnv;
  assertMcpTokenEnvName(tokenEnv);
  const token = await resolveTokenForServer({
    descriptor,
    tokenEnv,
    create: true,
  });
  if (!token) {
    throw new Error(`Missing required MCP bearer token for '${descriptor.serverName}'.`);
  }
  const bundle = await buildServerBundle({
    registry,
    targetId: options.harness,
    descriptor,
    host,
    port: selectedPort,
    tokenEnv,
  });
  const prepared: McpPreparedServer = {
    descriptor,
    host,
    port: selectedPort,
    tokenEnv,
    token,
    tokenSha256: hashMcpRuntimeToken(token),
    serverSha256: bundle.serverSha256,
    mcpUrl: `http://${host}:${selectedPort}/mcp`,
    healthUrl: `http://${host}:${selectedPort}/healthz`,
    toolNames: bundle.toolNames,
  };

  if (existing?.pid) {
    const status = await classifyStatus({
      descriptor,
      metadata: existing,
      expectedServerSha256: prepared.serverSha256,
      tokenEnv,
      token,
    });
    if (status.state === "running") {
      return {
        state: "already-running",
        descriptor,
        metadata: status.metadata,
        health: status.health,
      };
    }
    if (status.state === "stale-build") {
      await stopMcpResolved({
        pluginPath: options.pluginPath,
        harness: options.harness,
        scope: options.scope,
        projectPath: options.projectPath,
        root: options.root,
        tokenEnv,
      }, context);
    } else if (status.state !== "stale-pid") {
      throw new Error(
        `Recorded MCP daemon is ${status.state}; run 'prism mcp status' or 'prism mcp restart' (${status.detail}).`,
      );
    }
  }

  if (!(await isPortAvailable(host, selectedPort))) {
    throw new Error(`Port ${selectedPort} on ${host} is already in use.`);
  }

  const previousServerContent = await snapshotServerBundle(descriptor);
  await writeServerBundle(descriptor, bundle.content);

  if (options.foreground) {
    let child: ChildProcess;
    try {
      child = spawnServerProcess(prepared, { foreground: true });
    } catch (error) {
      await restoreServerBundle(descriptor, previousServerContent).catch(() => undefined);
      throw error;
    }
    // Bun, shims, and launchd can make the serving pid differ from the
    // immediate child pid; startup identity is proven by token + server hash.
    await waitForHealth(
      prepared,
      undefined,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    ).catch(async (error) => {
      child.kill("SIGTERM");
      await restoreServerBundle(descriptor, previousServerContent).catch(() => undefined);
      throw error;
    });
    const exit = await waitForChildExit(child);
    if (exit.code !== 0 && exit.signal === null) {
      throw new Error(`Foreground MCP server exited with code ${exit.code}`);
    }
    return { state: "foreground-exited", descriptor };
  }

  let pid: number | undefined;
  let health: McpRuntimeHealth;
  const useLaunchAgent = shouldUseLaunchAgent(options);
  try {
    if (useLaunchAgent) {
      await startLaunchAgent(prepared);
    } else {
      pid = spawnDaemon(prepared);
    }
  } catch (error) {
    await restoreServerBundle(descriptor, previousServerContent).catch(() => undefined);
    throw error;
  }
  try {
    // Bun, shims, and launchd can make the serving pid differ from the
    // immediate child pid; metadata records the health pid after startup.
    health = await waitForHealth(
      prepared,
      undefined,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
  } catch (error) {
    if (pid !== undefined) {
      await terminatePid(pid, "SIGTERM", DEFAULT_STOP_TIMEOUT_MS).catch(() => undefined);
    } else if (useLaunchAgent) {
      await stopLaunchAgent(launchAgentLabelForServer(prepared.descriptor.serverName)).catch(() => undefined);
    }
    await restoreServerBundle(descriptor, previousServerContent).catch(() => undefined);
    throw error;
  }
  const metadata = metadataForPreparedServer(prepared, health.pid, health);
  try {
    await writeMcpRuntimeMetadata(descriptor.runtimePath, metadata);
  } catch (error) {
    try {
      if (pid !== undefined) {
        await terminatePid(pid, "SIGTERM", DEFAULT_STOP_TIMEOUT_MS);
      } else if (useLaunchAgent) {
        await stopLaunchAgent(launchAgentLabelForServer(prepared.descriptor.serverName));
      }
      await restoreServerBundle(descriptor, previousServerContent);
    } catch (cleanupError) {
      throw new Error(
        `Failed to write MCP runtime metadata and failed to stop MCP daemon: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
    throw error;
  }
  return { state: "started", descriptor, metadata, health };
};

export const serveMcp = async (options: McpServeOptions): Promise<McpServeResult> => {
  const context = await resolveLifecycleContext(options);
  return withMcpServerLock(context.descriptor, () => serveMcpResolved(options, context));
};

const stopMcpResolved = async (
  options: McpStopOptions,
  context: { readonly registry: PluginRegistry; readonly descriptor: McpRuntimeDescriptor },
): Promise<McpStopResult> => {
  const status = await statusWithResolvedContext(options, context);
  const metadata = status.metadata;
  if (!metadata?.pid) {
    return { state: "already-stopped", descriptor: status.descriptor, metadata };
  }
  if (status.state === "stale-pid") {
    const next = stoppedMetadata(metadata);
    await writeMcpRuntimeMetadata(status.descriptor.runtimePath, next);
    return { state: "already-stopped", descriptor: status.descriptor, metadata: next };
  }
  if (hasUnsafePidReason(status.staleReasons)) {
    throw new Error(`Refusing to stop MCP daemon in state '${status.state}': ${status.detail}`);
  }
  if (!["running", "missing-token", "stale-build", "stale-health"].includes(status.state)) {
    throw new Error(`Refusing to stop MCP daemon in state '${status.state}': ${status.detail}`);
  }

  if (process.platform === "darwin") {
    await stopLaunchAgent(launchAgentLabelForServer(status.descriptor.serverName)).catch(() => undefined);
  }
  if (pidIsRunning(metadata.pid)) {
    await terminatePid(metadata.pid, "SIGTERM", options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  }
  const next = stoppedMetadata(metadata);
  await writeMcpRuntimeMetadata(status.descriptor.runtimePath, next);
  return { state: "stopped", descriptor: status.descriptor, metadata: next };
};

export const stopMcp = async (options: McpStopOptions): Promise<McpStopResult> => {
  const context = await resolveLifecycleContext(options);
  return withMcpServerLock(context.descriptor, () => stopMcpResolved(options, context));
};

export const restartMcp = async (options: McpServeOptions): Promise<McpServeResult> => {
  const context = await resolveLifecycleContext(options);
  return withMcpServerLock(context.descriptor, async () => {
    await stopMcpResolved(options, context).catch((error) => {
      if (error instanceof Error && error.message.includes("already-stopped")) return;
      throw error;
    });
    return serveMcpResolved(options, context);
  });
};

export const formatMcpStatus = (status: McpStatusResult): string => {
  const pid = status.metadata?.pid ? ` pid=${status.metadata.pid}` : "";
  const url = status.metadata?.mcpUrl ? ` url=${status.metadata.mcpUrl}` : "";
  const reasons = status.staleReasons.length > 0
    ? ` reasons=${status.staleReasons.join(",")}`
    : "";
  return `${status.state.padEnd(15)} ${status.descriptor.serverName}${pid}${url}${reasons} - ${status.detail}`;
};

export const formatMcpServeResult = (result: McpServeResult): string => {
  const metadata = result.metadata;
  const pid = metadata?.pid ? ` pid=${metadata.pid}` : "";
  const url = metadata?.mcpUrl ? ` url=${metadata.mcpUrl}` : "";
  return `${result.state} ${result.descriptor.serverName}${pid}${url}`;
};

export const formatMcpStopResult = (result: McpStopResult): string => {
  const pid = result.metadata?.pid ? ` pid=${result.metadata.pid}` : "";
  return `${result.state} ${result.descriptor.serverName}${pid}`;
};
