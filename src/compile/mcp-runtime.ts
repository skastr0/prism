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


export interface ResolvedMcpRuntime {
  readonly targetId: HarnessId;
  readonly transport: McpRuntimeTransport;
  readonly host: string;
  readonly port?: number;
  readonly connectTimeoutMs: number;
  readonly toolTimeoutMs: number;
}


export const generatedMcpServerName = (pluginName: string): string =>
  `${GENERATED_SERVER_PREFIX}-${normalizeBundleSegment(pluginName)}`;

export const generatedMcpWireServerName = (pluginName: string): string =>
  `p_${stableHash8(pluginName)}`;

export const mcpExposureProfileForTarget = (
  serverName: string,
  targetId: HarnessId,
): string => `${serverName}:${targetId}`;


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
  const port = configuredPort;
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
