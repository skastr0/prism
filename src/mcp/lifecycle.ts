import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, open, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { getHarness, harnessSupportsProjectScope } from "../harnesses.js";
import { expandPath } from "../fs.js";
import { McpBundleMissingError, McpPortConflictError } from "../errors.js";
import type { HarnessId, HarnessScope } from "../types.js";
import { loadPlugin } from "../compile/load.js";
import type { PluginRegistry } from "../compile/registry.js";
import {
  assertMcpHttpTargetSupported,
  generatedMcpServerName,
  isLoopbackMcpHost,
  resolveMcpRuntime,
} from "../compile/mcp-runtime.js";
import {
  prismMcpRuntimeDir,
  prismMcpServerPath,
} from "../compile/mcp-runtime-path.js";
import {
  MCP_RUNTIME_METADATA_SCHEMA,
  computeFileSha256,
  detectMcpRuntimeStaleReasons,
  parseMcpRuntimeHealth,
  readMcpRuntimeMetadata,
  writeMcpRuntimeMetadata,
  type McpRuntimeHealth,
  type McpRuntimeMetadata,
  type McpRuntimeStaleReason,
} from "./runtime-metadata.js";
import {
  installLaunchAgent,
  launchAgentLabelForServer,
  stopLaunchAgent,
} from "./launchd.js";
import { getFreePort, isPortAvailable } from "./ports.js";
import { resolveBunExecutable } from "../bun-runtime.js";
import {
  registerSupervisorMcpDaemon,
  unregisterSupervisorMcpDaemon,
  unregisterSupervisorMcpDaemonsForServer,
} from "./supervisor.js";

export type McpLifecycleHarness = HarnessId;
export type McpPortSelection = "auto" | number;
export type McpDaemonState =
  | "running"
  | "stopped"
  | "stale-pid"
  | "stale-build"
  | "stale-health"
  | "port-conflict";

export interface McpLifecycleCommonOptions {
  readonly pluginPath: string;
  readonly harness: McpLifecycleHarness;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  /** Prism home directory, threaded from the CLI edge (no env fallback). */
  readonly prismHome: string;
}

export interface McpServeOptions extends McpLifecycleCommonOptions {
  readonly host?: string;
  readonly port?: McpPortSelection;
  readonly foreground?: boolean;
  readonly launchAgent?: boolean;
  readonly startupTimeoutMs?: number;
}

export interface McpStatusOptions extends McpLifecycleCommonOptions {
  readonly expectedServerSha256?: string;
}

export interface McpStopOptions extends McpLifecycleCommonOptions {
  readonly timeoutMs?: number;
}

export interface McpRuntimeDescriptor {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly prismHome: string;
  readonly serverName: string;
  readonly serverPath: string;
  readonly runtimePath: string;
}

export interface McpPreparedServer {
  readonly descriptor: McpRuntimeDescriptor;
  readonly host: string;
  readonly port: number;
  readonly serverSha256: string;
  readonly toolTimeoutMs: number;
  readonly mcpUrl: string;
  readonly healthUrl: string;
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

type McpLifecycleResolvedContext = {
  readonly registry: PluginRegistry;
  readonly descriptor: McpRuntimeDescriptor;
};

type McpStartedPreparedServer = {
  readonly pid?: number;
  readonly useLaunchAgent: boolean;
  readonly supervisorPid?: number;
  readonly health: McpRuntimeHealth;
};

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
  if (options.scope === "project" && !harnessSupportsProjectScope(harness)) {
    throw new Error(`${harness.name} MCP lifecycle does not support project scope.`);
  }
};

const loadRegistry = async (pluginPath: string): Promise<PluginRegistry> =>
  Effect.runPromise(loadPlugin(expandPath(pluginPath)));

const descriptorForRegistry = (options: {
  readonly pluginPath: string;
  readonly registry: PluginRegistry;
  readonly prismHome: string;
}): McpRuntimeDescriptor => {
  const serverName = generatedMcpServerName(options.registry.pluginName);
  const serverPath = prismMcpServerPath(options.prismHome, options.registry.pluginName);
  return {
    pluginPath: resolve(options.pluginPath),
    pluginName: options.registry.pluginName,
    pluginVersion: options.registry.pluginVersion,
    prismHome: options.prismHome,
    serverName,
    serverPath,
    runtimePath: runtimeFileForServer(serverPath),
  };
};

const resolveLifecycleContext = async (
  options: McpLifecycleCommonOptions,
): Promise<McpLifecycleResolvedContext> => {
  assertSupportedLifecycleTarget(options);
  const pluginPath = expandPath(options.pluginPath);
  const registry = await loadRegistry(pluginPath);
  const prismHome = expandPath(options.prismHome);
  return { registry, descriptor: descriptorForRegistry({ pluginPath, registry, prismHome }) };
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

// launchd's PATH resolution for non-system bins (mise, homebrew) is unreliable
// and silently fails with EX_CONFIG (78) before the program ever runs. Resolve
// bun to an absolute path so plists never depend on launchd's PATH lookup.
let cachedBunAbsolutePath: string | undefined;
const bunAbsolutePathForPlist = async (): Promise<string> => {
  if (cachedBunAbsolutePath) return cachedBunAbsolutePath;
  const fallback = resolveBunExecutable();
  if (fallback.startsWith("/")) {
    cachedBunAbsolutePath = fallback;
    return fallback;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["bun"]);
    const resolved = stdout.trim();
    if (resolved.startsWith("/")) {
      cachedBunAbsolutePath = resolved;
      return resolved;
    }
  } catch {
    // fall through to fallback
  }
  cachedBunAbsolutePath = fallback;
  return fallback;
};

/**
 * The lifecycle CONSUMES the compiled canonical bundle — it never builds or
 * rewrites bundles. Refresh (`prism refresh`) is the only
 * producer of `<PRISM_HOME>/runtime/mcp/<plugin>/server.mjs`.
 */
const readCanonicalServerBundleSha = async (
  descriptor: McpRuntimeDescriptor,
): Promise<string> => {
  if (!(await fileExists(descriptor.serverPath))) {
    throw new McpBundleMissingError({
      pluginName: descriptor.pluginName,
      bundlePath: descriptor.serverPath,
    });
  }
  return computeFileSha256(descriptor.serverPath);
};

const currentServerHash = async (descriptor: McpRuntimeDescriptor): Promise<string | undefined> =>
  (await fileExists(descriptor.serverPath)) ? computeFileSha256(descriptor.serverPath) : undefined;

const readRuntimeMetadataIfPresent = async (
  descriptor: McpRuntimeDescriptor,
): Promise<McpRuntimeMetadata | undefined> => {
  if (!(await fileExists(descriptor.runtimePath))) return undefined;
  try {
    return await readMcpRuntimeMetadata(descriptor.runtimePath);
  } catch {
    return undefined;
  }
};

const fetchHealth = async (
  healthUrl: string | undefined,
): Promise<McpRuntimeHealth | undefined> => {
  if (!healthUrl) return undefined;
  try {
    const response = await fetch(healthUrl, { method: "GET" });
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

const commandLooksLikeGeneratedServer = (command: string, serverPath: string): boolean => {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith(serverPath)) return false;
  return (
    /(?:^|\s)(?:\S*[/\\])?bun(?:\.exe)?(?:\s|$)/iu.test(command) ||
    /(?:^|\s)__mcp-server(?:\s|$)/u.test(command)
  );
};

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
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
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
          break;
        }
      } catch {
        // Processes and file descriptors can disappear while scanning /proc.
        continue;
      }
    }
  }

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

const listenerLooksLikeGeneratedServer = async (
  descriptor: McpRuntimeDescriptor,
  port: number,
): Promise<boolean> => {
  for (const pid of await listenerPidsForPort(port)) {
    const command = await pidCommand(pid);
    if (command && commandLooksLikeGeneratedServer(command, descriptor.serverPath)) {
      return true;
    }
  }
  return false;
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
  serverSha256: prepared.serverSha256,
  startedAt: health.startedAt,
  healthUrl: prepared.healthUrl,
  mcpUrl: prepared.mcpUrl,
});

const metadataWithAdoptedHealth = (options: {
  readonly metadata: McpRuntimeMetadata;
  readonly health: McpRuntimeHealth;
  readonly expectedServerSha256?: string;
}): McpRuntimeMetadata => ({
  schema: MCP_RUNTIME_METADATA_SCHEMA,
  serverName: options.metadata.serverName,
  transport: options.metadata.transport,
  ...(options.metadata.host ? { host: options.metadata.host } : {}),
  ...(options.metadata.port ? { port: options.metadata.port } : {}),
  pid: options.health.pid,
  ...(options.expectedServerSha256 ?? options.health.serverSha256 ?? options.metadata.serverSha256
    ? { serverSha256: options.expectedServerSha256 ?? options.health.serverSha256 ?? options.metadata.serverSha256 }
    : {}),
  startedAt: options.health.startedAt,
  ...(options.metadata.healthUrl ? { healthUrl: options.metadata.healthUrl } : {}),
  ...(options.metadata.mcpUrl ? { mcpUrl: options.metadata.mcpUrl } : {}),
});

const metadataSemanticallyEqual = (
  left: McpRuntimeMetadata | undefined,
  right: McpRuntimeMetadata | undefined,
): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const stoppedMetadata = (metadata: McpRuntimeMetadata): McpRuntimeMetadata => ({
  schema: MCP_RUNTIME_METADATA_SCHEMA,
  serverName: metadata.serverName,
  transport: metadata.transport,
  ...(metadata.host ? { host: metadata.host } : {}),
  ...(metadata.port ? { port: metadata.port } : {}),
  ...(metadata.serverSha256 ? { serverSha256: metadata.serverSha256 } : {}),
  ...(metadata.healthUrl ? { healthUrl: metadata.healthUrl } : {}),
  ...(metadata.mcpUrl ? { mcpUrl: metadata.mcpUrl } : {}),
});

/**
 * Daemon identity travels via spawn env (and launchd plist
 * EnvironmentVariables) — never via bundle bytes.
 */
const daemonIdentityEnv = (prepared: McpPreparedServer): Record<string, string> => ({
  PRISM_MCP_SERVER_NAME: prepared.descriptor.serverName,
  PRISM_MCP_WORKING_DIRECTORY: prepared.descriptor.prismHome,
  PRISM_MCP_REPO_ROOT: prepared.descriptor.prismHome,
  PRISM_MCP_HTTP_HOST: prepared.host,
  PRISM_MCP_HTTP_PORT: String(prepared.port),
  PRISM_MCP_HTTP_PATH: "/mcp",
  PRISM_MCP_HTTP_HEALTH_PATH: "/healthz",
  PRISM_MCP_TOOL_TIMEOUT_MS: String(prepared.toolTimeoutMs),
  PRISM_MCP_SERVER_SHA256: prepared.serverSha256,
});

const daemonEnv = (prepared: McpPreparedServer): NodeJS.ProcessEnv => ({
  ...process.env,
  ...daemonIdentityEnv(prepared),
});

const isCurrentProcessBun = (): boolean =>
  /(?:^|[/\\])bun(?:\.exe)?$/iu.test(process.execPath);

const serverProcessCommand = (
  serverPath: string,
): { readonly command: string; readonly args: readonly string[] } => {
  const bunExecutable = resolveBunExecutable();
  if (bunExecutable !== "bun" || isCurrentProcessBun()) {
    return { command: bunExecutable, args: [serverPath] };
  }
  return { command: process.execPath, args: ["__mcp-server", serverPath] };
};

const waitForHealth = async (
  prepared: McpPreparedServer,
  pid: number | undefined,
  timeoutMs: number,
): Promise<McpRuntimeHealth> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const health = await fetchHealth(prepared.healthUrl);
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
  const command = serverProcessCommand(prepared.descriptor.serverPath);
  const child = spawn(command.command, [...command.args], {
    cwd: prepared.descriptor.prismHome,
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
  child.once("exit", () => unregisterSupervisorMcpDaemon(child.pid));
  registerSupervisorMcpDaemon({
    pid: child.pid!,
    prismHome: prepared.descriptor.prismHome,
    serverName: prepared.descriptor.serverName,
    serverPath: prepared.descriptor.serverPath,
  });
  return child.pid!;
};

const unregisterSupervisorMcpDaemonsForDescriptor = (descriptor: McpRuntimeDescriptor): void => {
  unregisterSupervisorMcpDaemonsForServer({
    prismHome: descriptor.prismHome,
    serverName: descriptor.serverName,
    serverPath: descriptor.serverPath,
  });
};

const launchdEnvironment = (prepared: McpPreparedServer): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  ...daemonIdentityEnv(prepared),
});

/**
 * launchd is only eligible for the real user PRISM_HOME (~/.prism): sandboxed
 * homes (tests, acceptance gates) never touch launchctl — serve, stop, and
 * restart all share this predicate.
 */
const launchAgentEligible = (prismHome: string): boolean =>
  process.platform === "darwin" &&
  process.env.PRISM_MCP_DISABLE_LAUNCHD !== "1" &&
  resolve(expandPath(prismHome)) === resolve(join(homedir(), ".prism"));

const shouldUseLaunchAgent = (options: McpServeOptions): boolean =>
  options.foreground !== true &&
  options.launchAgent !== false &&
  launchAgentEligible(options.prismHome);

const startLaunchAgent = async (
  prepared: McpPreparedServer,
): Promise<void> => {
  const label = launchAgentLabelForServer(prepared.descriptor.serverName);
  const logRoot = join(prepared.descriptor.prismHome, "runtime", "logs");
  const bunPath = await bunAbsolutePathForPlist();
  await installLaunchAgent({
    label,
    programArguments: [bunPath, prepared.descriptor.serverPath],
    workingDirectory: prepared.descriptor.prismHome,
    environment: launchdEnvironment(prepared),
    standardOutPath: join(logRoot, `${prepared.descriptor.serverName}.out.log`),
    standardErrorPath: join(logRoot, `${prepared.descriptor.serverName}.err.log`),
  });
};

const runningStatus = (options: {
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata: McpRuntimeMetadata;
  readonly health?: McpRuntimeHealth;
}): McpStatusResult => ({
  state: "running",
  descriptor: options.descriptor,
  metadata: options.metadata,
  ...(options.health ? { health: options.health } : {}),
  staleReasons: [],
  detail: `running at ${options.metadata.mcpUrl ?? preparedUrl(options.metadata)}`,
});

const tryAdoptHealthyGeneratedListener = async (options: {
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata: McpRuntimeMetadata;
  readonly expectedServerSha256?: string;
  readonly healthUrl?: string;
}): Promise<McpStatusResult | undefined> => {
  const { descriptor, metadata } = options;
  if (!options.healthUrl || !metadata.port) return undefined;
  if (!(await listenerLooksLikeGeneratedServer(descriptor, metadata.port))) return undefined;

  const health = await fetchHealth(options.healthUrl);
  if (!health) return undefined;

  const adopted = metadataWithAdoptedHealth({
    metadata,
    health,
    expectedServerSha256: options.expectedServerSha256,
  });
  const staleReasons = uniqueStaleReasons(
    detectMcpRuntimeStaleReasons(adopted, {
      requireLivePid: true,
      expectedServerSha256: options.expectedServerSha256,
      health,
    }),
  );
  return staleReasons.length === 0
    ? runningStatus({ descriptor, metadata: adopted, health })
    : undefined;
};

const classifyStatus = async (options: {
  readonly descriptor: McpRuntimeDescriptor;
  readonly metadata?: McpRuntimeMetadata;
  readonly expectedServerSha256?: string;
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

  const currentHash = await currentServerHash(descriptor);
  const expectedServerSha256 = options.expectedServerSha256 ?? metadata.serverSha256 ?? currentHash;
  const healthTarget = trustedHealthUrl(metadata);

  if (!metadata.pid) {
    const staleReasons = uniqueStaleReasons([
      ...detectMcpRuntimeStaleReasons(metadata, {
        requireLivePid: true,
        requireHealth: false,
        expectedServerSha256,
      }),
      ...(healthTarget.reason ? [healthTarget.reason] : []),
      ...(expectedServerSha256 && currentHash === undefined
        ? (["missing-server-file"] as const)
        : []),
      ...(expectedServerSha256 && currentHash !== undefined && currentHash !== expectedServerSha256
        ? (["server-file-sha256-mismatch"] as const)
        : []),
    ]);
    if (
      metadata.host &&
      isLoopbackMcpHost(metadata.host) &&
      metadata.port &&
      !(await isPortAvailable(metadata.host, metadata.port))
    ) {
      const adopted = await tryAdoptHealthyGeneratedListener({
        descriptor,
        metadata,
        expectedServerSha256,
        healthUrl: healthTarget.url,
      });
      if (adopted) return adopted;
      return {
        state: "port-conflict",
        descriptor,
        metadata,
        staleReasons,
        detail: `port ${metadata.port} is occupied but no Prism pid is recorded`,
      };
    }
    const hostIsNonLoopback = staleReasons.includes("metadata-host-non-loopback");
    return {
      state: "stopped",
      descriptor,
      metadata,
      staleReasons,
      detail: hostIsNonLoopback
        ? "runtime metadata is present but no daemon pid is recorded and host is not loopback"
        : "runtime metadata is present but no daemon pid is recorded",
    };
  }

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
    const adopted = await tryAdoptHealthyGeneratedListener({
      descriptor,
      metadata,
      expectedServerSha256,
      healthUrl: healthTarget.url,
    });
    if (adopted) return adopted;
  }

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

  const health = await fetchHealth(healthTarget.url);
  const staleReasons = uniqueStaleReasons([
    ...detectMcpRuntimeStaleReasons(metadata, {
      requireLivePid: true,
      expectedServerSha256,
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
  resolveMcpRuntime(registry, options.harness);

  return classifyStatus({
    descriptor,
    metadata,
    expectedServerSha256: options.expectedServerSha256,
  });
};

const statusWithExpectedBundle = async (options: McpStatusOptions): Promise<McpStatusResult> =>
  statusWithResolvedContext(options, await resolveLifecycleContext(options));

export const getMcpStatus = async (options: McpStatusOptions): Promise<McpStatusResult> =>
  statusWithExpectedBundle(options);

export const listMcpStatuses = async (
  options: Omit<McpLifecycleCommonOptions, "pluginPath">,
): Promise<ReadonlyArray<McpStatusResult>> => {
  assertSupportedLifecycleTarget({ ...options, pluginPath: "." });
  const prismHome = expandPath(options.prismHome);
  const mcpRoot = prismMcpRuntimeDir(prismHome);
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
      prismHome,
      serverName: entry.name,
      serverPath,
      runtimePath,
    });
    const descriptor: McpRuntimeDescriptor = {
      pluginPath: "",
      pluginName: entry.name,
      prismHome,
      serverName: metadata?.serverName ?? `prism-generated-${entry.name}`,
      serverPath,
      runtimePath,
    };
    statuses.push(await classifyStatus({
      descriptor,
      metadata,
      expectedServerSha256: await currentServerHash(descriptor),
    }));
  }
  return statuses;
};

const handleExistingMcpDaemon = async (options: {
  readonly serveOptions: McpServeOptions;
  readonly context: McpLifecycleResolvedContext;
  readonly existing?: McpRuntimeMetadata;
  readonly prepared: McpPreparedServer;
}): Promise<McpServeResult | undefined> => {
  const { existing, prepared, context } = options;
  if (!existing) return undefined;

  const status = await classifyStatus({
    descriptor: prepared.descriptor,
    metadata: existing,
    expectedServerSha256: prepared.serverSha256,
  });
  if (status.state === "running") {
    if (
      status.metadata?.host !== prepared.host ||
      status.metadata?.port !== prepared.port
    ) {
      await stopMcpResolved({
        pluginPath: options.serveOptions.pluginPath,
        harness: options.serveOptions.harness,
        scope: options.serveOptions.scope,
        projectPath: options.serveOptions.projectPath,
        prismHome: options.serveOptions.prismHome,
      }, context);
      return undefined;
    }
    if (!metadataSemanticallyEqual(existing, status.metadata) && status.metadata) {
      await writeMcpRuntimeMetadata(prepared.descriptor.runtimePath, status.metadata);
    }
    return {
      state: "already-running",
      descriptor: prepared.descriptor,
      metadata: status.metadata,
      health: status.health,
    };
  }
  if (status.state === "stale-build") {
    await stopMcpResolved({
      pluginPath: options.serveOptions.pluginPath,
      harness: options.serveOptions.harness,
      scope: options.serveOptions.scope,
        projectPath: options.serveOptions.projectPath,
        prismHome: options.serveOptions.prismHome,
      }, context);
    return undefined;
  }
  if (status.state === "stale-pid" || status.state === "stopped" || status.state === "port-conflict") {
    return undefined;
  }

  throw new Error(
    `Recorded MCP daemon is ${status.state}; run 'prism mcp status' or 'prism mcp restart' (${status.detail}).`,
  );
};

const shouldReallocateAutoPort = (options: {
  readonly existing?: McpRuntimeMetadata;
  readonly configuredPort?: number;
  readonly requestedPort?: McpPortSelection;
  readonly selectedPort: number;
}): boolean => {
  const { existing } = options;
  if (!existing?.port || existing.port !== options.selectedPort) return false;
  if (options.configuredPort !== undefined) return false;
  if (typeof options.requestedPort === "number") return false;
  return !existing.pid || !pidIsRunning(existing.pid);
};

const prepareMcpServer = (options: {
  readonly descriptor: McpRuntimeDescriptor;
  readonly host: string;
  readonly port: number;
  readonly serverSha256: string;
  readonly toolTimeoutMs: number;
}): McpPreparedServer => ({
  descriptor: options.descriptor,
  host: options.host,
  port: options.port,
  serverSha256: options.serverSha256,
  toolTimeoutMs: options.toolTimeoutMs,
  mcpUrl: `http://${options.host}:${options.port}/mcp`,
  healthUrl: `http://${options.host}:${options.port}/healthz`,
});

const runForegroundPreparedServer = async (
  prepared: McpPreparedServer,
  startupTimeoutMs: number | undefined,
): Promise<McpServeResult> => {
  const descriptor = prepared.descriptor;
  const child = spawnServerProcess(prepared, { foreground: true });

  try {
    // Bun, shims, and launchd can make the serving pid differ from the
    // immediate child pid; startup identity is proven by server hash.
    await waitForHealth(
      prepared,
      undefined,
      startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  const exit = await waitForChildExit(child);
  if (exit.code !== 0 && exit.signal === null) {
    throw new Error(`Foreground MCP server exited with code ${exit.code}`);
  }
  return { state: "foreground-exited", descriptor };
};

const stopPreparedServerProcess = async (options: {
  readonly pid?: number;
  readonly healthPid?: number;
  readonly useLaunchAgent: boolean;
  readonly descriptor: McpRuntimeDescriptor;
}): Promise<void> => {
  const pids = [...new Set([options.healthPid, options.pid].filter((pid): pid is number => pid !== undefined))];
  if (pids.length > 0) {
    try {
      for (const pid of pids) {
        if (pidIsRunning(pid)) await terminatePid(pid, "SIGTERM", DEFAULT_STOP_TIMEOUT_MS);
      }
    } finally {
      for (const pid of pids) unregisterSupervisorMcpDaemon(pid);
      unregisterSupervisorMcpDaemonsForDescriptor(options.descriptor);
    }
    return;
  }
  if (options.useLaunchAgent) {
    try {
      await stopLaunchAgent(launchAgentLabelForServer(options.descriptor.serverName));
    } finally {
      unregisterSupervisorMcpDaemonsForDescriptor(options.descriptor);
    }
  }
};

const startPreparedServer = async (
  prepared: McpPreparedServer,
  options: McpServeOptions,
): Promise<McpStartedPreparedServer> => {
  let pid: number | undefined;
  const useLaunchAgent = shouldUseLaunchAgent(options);
  if (useLaunchAgent) await startLaunchAgent(prepared);
  else pid = spawnDaemon(prepared);

  try {
    // Bun, shims, and launchd can make the serving pid differ from the
    // immediate child pid; metadata records the health pid after startup.
    const health = await waitForHealth(
      prepared,
      undefined,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    const supervisorPid = useLaunchAgent ? undefined : health.pid;
    if (supervisorPid !== undefined && supervisorPid !== pid) {
      registerSupervisorMcpDaemon({
        pid: supervisorPid,
        prismHome: prepared.descriptor.prismHome,
        serverName: prepared.descriptor.serverName,
        serverPath: prepared.descriptor.serverPath,
      });
    }
    return { pid, useLaunchAgent, supervisorPid, health };
  } catch (error) {
    await stopPreparedServerProcess({
      pid,
      useLaunchAgent,
      descriptor: prepared.descriptor,
    }).catch(() => undefined);
    throw error;
  }
};

const persistPreparedServerMetadata = async (
  prepared: McpPreparedServer,
  started: McpStartedPreparedServer,
): Promise<McpRuntimeMetadata> => {
  const metadata = metadataForPreparedServer(prepared, started.health.pid, started.health);
  try {
    await writeMcpRuntimeMetadata(prepared.descriptor.runtimePath, metadata);
    return metadata;
  } catch (error) {
    try {
      await stopPreparedServerProcess({
        pid: started.pid,
        healthPid: started.supervisorPid,
        useLaunchAgent: started.useLaunchAgent,
        descriptor: prepared.descriptor,
      });
    } catch (cleanupError) {
      throw new Error(
        `Failed to write MCP runtime metadata and failed to stop MCP daemon: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
    throw error;
  }
};

const serveMcpResolved = async (
  options: McpServeOptions,
  context: McpLifecycleResolvedContext,
): Promise<McpServeResult> => {
  const { registry, descriptor } = context;
  const existing = await readRuntimeMetadataIfPresent(descriptor);
  const configured = resolveMcpRuntime(registry, options.harness);
  const host = options.host?.trim() || configured.host;
  assertLoopbackHost(host);
  const portSelection =
    typeof options.port === "number"
      ? options.port
      : configured.port ?? existing?.port ?? options.port;
  let selectedPort = await resolvePort(portSelection, registry, options.harness, host);
  // Serve consumes the compiled canonical bundle; it never rebuilds it.
  const serverSha256 = await readCanonicalServerBundleSha(descriptor);
  let prepared: McpPreparedServer = prepareMcpServer({
    descriptor,
    host,
    port: selectedPort,
    serverSha256,
    toolTimeoutMs: configured.toolTimeoutMs,
  });

  const existingResult = await handleExistingMcpDaemon({
    serveOptions: options,
    context,
    existing,
    prepared,
  });
  if (existingResult) return existingResult;

  if (!(await isPortAvailable(host, selectedPort))) {
    if (!shouldReallocateAutoPort({
      existing,
      configuredPort: configured.port,
      requestedPort: options.port,
      selectedPort,
    })) {
      throw new McpPortConflictError({ host, port: selectedPort });
    }
    selectedPort = await getFreePort(host);
    prepared = prepareMcpServer({
      descriptor,
      host,
      port: selectedPort,
      serverSha256,
      toolTimeoutMs: configured.toolTimeoutMs,
    });
  }

  if (options.foreground) {
    return runForegroundPreparedServer(prepared, options.startupTimeoutMs);
  }

  const started = await startPreparedServer(prepared, options);
  const metadata = await persistPreparedServerMetadata(prepared, started);
  const health = started.health;
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
    unregisterSupervisorMcpDaemonsForDescriptor(status.descriptor);
    return { state: "already-stopped", descriptor: status.descriptor, metadata };
  }
  if (status.state === "stale-pid") {
    const next = stoppedMetadata(metadata);
    await writeMcpRuntimeMetadata(status.descriptor.runtimePath, next);
    unregisterSupervisorMcpDaemon(metadata.pid);
    unregisterSupervisorMcpDaemonsForDescriptor(status.descriptor);
    return { state: "already-stopped", descriptor: status.descriptor, metadata: next };
  }
  if (hasUnsafePidReason(status.staleReasons)) {
    throw new Error(`Refusing to stop MCP daemon in state '${status.state}': ${status.detail}`);
  }
  if (!["running", "stale-build", "stale-health"].includes(status.state)) {
    throw new Error(`Refusing to stop MCP daemon in state '${status.state}': ${status.detail}`);
  }

  if (launchAgentEligible(options.prismHome)) {
    await stopLaunchAgent(launchAgentLabelForServer(status.descriptor.serverName)).catch(() => undefined);
  }
  try {
    if (pidIsRunning(metadata.pid)) {
      await terminatePid(metadata.pid, "SIGTERM", options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    }
  } finally {
    unregisterSupervisorMcpDaemon(metadata.pid);
    unregisterSupervisorMcpDaemonsForDescriptor(status.descriptor);
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
