import { basename } from "node:path";
import type { ResolvedContractBinding } from "./resolve.js";
import type { CanonicalTool } from "./sources.js";

export const bindingFromToolSource = (
  pluginName: string,
  sourcePath: string,
): ResolvedContractBinding => {
  const toolName = basename(sourcePath, ".tool.ts");
  return {
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

const bindingIdentity = (binding: ResolvedContractBinding): string =>
  `tool:${binding.toolPluginName}:${binding.toolName}:${binding.logicalName}`;

const dedupeBindings = (
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyArray<ResolvedContractBinding> => {
  const seen = new Map<string, ResolvedContractBinding>();
  for (const binding of bindings) {
    seen.set(bindingIdentity(binding), binding);
  }
  return [...seen.values()].sort((left, right) =>
    bindingIdentity(left).localeCompare(bindingIdentity(right)),
  );
};

export const ownerPluginForBinding = (
  binding: ResolvedContractBinding,
): string => binding.toolPluginName;

export const bindingsOwnedByPlugin = (
  compilingPluginName: string,
  tools: ReadonlyArray<CanonicalTool> | undefined,
): ReadonlyArray<ResolvedContractBinding> =>
  dedupeBindings(
    bindingsFromCanonicalTools(compilingPluginName, tools ?? []).filter(
      (binding) => binding.toolPluginName === compilingPluginName,
    ),
  );

export const groupBindingsByOwner = (
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>> => {
  const groups = new Map<string, ResolvedContractBinding[]>();
  for (const binding of bindings) {
    const owner = ownerPluginForBinding(binding);
    const list = groups.get(owner) ?? [];
    list.push(binding);
    groups.set(owner, list);
  }
  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([owner, ownerBindings]) => [
        owner,
        dedupeBindings(ownerBindings),
      ]),
  );
};

/**
 * Collect every binding that needs an MCP server entry for this compile,
 * grouping by the plugin that owns the underlying canonical tool. With agent
 * tool grants removed this reduces to the compiling plugin's own tools.
 */
export const allReferencedBindingsByOwner = (
  compilingPluginName: string,
  tools: ReadonlyArray<CanonicalTool> | undefined,
): ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>> =>
  groupBindingsByOwner(bindingsOwnedByPlugin(compilingPluginName, tools));

export const mcpBindingsForAgentsAndTools = (
  sourcePluginName: string,
  tools: ReadonlyArray<CanonicalTool> | undefined,
): ReadonlyArray<ResolvedContractBinding> =>
  bindingsFromCanonicalTools(sourcePluginName, tools ?? []);

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
  }

  return names;
};
