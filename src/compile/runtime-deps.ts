import { fileURLToPath } from "node:url";

declare const PRISM_EFFECT_ENTRYPOINT: string | undefined;
declare const PRISM_MCP_SDK_MCP_ENTRYPOINT: string | undefined;
declare const PRISM_MCP_SDK_STDIO_ENTRYPOINT: string | undefined;
declare const PRISM_MCP_SDK_WEB_STANDARD_HTTP_ENTRYPOINT: string | undefined;
declare const PRISM_OPENCODE_PLUGIN_ENTRYPOINT: string | undefined;
declare const PRISM_ZOD_V4_ENTRYPOINT: string | undefined;

const bundledEntrypoint = (value: string | undefined): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    return value.replace(/\\/g, "/");
  }
  return undefined;
};

const bundledEffectEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_EFFECT_ENTRYPOINT);

const bundledMcpSdkMcpEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_MCP_SDK_MCP_ENTRYPOINT);

const bundledMcpSdkStdioEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_MCP_SDK_STDIO_ENTRYPOINT);

const bundledMcpSdkWebStandardHttpEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_MCP_SDK_WEB_STANDARD_HTTP_ENTRYPOINT);

const bundledOpenCodePluginEntrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_OPENCODE_PLUGIN_ENTRYPOINT);

const bundledZodV4Entrypoint = (): string | undefined =>
  bundledEntrypoint(PRISM_ZOD_V4_ENTRYPOINT);

const resolveBundleImportPath = (
  specifier: string,
  fallbackImportPath: () => string | undefined,
): string => {
  try {
    return fileURLToPath(import.meta.resolve(specifier)).replace(/\\/g, "/");
  } catch (error) {
    const fallback = fallbackImportPath();
    if (fallback) return fallback;
    throw error;
  }
};

export const effectBundleImportPath = (): string =>
  resolveBundleImportPath("effect", bundledEffectEntrypoint);

export const mcpSdkMcpBundleImportPath = (): string =>
  resolveBundleImportPath("@modelcontextprotocol/sdk/server/mcp.js", bundledMcpSdkMcpEntrypoint);

export const mcpSdkStdioBundleImportPath = (): string =>
  resolveBundleImportPath(
    "@modelcontextprotocol/sdk/server/stdio.js",
    bundledMcpSdkStdioEntrypoint,
  );

export const mcpSdkWebStandardHttpBundleImportPath = (): string =>
  resolveBundleImportPath(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
    bundledMcpSdkWebStandardHttpEntrypoint,
  );

export const opencodePluginBundleImportPath = (): string =>
  resolveBundleImportPath("@opencode-ai/plugin", bundledOpenCodePluginEntrypoint);

export const zodV4BundleImportPath = (): string =>
  resolveBundleImportPath("zod/v4", bundledZodV4Entrypoint);
