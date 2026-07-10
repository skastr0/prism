/**
 * PRISM_HOME layout for the CLI tool surface.
 *
 *   <PRISM_HOME>/runtime/tools/<plugin>/catalog.json
 *   <PRISM_HOME>/runtime/tools/<plugin>/SKILL.md
 *
 * Execution still uses the existing MCP daemon bundle at
 *   <PRISM_HOME>/runtime/mcp/<plugin>/server.mjs
 * via resolve-or-spawn + UDS tools/call — no second business-logic bundle.
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
