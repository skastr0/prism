/**
 * Pure registry → introspection summary.
 *
 * Transforms a PluginRegistry into a PluginIntrospection for the TUI to render.
 */

import type {
  IntrospectionEntry,
  IntrospectionNounGroup,
  PluginIntrospection,
} from "./model.js";
import type { PluginRegistry } from "../compile/registry.js";

/**
 * Build an introspection summary from a plugin registry.
 *
 * For each non-empty Map in the registry (agents, orbits, tools, skills, hooks,
 * identities, personalities, traits, toolspaces, modelspaces, skillspaces),
 * creates an IntrospectionNounGroup with sorted entries.
 *
 * Note: Groups are included only when count > 0 (simpler and matches typical
 * usage; empty groups are omitted to keep the summary focused).
 *
 * @param registry - The plugin registry to introspect
 * @returns A PluginIntrospection with all non-empty noun groups and the orbit skill count
 */
export const buildIntrospection = (registry: PluginRegistry): PluginIntrospection => {
  // Maps to introspect, in order specified
  const mapEntries: Array<[string, Map<string, unknown>]> = [
    ["agent", registry.agents],
    ["orbit", registry.orbits],
    ["tool", registry.tools],
    ["skill", registry.skills],
    ["hook", registry.hooks],
    ["identity", registry.identities],
    ["personality", registry.personalities],
    ["trait", registry.traits],
    ["toolspace", registry.toolspaces],
    ["modelspace", registry.modelspaces],
    ["skillspace", registry.skillspaces],
  ];

  const groups: IntrospectionNounGroup[] = [];

  for (const [noun, map] of mapEntries) {
    // Include group only if count > 0
    if (map.size > 0) {
      const entries: IntrospectionEntry[] = [...map.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, value]) => {
          // Safely extract description from value
          const summary =
            typeof (value as { description?: unknown }).description === "string"
              ? (value as { description: string }).description
              : undefined;

          return {
            name,
            summary,
            json: value,
          };
        });

      groups.push({
        noun,
        count: map.size,
        entries,
      });
    }
  }

  return {
    pluginName: registry.pluginName,
    groups,
    orbitSkillCount: registry.orbits.size,
  };
};
