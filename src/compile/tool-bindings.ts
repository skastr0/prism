import { basename } from "node:path";
import type { ComposedAgent } from "./compose.js";
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

export const mcpBindingsForAgentsAndTools = (
  sourcePluginName: string,
  tools: ReadonlyArray<CanonicalTool> | undefined,
  agents: ReadonlyArray<ComposedAgent>,
): ReadonlyArray<ResolvedContractBinding> => [
  ...bindingsFromCanonicalTools(sourcePluginName, tools ?? []),
  ...agents.flatMap((agent) => agent.toolBindings),
];

export const collectBindingNameMap = (
  bindings: ReadonlyArray<ResolvedContractBinding>,
  nameForBinding: (binding: ResolvedContractBinding) => string,
): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();

  for (const binding of bindings) {
    const name = nameForBinding(binding);
    names.set(binding.logicalName, name);
    names.set(binding.toolName, name);
    names.set(`${binding.toolPluginName}:${binding.toolName}`, name);
    if (binding.contract) names.set(binding.contract.name, name);
  }

  return names;
};
