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
  Skill,
  Skillspace,
  Toolspace,
  Trait,
} from "./sources.js";
import type { PluginManifestTargets } from "../types.js";

export interface PluginRegistry {
  pluginPath: string;
  pluginName: string;
  pluginVersion: string;
  dependencyPaths: Record<string, string>;
  targets: PluginManifestTargets;
  identities: Map<string, Identity>;
  personalities: Map<string, Personality>;
  toolspaces: Map<string, Toolspace>;
  modelspaces: Map<string, Modelspace>;
  skillspaces: Map<string, Skillspace>;
  skills: Map<string, Skill>;
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
  targets: PluginManifestTargets = {},
): PluginRegistry => ({
  pluginPath,
  pluginName,
  pluginVersion,
  dependencyPaths,
  targets,
  identities: new Map(),
  personalities: new Map(),
  toolspaces: new Map(),
  modelspaces: new Map(),
  skillspaces: new Map(),
  skills: new Map(),
  traits: new Map(),
  tools: new Map(),
  lifecycles: new Map(),
  agents: new Map(),
  deps: new Map(),
});

export type Registry = PluginRegistry;
