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

const bindingIdentity = (binding: ResolvedContractBinding): string => {
  if (binding.kind === "synthetic") {
    return [
      "synthetic",
      binding.contract?.pluginName ?? "",
      binding.contract?.name ?? "",
      binding.logicalName,
      binding.toolPluginName,
      binding.toolName,
    ].join(":");
  }
  return `permission:${binding.toolPluginName}:${binding.toolName}:${binding.logicalName}`;
};

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

export const bindingIsOwnedByPlugin = (
  compilingPluginName: string,
  binding: ResolvedContractBinding,
): boolean =>
  binding.kind === "synthetic" || binding.toolPluginName === compilingPluginName;

export const ownerPluginForBinding = (
  compilingPluginName: string,
  binding: ResolvedContractBinding,
): string =>
  binding.kind === "synthetic" ? compilingPluginName : binding.toolPluginName;

export const bindingsOwnedByPlugin = (
  compilingPluginName: string,
  tools: ReadonlyArray<CanonicalTool> | undefined,
  agents: ReadonlyArray<ComposedAgent>,
): ReadonlyArray<ResolvedContractBinding> => {
  const bindings: ResolvedContractBinding[] = [
    ...bindingsFromCanonicalTools(compilingPluginName, tools ?? []),
  ];
  for (const agent of agents) {
    for (const binding of agent.toolBindings) {
      if (bindingIsOwnedByPlugin(compilingPluginName, binding)) {
        bindings.push(binding);
      }
    }
  }
  return dedupeBindings(bindings);
};

export const groupBindingsByOwner = (
  compilingPluginName: string,
  bindings: ReadonlyArray<ResolvedContractBinding>,
): ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>> => {
  const groups = new Map<string, ResolvedContractBinding[]>();
  for (const binding of bindings) {
    const owner = ownerPluginForBinding(compilingPluginName, binding);
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

export const groupAgentToolBindingsByOwner = (
  compilingPluginName: string,
  agent: ComposedAgent,
): ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>> =>
  groupBindingsByOwner(compilingPluginName, agent.toolBindings);

/**
 * Collect every foreign-owner binding referenced by any agent, grouped by
 * owner plugin name and deduplicated. This is the consumer-side view of the
 * tools it needs from each owner plugin.
 */
export const referencedBindingsByOwner = (
  compilingPluginName: string,
  agents: ReadonlyArray<ComposedAgent>,
): ReadonlyMap<string, ReadonlyArray<ResolvedContractBinding>> => {
  const groups = new Map<string, ResolvedContractBinding[]>();
  for (const agent of agents) {
    for (const [owner, bindings] of groupAgentToolBindingsByOwner(
      compilingPluginName,
      agent,
    )) {
      if (owner === compilingPluginName) continue;
      const list = groups.get(owner) ?? [];
      list.push(...bindings);
      groups.set(owner, list);
    }
  }
  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([owner, ownerBindings]) => [owner, dedupeBindings(ownerBindings)]),
  );
};

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