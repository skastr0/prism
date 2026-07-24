import { relative } from "node:path";
import type { ResolvedContractBinding } from "./resolve.js";
import { stableHash8 } from "./stable-hash.js";

// Some MCP clients validate the whole qualified `server + tool` name at 64
// chars. Prism's generated wire server keys are `p_` + 8 hex chars, leaving
// 52 chars for the tool segment under the strictest `server__tool` shape.
export const GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH = 52;

export const normalizeGeneratedPluginName = (pluginName: string): string => {
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : "plugin";
};

export const sanitizeGeneratedToolSegment = (
  value: string,
  fallback: string,
): string => {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

export const generatedToolNamespace = (pluginName: string): string =>
  sanitizeGeneratedToolSegment(normalizeGeneratedPluginName(pluginName), "plugin");

const compactGeneratedExternalToolName = (name: string): string => {
  if (name.length <= GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH) return name;
  const suffix = stableHash8(name);
  const prefixLength = GENERATED_EXTERNAL_TOOL_NAME_MAX_LENGTH - suffix.length - 1;
  const prefix = name.slice(0, prefixLength).replace(/_+$/g, "");
  return `${prefix}_${suffix}`;
};

export const generatedOwnerToolName = (toolPluginName: string, toolName: string): string =>
  compactGeneratedExternalToolName(
    `${generatedToolNamespace(toolPluginName)}_${sanitizeGeneratedToolSegment(toolName, "tool")}`,
  );

export const generatedSyntheticToolName = (
  sourcePluginName: string,
  contractName: string,
): string =>
  compactGeneratedExternalToolName(
    `${generatedToolNamespace(sourcePluginName)}_${sanitizeGeneratedToolSegment(contractName, "tool")}`,
  );

export const generatedPluginIdForOwner = (ownerPluginName: string): string =>
  `prism-generated-${normalizeGeneratedPluginName(ownerPluginName)}`;

export const generatedToolNameForBinding = (
  sourcePluginName: string,
  binding: ResolvedContractBinding,
): string => {
  if (binding.kind === "permission") {
    return generatedOwnerToolName(binding.toolPluginName, binding.toolName);
  }
  if (!binding.contract) {
    throw new Error(`synthetic tool binding '${binding.logicalName}' is missing a contract`);
  }
  return generatedSyntheticToolName(sourcePluginName, binding.contract.name);
};

export const sourceIsInside = (sourcePath: string, root: string): boolean => {
  const rel = relative(root, sourcePath);
  return rel.length === 0 || (!rel.startsWith("..") && !rel.startsWith("/"));
};
