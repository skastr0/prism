/**
 * PRISM_HOME layout for the CLI tool surface.
 *
 *   <PRISM_HOME>/runtime/tools/<plugin>/catalog.json
 *   <PRISM_HOME>/runtime/tools/<plugin>/SKILL.md
 *   <PRISM_HOME>/runtime/tools/<plugin>/runtime.mjs
 *
 * Invoke loads runtime.mjs in-process. No daemon. No MCP.
 */

import { join } from "node:path";
import { normalizeBundleSegment } from "../compile/lowerers/shared.js";

export const prismToolsRuntimeDir = (prismHome: string): string =>
  join(prismHome, "runtime", "tools");

export const prismToolPluginDir = (prismHome: string, pluginName: string): string =>
  join(prismToolsRuntimeDir(prismHome), normalizeBundleSegment(pluginName));

export const prismToolCatalogPath = (prismHome: string, pluginName: string): string =>
  join(prismToolPluginDir(prismHome, pluginName), "catalog.json");

export const prismToolSkillPath = (prismHome: string, pluginName: string): string =>
  join(prismToolPluginDir(prismHome, pluginName), "SKILL.md");

export const prismToolRuntimePath = (prismHome: string, pluginName: string): string =>
  join(prismToolPluginDir(prismHome, pluginName), "runtime.mjs");
