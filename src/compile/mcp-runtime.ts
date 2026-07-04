import type { HarnessId, PluginRuntimeMcpHarnessConfig } from "../types.js";
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
} from "./mcp-policy.js";
import { type PluginRegistry, collectPluginRegistries } from "./registry.js";
import { normalizeBundleSegment } from "./lowerers/shared.js";
import { prismMcpRuntimeDir } from "./mcp-runtime-path.js";
import { stableHash8 } from "./stable-hash.js";
import { readMcpRuntimeMetadata } from "../mcp/runtime-metadata.js";
import { join } from "node:path";

const GENERATED_SERVER_PREFIX = "prism-generated";
const DEFAULT_HTTP_HOST = "127.0.0.1";

export type McpRuntimeTransport = "streamable-http";
export const MCP_EXPOSURE_HEADER = "X-Prism-Mcp-Exposure" as const;

/**
 * Per-harness rollout flag for *how a harness invokes* a plugin's generated
 * MCP server — not to be confused with `McpRuntimeTransport` above, which is
 * the wire protocol the daemon itself speaks (always Streamable HTTP today).
 * `"http"` (default) is today's one-http-entry-per-owner-plugin `.mcp.json`
 * shape. `"stdio-shim"` points the harness at the aggregating stdio shim
 * (`prism mcp shim`) instead, which fans out to the same daemons over UDS.
 */
export type McpHarnessTransportMode = "http" | "stdio-shim";
export const DEFAULT_MCP_HARNESS_TRANSPORT: McpHarnessTransportMode = "http";

/**
 * Canary override env var name for a given harness, e.g. `claude-code` ->
 * `PRISM_MCP_TRANSPORT_CLAUDE_CODE`. Lets an operator flip one harness to
 * `stdio-shim` without touching plugin.json or CLI flags.
 */
export const mcpHarnessTransportEnvVar = (targetId: HarnessId): string =>
  `PRISM_MCP_TRANSPORT_${targetId.replace(/-/g, "_").toUpperCase()}`;

const parseMcpHarnessTransportMode = (raw: string | undefined): McpHarnessTransportMode | undefined =>
  raw === "http" || raw === "stdio-shim" ? raw : undefined;

/**
 * Resolves the per-harness MCP transport rollout flag. Precedence: the
 * `PRISM_MCP_TRANSPORT_<HARNESS>` env var (canary escape hatch, read fresh
 * on every call) wins over the compiled/configured default, which itself
 * defaults to `"http"` — the flag-off behavior every existing lowerer and
 * golden fixture already assumes.
 */
export const resolveMcpHarnessTransportMode = (
  targetId: HarnessId,
  configured?: McpHarnessTransportMode,
): McpHarnessTransportMode =>
  parseMcpHarnessTransportMode(process.env[mcpHarnessTransportEnvVar(targetId)]) ??
  configured ??
  DEFAULT_MCP_HARNESS_TRANSPORT;

export type McpHttpSupportState = "supported" | "unsupported";

export interface McpHttpTargetSupport {
  readonly config: McpHttpSupportState;
  readonly lifecycle: McpHttpSupportState;
  readonly reason?: string;
}

export interface ResolvedMcpRuntime {
  readonly targetId: HarnessId;
  readonly transport: McpRuntimeTransport;
  readonly host: string;
  readonly port?: number;
  readonly connectTimeoutMs: number;
  readonly toolTimeoutMs: number;
}

const HTTP_SUPPORT: Partial<Record<HarnessId, McpHttpTargetSupport>> = {
  hermes: {
    config: "supported",
    lifecycle: "supported",
  },
  "codex-cli": {
    config: "supported",
    lifecycle: "supported",
  },
  "claude-code": {
    config: "supported",
    lifecycle: "supported",
  },
  "antigravity-cli": {
    config: "supported",
    lifecycle: "supported",
  },
  "factory-droid": {
    config: "supported",
    lifecycle: "supported",
  },
  "kimi-code": {
    config: "supported",
    lifecycle: "supported",
  },
  cursor: {
    config: "supported",
    lifecycle: "supported",
  },
  grok: {
    config: "supported",
    lifecycle: "supported",
  },
};

export const generatedMcpServerName = (pluginName: string): string =>
  `${GENERATED_SERVER_PREFIX}-${normalizeBundleSegment(pluginName)}`;

export const generatedMcpWireServerName = (pluginName: string): string =>
  `p_${stableHash8(pluginName)}`;

export const mcpExposureProfileForTarget = (
  serverName: string,
  targetId: HarnessId,
): string => `${serverName}:${targetId}`;

export const getMcpHttpTargetSupport = (targetId: HarnessId): McpHttpTargetSupport =>
  HTTP_SUPPORT[targetId] ?? {
    config: "unsupported",
    lifecycle: "unsupported",
    reason: `Target '${targetId}' does not have a verified Streamable HTTP MCP config renderer.`,
  };

export const assertMcpHttpTargetSupported = (
  targetId: HarnessId,
  surface: keyof Pick<McpHttpTargetSupport, "config" | "lifecycle">,
): void => {
  const support = getMcpHttpTargetSupport(targetId);
  if (support[surface] === "supported") return;
  throw new Error(
    `Streamable HTTP MCP is not supported for target '${targetId}'${support.reason ? `: ${support.reason}` : "."}`,
  );
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const positiveIntegerConfigValue = (
  value: unknown,
  targetId: HarnessId,
  field: "connectTimeoutMs" | "toolTimeoutMs",
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(
    `MCP runtime config plugin.json runtime.mcp.${targetId}.${field} must be a positive integer number of milliseconds.`,
  );
};

export const isLoopbackMcpHost = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";

const runtimeConfigForTarget = (
  registry: PluginRegistry,
  targetId: HarnessId,
): PluginRuntimeMcpHarnessConfig | undefined =>
  registry.runtime.mcp?.[targetId];

export const resolveMcpRuntime = (
  registry: PluginRegistry | undefined,
  targetId: HarnessId,
  options: {
    readonly requirePort?: boolean;
    readonly resolvedPort?: number;
  } = {},
): ResolvedMcpRuntime => {
  const configured = registry ? runtimeConfigForTarget(registry, targetId) : undefined;
  const configuredTransport = (configured as { readonly transport?: unknown } | undefined)?.transport;
  if (configuredTransport !== undefined && configuredTransport !== "streamable-http") {
    throw new Error(
      `MCP runtime config plugin.json runtime.mcp.${targetId}.transport='${String(configuredTransport)}' is no longer supported; Prism generated MCP uses Streamable HTTP only.`,
    );
  }
  const transport: McpRuntimeTransport = "streamable-http";
  const host = stringValue(configured?.host) ?? DEFAULT_HTTP_HOST;
  const configuredPort = numberValue(configured?.port);
  const resolvedPort = numberValue(options.resolvedPort);
  const port = configuredPort ?? resolvedPort;
  const connectTimeoutMs = positiveIntegerConfigValue(
    configured?.connectTimeoutMs,
    targetId,
    "connectTimeoutMs",
  ) ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  const toolTimeoutMs = positiveIntegerConfigValue(
    configured?.toolTimeoutMs,
    targetId,
    "toolTimeoutMs",
  ) ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS;

  assertMcpHttpTargetSupported(targetId, "config");
  if (!isLoopbackMcpHost(host)) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${targetId}' requires plugin.json runtime.mcp.${targetId}.host to be a loopback host.`,
    );
  }
  if (configured?.port !== undefined && configuredPort === undefined) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${targetId}' requires plugin.json runtime.mcp.${targetId}.port to be an integer from 1 to 65535.`,
    );
  }
  if (options.resolvedPort !== undefined && resolvedPort === undefined) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${targetId}' requires the resolved MCP runtime port to be an integer from 1 to 65535.`,
    );
  }
  if (options.requirePort === true && (port === undefined || port <= 0 || port > 65535)) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${targetId}' requires plugin.json runtime.mcp.${targetId}.port to be an integer from 1 to 65535.`,
    );
  }
  if (port !== undefined && (port <= 0 || port > 65535)) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${targetId}' requires plugin.json runtime.mcp.${targetId}.port to be an integer from 1 to 65535.`,
    );
  }

  return {
    targetId,
    transport,
    host,
    ...(port !== undefined ? { port } : {}),
    connectTimeoutMs,
    toolTimeoutMs,
  };
};

export interface McpHttpUrlOptions {
  readonly disableSse?: boolean;
}

export const renderMcpHttpUrl = (
  runtime: ResolvedMcpRuntime,
  options: McpHttpUrlOptions = {},
): string => {
  if (runtime.port === undefined) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${runtime.targetId}' requires a resolved port before URL rendering.`,
    );
  }
  const query = options.disableSse === true ? "?prism_sse=off" : "";
  return `http://${runtime.host}:${runtime.port}/mcp${query}`;
};

const ownerRuntimeMetadataPath = (prismHome: string, pluginName: string): string =>
  join(prismMcpRuntimeDir(prismHome), normalizeBundleSegment(pluginName), "runtime.json");

const resolvedMcpRuntimeFromMetadata = (
  targetId: HarnessId,
  metadata: { readonly host?: string; readonly port?: number },
): ResolvedMcpRuntime | undefined => {
  if (!metadata.host || !metadata.port || !isLoopbackMcpHost(metadata.host)) return undefined;
  return {
    targetId,
    transport: "streamable-http",
    host: metadata.host,
    port: metadata.port,
    connectTimeoutMs: DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  };
};

/**
 * Resolve the MCP runtime for a foreign-owner plugin referenced by a consumer.
 * Prefer the running daemon's recorded metadata so auto-selected ports are
 * accurate, then fall back to the owner plugin.json static runtime config.
 */
export const resolveOwnerMcpRuntime = async (options: {
  readonly prismHome: string;
  readonly registry: PluginRegistry;
  readonly targetId: HarnessId;
  readonly ownerPluginName: string;
}): Promise<ResolvedMcpRuntime | undefined> => {
  const ownerRegistry = collectPluginRegistries(options.registry).get(options.ownerPluginName);
  if (!ownerRegistry) return undefined;

  try {
    const metadata = await readMcpRuntimeMetadata(
      ownerRuntimeMetadataPath(options.prismHome, options.ownerPluginName),
    );
    const fromMetadata = resolvedMcpRuntimeFromMetadata(options.targetId, metadata);
    if (fromMetadata) return fromMetadata;
  } catch {
    // Metadata missing or unreadable; fall back to static config below.
  }

  try {
    return resolveMcpRuntime(ownerRegistry, options.targetId);
  } catch {
    return undefined;
  }
};
