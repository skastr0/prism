import { readdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { getHarness, harnessSupportsProjectScope } from "../harnesses.js";
import { expandPath } from "../fs.js";
import type { HarnessId, HarnessScope } from "../types.js";
import { loadPlugin } from "../compile/load.js";
import type { PluginRegistry } from "../compile/registry.js";
import { mcpServerRuntimeSourceSha256 } from "../compile/mcp-bundle.js";
import { generatedMcpServerName } from "../compile/mcp-runtime.js";
import { prismMcpRuntimeDir, prismMcpServerPath } from "../compile/mcp-runtime-path.js";
import { computeFileSha256, parseMcpRuntimeHealth, type McpRuntimeHealth } from "./runtime-metadata.js";
import { tryPluginDaemonLogPath } from "@skastr0/prism-sdk/mcp/daemon-resolver";
import { getDaemon, type RegistryEntry } from "@skastr0/prism-sdk/mcp/uds-registry";
import { probeSocketLiveness } from "@skastr0/prism-sdk/mcp/uds-singleton";

/**
 * MCP daemon status, migrated to the UDS-only consolidated world (overhaul
 * WS6 step 6). There is no manual `serve`/`stop`/`restart` anymore: the
 * stdio shim resolves-or-spawns daemons over Unix domain sockets and
 * idle-reaps them (see `packages/prism-sdk/src/mcp/daemon-resolver.ts` and
 * `src/compile/mcp-bundle.ts`'s `MCP_SDK_HTTP_RUNTIME`). This module is now
 * purely the *observability* surface: `prism mcp status` and doctor's
 * `mcp.health` check read the UDS registry and probe the live socket --
 * they never spawn, stop, or supervise a process.
 */

export type McpLifecycleHarness = HarnessId;

export type McpDaemonState =
  | "running"
  | "stopped"
  | "stale-pid"
  | "stale-build"
  | "missing-bundle";

export interface McpLifecycleCommonOptions {
  readonly pluginPath: string;
  readonly harness: McpLifecycleHarness;
  readonly scope: HarnessScope;
  readonly projectPath?: string;
  /** Prism home directory, threaded from the CLI edge (no env fallback). */
  readonly prismHome: string;
}

export type McpStatusOptions = McpLifecycleCommonOptions;

export interface McpRuntimeDescriptor {
  readonly pluginPath: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly prismHome: string;
  readonly serverName: string;
  readonly serverPath: string;
  /** Where a spawned daemon's stdout+stderr lands (OBS-001). Absent when the
   * plugin name cannot produce a valid UDS-shaped path -- see
   * `tryPluginDaemonLogPath`. */
  readonly logPath?: string;
}

export interface McpStatusResult {
  readonly state: McpDaemonState;
  readonly descriptor: McpRuntimeDescriptor;
  readonly registry?: RegistryEntry;
  readonly health?: McpRuntimeHealth;
  readonly staleReasons: ReadonlyArray<string>;
  readonly detail: string;
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const assertSupportedLifecycleTarget = (options: McpLifecycleCommonOptions): void => {
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
}): McpRuntimeDescriptor => ({
  pluginPath: expandPath(options.pluginPath),
  pluginName: options.registry.pluginName,
  pluginVersion: options.registry.pluginVersion,
  prismHome: options.prismHome,
  serverName: generatedMcpServerName(options.registry.pluginName),
  serverPath: prismMcpServerPath(options.prismHome, options.registry.pluginName),
  logPath: tryPluginDaemonLogPath(options.registry.pluginName, options.prismHome),
});

const resolveDescriptor = async (
  options: McpLifecycleCommonOptions,
): Promise<McpRuntimeDescriptor> => {
  assertSupportedLifecycleTarget(options);
  const pluginPath = expandPath(options.pluginPath);
  const registry = await loadRegistry(pluginPath);
  const prismHome = expandPath(options.prismHome);
  return descriptorForRegistry({ pluginPath, registry, prismHome });
};

const currentServerHash = async (descriptor: McpRuntimeDescriptor): Promise<string | undefined> =>
  (await fileExists(descriptor.serverPath)) ? computeFileSha256(descriptor.serverPath) : undefined;

/** Bun's `fetch` accepts an extra `unix` option beyond the standard `RequestInit` shape. */
type UdsRequestInit = RequestInit & { readonly unix: string };

const fetchHealthOverUds = async (socketPath: string): Promise<McpRuntimeHealth | undefined> => {
  try {
    const init: UdsRequestInit = { method: "GET", unix: socketPath };
    const response = await fetch("http://localhost/healthz", init);
    if (!response.ok) return undefined;
    return parseMcpRuntimeHealth(await response.json());
  } catch {
    return undefined;
  }
};

/**
 * Classifies a plugin's daemon state purely from the UDS registry + a live
 * socket probe -- never from a pid file or a TCP port. There is no
 * "port-conflict" state anymore: a content-addressed UDS socket path can
 * never be contended by two different builds, and the bundle's own
 * `bindUnixSocketSingleton` already resolves a same-path race cleanly.
 */
const classifyStatus = async (
  descriptor: McpRuntimeDescriptor,
): Promise<McpStatusResult> => {
  const currentHash = await currentServerHash(descriptor);
  const registered = await getDaemon(descriptor.pluginName, descriptor.prismHome);
  if (registered.kind === "absent") {
    if (currentHash === undefined) {
      return {
        state: "missing-bundle",
        descriptor,
        staleReasons: ["missing-server-file"],
        detail: `compiled bundle is missing at ${descriptor.serverPath}; CLI tool invocation cannot spawn this plugin`,
      };
    }
    return {
      state: "stopped",
      descriptor,
      staleReasons: [],
      detail: "no daemon is registered for this plugin",
    };
  }

  const entry = registered.value;
  const liveness = await probeSocketLiveness(entry.sock);
  if (liveness !== "live") {
    if (currentHash === undefined) {
      return {
        state: "missing-bundle",
        descriptor,
        registry: entry,
        staleReasons: ["missing-server-file", "socket-not-live"],
        detail: `compiled bundle is missing at ${descriptor.serverPath} and the registered daemon is not responding`,
      };
    }
    return {
      state: "stale-pid",
      descriptor,
      registry: entry,
      staleReasons: ["socket-not-live"],
      detail: `registered daemon at ${entry.sock} (pid ${entry.pid}) is not responding`,
    };
  }

  if (currentHash === undefined) {
    return {
      state: "stale-build",
      descriptor,
      registry: entry,
      staleReasons: ["missing-server-file"],
      detail: `compiled bundle is missing at ${descriptor.serverPath}`,
    };
  }
  if (currentHash !== entry.bundleHash) {
    return {
      state: "stale-build",
      descriptor,
      registry: entry,
      staleReasons: ["bundle-hash-mismatch"],
      detail: "the live daemon's bundle hash does not match the compiled bundle on disk; a refresh ran since it started",
    };
  }

  const health = await fetchHealthOverUds(entry.sock);
  // The daemon's own bundle hash matches on disk, but the runtime templates
  // baked into it (schema bridge, transport handling, health payload shape)
  // are a property of the *prism install*, not this plugin's bundle -- an
  // upgraded prism binary with a stale-still-running daemon from before the
  // upgrade would never show up as a bundle-hash mismatch otherwise.
  const expectedServerSourceSha256 = mcpServerRuntimeSourceSha256();
  if (health?.serverSourceSha256 && health.serverSourceSha256 !== expectedServerSourceSha256) {
    return {
      state: "stale-build",
      descriptor,
      registry: entry,
      health,
      staleReasons: ["server-source-sha256-mismatch"],
      detail: "the live daemon predates a prism runtime-template change; refresh the bundle so the next CLI invocation replaces it",
    };
  }

  return {
    state: "running",
    descriptor,
    registry: entry,
    ...(health ? { health } : {}),
    staleReasons: [],
    detail: `running at unix:${entry.sock}`,
  };
};

export const getMcpStatus = async (options: McpStatusOptions): Promise<McpStatusResult> => {
  const descriptor = await resolveDescriptor(options);
  return classifyStatus(descriptor);
};

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
    const pluginName = entry.name;
    const descriptor: McpRuntimeDescriptor = {
      pluginPath: "",
      pluginName,
      prismHome,
      serverName: generatedMcpServerName(pluginName),
      serverPath: join(mcpRoot, pluginName, "server.mjs"),
      logPath: tryPluginDaemonLogPath(pluginName, prismHome),
    };
    statuses.push(await classifyStatus(descriptor));
  }
  return statuses;
};

export const formatMcpStatus = (status: McpStatusResult): string => {
  const pid = status.registry?.pid ? ` pid=${status.registry.pid}` : "";
  const sock = status.registry?.sock ? ` sock=${status.registry.sock}` : "";
  const reasons = status.staleReasons.length > 0
    ? ` reasons=${status.staleReasons.join(",")}`
    : "";
  const log = status.descriptor.logPath ? ` log=${status.descriptor.logPath}` : "";
  return `${status.state.padEnd(15)} ${status.descriptor.serverName}${pid}${sock}${reasons}${log} - ${status.detail}`;
};
