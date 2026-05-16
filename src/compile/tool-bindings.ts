import { basename } from "node:path";
import type { ResolvedContractBinding } from "./resolve.js";
import type { CanonicalTool } from "./sources.js";

export const bindingFromToolSource = (
  pluginName: string,
  sourcePath: string,
): ResolvedContractBinding => {
  const toolName = basename(sourcePath, ".tool.ts");
  return {
    kind: "permission",
    logicalName: toolName,
    toolPluginName: pluginName,
    toolName,
    toolSourcePath: sourcePath,
  };
};

export const bindingsFromCanonicalTools = (
  pluginName: string,
  tools: ReadonlyArray<CanonicalTool>,
): ReadonlyArray<ResolvedContractBinding> =>
  tools
    .map((tool) => bindingFromToolSource(pluginName, tool.sourcePath))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
