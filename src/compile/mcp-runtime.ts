import type { HarnessId, PluginRuntimeMcpHarnessConfig } from "../types.js";
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
} from "./mcp-policy.js";
import type { PluginRegistry } from "./registry.js";
import { normalizeBundleSegment } from "./lowerers/shared.js";

const GENERATED_SERVER_PREFIX = "prism-generated";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_TOKEN_ENV = ["PRISM", "MCP", "TOKEN"].join("_");
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENV_BEARER_TOKEN_CONFIG_TARGETS: ReadonlySet<HarnessId> =
  new Set<HarnessId>(["codex-cli", "claude-code"]);

export type McpRuntimeTransport = "streamable-http";
export const MCP_EXPOSURE_HEADER = "X-Prism-Mcp-Exposure" as const;

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
  readonly tokenEnv: string;
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

export const mcpRuntimeUsesBearerTokenEnvConfig = (targetId: HarnessId): boolean =>
  ENV_BEARER_TOKEN_CONFIG_TARGETS.has(targetId);

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

export const assertMcpTokenEnvName = (tokenEnv: string): void => {
  if (!isMcpTokenEnvName(tokenEnv)) {
    throw new Error("MCP token env must be an environment variable name.");
  }
};

export const isMcpTokenEnvName = (tokenEnv: string): boolean =>
  ENV_NAME_PATTERN.test(tokenEnv);

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
  const tokenEnv = stringValue(configured?.tokenEnv) ?? DEFAULT_TOKEN_ENV;
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
  assertMcpTokenEnvName(tokenEnv);

  return {
    targetId,
    transport,
    host,
    ...(port !== undefined ? { port } : {}),
    tokenEnv,
    connectTimeoutMs,
    toolTimeoutMs,
  };
};

export const renderMcpHttpUrl = (runtime: ResolvedMcpRuntime): string => {
  if (runtime.port === undefined) {
    throw new Error(
      `Streamable HTTP MCP transport for target '${runtime.targetId}' requires a resolved port before URL rendering.`,
    );
  }
  return `http://${runtime.host}:${runtime.port}/mcp`;
};

export const renderMcpBearerAuthorizationTemplate = (tokenEnv: string): string =>
  `Bearer \${${tokenEnv}}`;

export const renderMcpBearerAuthorization = (options: {
  readonly tokenEnv: string;
  readonly token?: string;
}): string =>
  options.token ? `Bearer ${options.token}` : renderMcpBearerAuthorizationTemplate(options.tokenEnv);
