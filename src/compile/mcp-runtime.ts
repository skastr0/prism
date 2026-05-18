import { join } from "node:path";
import { homedir } from "node:os";
import { resolveManifestTargets } from "../manifest.js";
import type { HarnessId, PluginRuntimeMcpHarnessConfig } from "../types.js";
import {
  mcpServerArtifactRelativePath,
  type McpHttpServerOptions,
  type McpServerBundleTransport,
} from "./mcp-bundle.js";
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
} from "./mcp-policy.js";
import type { PluginRegistry } from "./registry.js";
import { normalizeBundleSegment } from "./lowerers/shared.js";

const GENERATED_SERVER_PREFIX = "prism-generated";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_TOKEN_ENV = "PRISM_MCP_TOKEN";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type McpHttpSupportState = "supported" | "unsupported";

export interface McpHttpTargetSupport {
  readonly config: McpHttpSupportState;
  readonly lifecycle: McpHttpSupportState;
  readonly reason?: string;
}

export interface ResolvedMcpRuntime {
  readonly targetId: HarnessId;
  readonly transport: McpServerBundleTransport;
  readonly host: string;
  readonly port?: number;
  readonly tokenEnv: string;
  readonly connectTimeoutMs: number;
  readonly toolTimeoutMs: number;
}

export interface RuntimeMcpServerDescriptor {
  readonly serverName: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface McpServerBundleRuntimeOptions {
  readonly transport: McpServerBundleTransport;
  readonly http?: McpHttpServerOptions;
  readonly toolTimeoutMs: number;
}

export const defaultMcpRuntimeRoot = (): string =>
  join(homedir(), ".config");

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
  "gemini-cli": {
    config: "supported",
    lifecycle: "supported",
  },
  grok: {
    config: "unsupported",
    lifecycle: "unsupported",
    reason:
      "Grok Build plugin-local HTTP MCP config has not been verified with a safe bearer-token secret source.",
  },
};

export const generatedMcpServerName = (pluginName: string): string =>
  `${GENERATED_SERVER_PREFIX}-${normalizeBundleSegment(pluginName)}`;

export const runtimeMcpServerRelativePath = (pluginName: string): string =>
  `prism/${mcpServerArtifactRelativePath(generatedMcpServerName(pluginName))}`;

export const runtimeMcpServerDescriptor = (
  harnessRoot: string,
  pluginName: string,
): RuntimeMcpServerDescriptor => {
  const relativePath = runtimeMcpServerRelativePath(pluginName);
  return {
    serverName: generatedMcpServerName(pluginName),
    relativePath,
    absolutePath: join(harnessRoot, ...relativePath.split("/")),
  };
};

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
  options: { readonly requirePort?: boolean } = {},
): ResolvedMcpRuntime => {
  const configured = registry ? runtimeConfigForTarget(registry, targetId) : undefined;
  const transport = configured?.transport === "streamable-http" ? "streamable-http" : "stdio";
  const host = stringValue(configured?.host) ?? DEFAULT_HTTP_HOST;
  const tokenEnv = stringValue(configured?.tokenEnv) ?? DEFAULT_TOKEN_ENV;
  const port = numberValue(configured?.port);
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

  if (transport === "streamable-http") {
    assertMcpHttpTargetSupported(targetId, "config");
    if (!isLoopbackMcpHost(host)) {
      throw new Error(
        `Streamable HTTP MCP transport for target '${targetId}' requires plugin.json runtime.mcp.${targetId}.host to be a loopback host.`,
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
  }

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
  if (runtime.transport !== "streamable-http" || runtime.port === undefined) {
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

export const mcpServerBundleRuntimeOptions = (
  runtime: ResolvedMcpRuntime,
): McpServerBundleRuntimeOptions =>
  runtime.transport === "streamable-http"
    ? {
        transport: runtime.transport,
        toolTimeoutMs: runtime.toolTimeoutMs,
        http: {
          host: runtime.host,
          ...(runtime.port !== undefined ? { port: runtime.port } : {}),
          tokenEnv: runtime.tokenEnv,
        },
      }
    : { transport: "stdio", toolTimeoutMs: runtime.toolTimeoutMs };

export const isStreamableHttpMcpRuntime = (
  registry: PluginRegistry,
  targetId: HarnessId,
): boolean => resolveMcpRuntime(registry, targetId).transport === "streamable-http";

export const assertPluginTargetsMcpTools = (
  registry: PluginRegistry,
  targetId: HarnessId,
): void => {
  if (registry.tools.size === 0) {
    throw new Error(`Plugin '${registry.pluginName}' has no canonical tools to serve over MCP.`);
  }
  if (!resolveManifestTargets(registry.targets.tools ?? []).includes(targetId)) {
    throw new Error(
      `Plugin '${registry.pluginName}' must include '${targetId}' in targets.tools before MCP serve can expose its tools.`,
    );
  }
};
