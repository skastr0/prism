/**
 * Plugin-local registry of parsed compile-language sources.
 *
 * Each registry owns its own source maps plus dep registries keyed by the dep
 * alias declared in plugin.json. Bare refs resolve locally; prefixed refs
 * resolve through the dep map.
 */

import {
  Agent,
  CanonicalTool,
  Identity,
  Lifecycle,
  Modelspace,
  Personality,
  Toolspace,
  Trait,
} from "./sources.js";

export interface PluginRegistry {
  pluginPath: string;
  pluginName: string;
  pluginVersion: string;
  dependencyPaths: Record<string, string>;
  identities: Map<string, Identity>;
  personalities: Map<string, Personality>;
  toolspaces: Map<string, Toolspace>;
  modelspaces: Map<string, Modelspace>;
  traits: Map<string, Trait>;
  tools: Map<string, CanonicalTool>;
  lifecycles: Map<string, Lifecycle>;
  agents: Map<string, Agent>;
  deps: Map<string, PluginRegistry>;
}

export const emptyRegistry = (
  pluginPath: string,
  pluginName: string,
  pluginVersion: string,
  dependencyPaths: Record<string, string> = {},
): PluginRegistry => ({
  pluginPath,
  pluginName,
  pluginVersion,
  dependencyPaths,
  identities: new Map(),
  personalities: new Map(),
  toolspaces: new Map(),
  modelspaces: new Map(),
  traits: new Map(),
  tools: new Map(),
  lifecycles: new Map(),
  agents: new Map(),
  deps: new Map(),
});

export type Registry = PluginRegistry;
