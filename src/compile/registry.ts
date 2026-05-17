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
  Hook,
  Identity,
  Orbit,
  Modelspace,
  Personality,
  Skill,
  Skillspace,
  Toolspace,
  Trait,
} from "./sources.js";
import type { PluginManifestTargets, PluginRuntimeConfig } from "../types.js";

export interface PluginRegistry {
  pluginPath: string;
  pluginName: string;
  pluginVersion: string;
  dependencyPaths: Record<string, string>;
  targets: PluginManifestTargets;
  runtime: PluginRuntimeConfig;
  identities: Map<string, Identity>;
  personalities: Map<string, Personality>;
  toolspaces: Map<string, Toolspace>;
  modelspaces: Map<string, Modelspace>;
  skillspaces: Map<string, Skillspace>;
  skills: Map<string, Skill>;
  traits: Map<string, Trait>;
  tools: Map<string, CanonicalTool>;
  hooks: Map<string, Hook>;
  orbits: Map<string, Orbit>;
  agents: Map<string, Agent>;
  deps: Map<string, PluginRegistry>;
}

export const emptyRegistry = (
  pluginPath: string,
  pluginName: string,
  pluginVersion: string,
  dependencyPaths: Record<string, string> = {},
  targets: PluginManifestTargets = {},
  runtime: PluginRuntimeConfig = {},
): PluginRegistry => ({
  pluginPath,
  pluginName,
  pluginVersion,
  dependencyPaths,
  targets,
  runtime,
  identities: new Map(),
  personalities: new Map(),
  toolspaces: new Map(),
  modelspaces: new Map(),
  skillspaces: new Map(),
  skills: new Map(),
  traits: new Map(),
  tools: new Map(),
  hooks: new Map(),
  orbits: new Map(),
  agents: new Map(),
  deps: new Map(),
});

export type Registry = PluginRegistry;
