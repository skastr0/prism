/**
 * Agent-facing surface for compiled tools (replaces MCP discovery).
 *
 * Always: catalogs + `prism tools invoke` (written by writeToolCliCatalog).
 * Additionally, per inject mode:
 *   - skill (default): install skill + thin always-on rules pointer
 *   - rules: full tool inventory as always-on rules (MCP-like), no skill file
 */

import { join } from "node:path";
import { HARNESSES } from "../harnesses.js";
import type { HarnessId } from "../types.js";
import type { DesiredFile, DesiredRegion } from "../sync/desired.js";
import { normalizeBundleSegment } from "../compile/lowerers/shared.js";
import type { ToolCliCatalog } from "./catalog.js";
import type { ToolsCliInjectMode } from "./flags.js";
import { prismToolSkillPath } from "./paths.js";
import { exists, readFile } from "../fs.js";

/** Harnesses that load skills/ trees directly (skill file install target). */
export const TOOLS_CLI_SKILL_HARNESSES = new Set<HarnessId>([
  "codex-cli",
  "hermes",
  "opencode",
  "grok",
]);

export const toolsCliSkillName = (pluginName: string): string =>
  `prism-tools-${normalizeBundleSegment(pluginName)}`;

export const toolsCliRulesRegionKey = (pluginName: string): string =>
  `tools-cli.${normalizeBundleSegment(pluginName)}`;

/**
 * Full inventory — always-on rules that simulate MCP tool discovery.
 * Agents see every tool name + invoke recipe without loading a skill.
 */
export const renderToolCliRulesFull = (catalog: ToolCliCatalog): string => {
  const skill = toolsCliSkillName(catalog.plugin);
  const toolLines =
    catalog.tools.length === 0
      ? ["_(no tools)_"]
      : catalog.tools.map(
          (tool) =>
            `- \`${tool.name}\` — ${tool.description}\n  \`prism tools invoke ${catalog.plugin} ${tool.name} --input '{}'\``,
        );

  return [
    `## Prism tools: ${catalog.plugin}`,
    "",
    "These tools are **stateless CLI calls** (not MCP stdio). Prefer shell invoke over shims.",
    "",
    "### Invoke",
    "",
    "```bash",
    `prism tools invoke ${catalog.plugin} <tool-name> --input '<json-object>'`,
    `prism tools list --plugin ${catalog.plugin}`,
    "```",
    "",
    "### Tools",
    "",
    ...toolLines,
    "",
    "### Notes",
    "",
    `- Full skill doc (optional detail): \`${skill}\``,
    "- Do not spawn `prism mcp shim` for these tools.",
    "",
  ].join("\n");
};

/**
 * Pointer-only rules for skill mode — headers + skill name, not full bodies.
 * Always-on context tells the agent which tools exist and which skill holds them.
 */
export const renderToolCliRulesPointer = (catalog: ToolCliCatalog): string => {
  const skill = toolsCliSkillName(catalog.plugin);
  const names =
    catalog.tools.length === 0
      ? "_(none)_"
      : catalog.tools.map((t) => `\`${t.name}\``).join(", ");

  return [
    `## Prism tools: ${catalog.plugin}`,
    "",
    `Tools: ${names}`,
    "",
    `Load skill \`${skill}\` for invoke recipes and full descriptions.`,
    "",
    "Shell surface (preferred over MCP):",
    "",
    "```bash",
    `prism tools invoke ${catalog.plugin} <tool-name> --input '<json-object>'`,
    `prism tools list --plugin ${catalog.plugin}`,
    "```",
    "",
    "Do not spawn `prism mcp shim` for these tools.",
    "",
  ].join("\n");
};

export const renderToolCliRules = (
  catalog: ToolCliCatalog,
  mode: ToolsCliInjectMode,
): string => (mode === "rules" ? renderToolCliRulesFull(catalog) : renderToolCliRulesPointer(catalog));

const commentStyleForRulesFile = (
  rulesFile: string,
): { readonly prefix: string; readonly suffix?: string } => {
  // Markdown-ish rule files use HTML comments; bare rules (.cursorrules) use #.
  if (rulesFile.endsWith(".md") || rulesFile.toLowerCase().includes("agents")) {
    return { prefix: "<!--", suffix: " -->" };
  }
  if (rulesFile.endsWith(".mdc") || rulesFile === ".cursorrules") {
    return { prefix: "#" };
  }
  return { prefix: "<!--", suffix: " -->" };
};

export interface PlanToolsCliAgentSurfaceOptions {
  readonly mode: ToolsCliInjectMode;
  readonly targetId: HarnessId;
  readonly outputRoot: string;
  readonly prismHome: string;
  readonly pluginName: string;
  readonly catalog: ToolCliCatalog;
}

export interface PlanToolsCliAgentSurfaceResult {
  readonly files: DesiredFile[];
  readonly regions: DesiredRegion[];
}

/**
 * Plan skill install + rules region for one harness after CLI catalog is written.
 */
export const planToolsCliAgentSurface = async (
  options: PlanToolsCliAgentSurfaceOptions,
): Promise<PlanToolsCliAgentSurfaceResult> => {
  const files: DesiredFile[] = [];
  const regions: DesiredRegion[] = [];
  const plugin = options.pluginName;
  const skillName = toolsCliSkillName(plugin);

  if (options.mode === "skill" && TOOLS_CLI_SKILL_HARNESSES.has(options.targetId)) {
    const skillSrc = prismToolSkillPath(options.prismHome, plugin);
    if (await exists(skillSrc)) {
      files.push({
        targetPath: join(options.outputRoot, "skills", skillName, "SKILL.md"),
        content: await readFile(skillSrc),
        plugin,
      });
    }
  }

  const harness = HARNESSES[options.targetId];
  if (harness?.rulesFile) {
    const style = commentStyleForRulesFile(harness.rulesFile);
    regions.push({
      kind: "marker",
      targetPath: join(options.outputRoot, harness.rulesFile),
      regionKey: toolsCliRulesRegionKey(plugin),
      commentPrefix: style.prefix,
      ...(style.suffix !== undefined ? { commentSuffix: style.suffix } : {}),
      content: renderToolCliRules(options.catalog, options.mode),
      plugin,
    });
  }

  return { files, regions };
};
