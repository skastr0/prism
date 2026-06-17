import { resolve } from "node:path";
import type { PluginManifest } from "./types.js";

export interface DiscoveredPlugin {
  readonly pluginPath: string;
  readonly manifest: PluginManifest;
}

interface PluginNode {
  readonly plugin: DiscoveredPlugin;
  readonly dependencies: ReadonlySet<string>;
}

/**
 * Topologically sort discovered plugins by their in-directory dependencies.
 *
 * A plugin that declares a `plugin.json` `deps` entry pointing at another
 * discovered plugin is scheduled *after* that owner plugin. Dependencies that
 * resolve outside the discovered set are ignored; the consumer compile phase
 * will fail closed later if the owner's generated artifacts are missing.
 *
 * The sort is stable by plugin name when there is a choice, so output order is
 * deterministic for a given input set.
 */
export const topologicallySortedPlugins = (
  plugins: ReadonlyArray<DiscoveredPlugin>,
): DiscoveredPlugin[] => {
  if (plugins.length === 0) return [];

  const nameToPlugin = new Map<string, DiscoveredPlugin>();
  const pathToName = new Map<string, string>();

  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    if (nameToPlugin.has(name)) {
      throw new Error(
        `Duplicate plugin name '${name}' discovered at ${plugin.pluginPath}`,
      );
    }
    nameToPlugin.set(name, plugin);
    pathToName.set(resolve(plugin.pluginPath), name);
  }

  const nodes = new Map<string, PluginNode>();
  for (const plugin of plugins) {
    const dependencies = new Set<string>();
    for (const depPath of Object.values(plugin.manifest.deps ?? {})) {
      const resolvedDepPath = resolve(plugin.pluginPath, depPath);
      const depName = pathToName.get(resolvedDepPath);
      if (depName !== undefined && depName !== plugin.manifest.name) {
        dependencies.add(depName);
      }
    }
    nodes.set(plugin.manifest.name, { plugin, dependencies });
  }

  const inDegree = new Map<string, number>();
  for (const [name, node] of nodes) {
    inDegree.set(name, node.dependencies.size);
  }

  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));

  const sorted: DiscoveredPlugin[] = [];

  while (queue.length > 0) {
    const name = queue.shift()!;
    const node = nodes.get(name)!;
    sorted.push(node.plugin);

    for (const [otherName, otherNode] of nodes) {
      if (otherName === name) continue;
      if (!otherNode.dependencies.has(name)) continue;

      const newDegree = (inDegree.get(otherName) ?? 0) - 1;
      inDegree.set(otherName, newDegree);
      if (newDegree === 0) {
        queue.push(otherName);
      }
    }
    queue.sort((left, right) => left.localeCompare(right));
  }

  if (sorted.length !== plugins.length) {
    const sortedNames = new Set(sorted.map((plugin) => plugin.manifest.name));
    const remaining = [...nodes.keys()]
      .filter((name) => !sortedNames.has(name))
      .sort((left, right) => left.localeCompare(right));
    throw new Error(
      `Dependency cycle detected among plugins: ${remaining.join(", ")}`,
    );
  }

  return sorted;
};
