/**
 * Agent-facing surface for compiled tools (CLI discovery).
 *
 * Always: catalogs + runtime.mjs + `prism tools invoke`.
 * Additionally, per inject mode:
 *   - skill (default): install skill + thin always-on rules pointer
 *   - rules: full tool inventory as always-on rules, no skill file
 */

import { join } from "node:path";
import { HARNESSES } from "../harnesses.js";
import type { HarnessId } from "../types.js";
import type { DesiredFile, DesiredRegion } from "../sync/desired.js";
import { normalizeBundleSegment } from "../compile/lowerers/shared.js";
import {
  renderToolCliSkillMarkdown,
  type ToolCliCatalog,
} from "./catalog.js";
import type { ToolsCliInjectMode } from "./flags.js";

/** Harnesses with a native skills/ surface, direct or generated-plugin-local. */
export const TOOLS_CLI_SKILL_HARNESSES = new Set<HarnessId>([
  "codex-cli",
  "hermes",
  "opencode",
  "grok",
  "antigravity-cli",
  "kimi-code",
]);

export const toolsCliSkillName = (pluginName: string): string =>
  `prism-tools-${normalizeBundleSegment(pluginName)}`;

export const toolsCliRulesRegionKey = (pluginName: string): string =>
  `tools-cli.${normalizeBundleSegment(pluginName)}`;

/**
 * Whether this target also receives the `prism-tools-<plugin>` skill file.
 * Only `TOOLS_CLI_SKILL_HARNESSES` install it; every other target gets the
 * CLI-runtime rules region alone, so its pointer must not name a skill that
 * was never written.
 */
export interface ToolCliSkillPointerOptions {
  readonly skillInstalled: boolean;
}

const toolInventoryPointer = (
  catalog: ToolCliCatalog,
  options: ToolCliSkillPointerOptions,
): string =>
  options.skillInstalled
    ? `Load skill \`${toolsCliSkillName(catalog.plugin)}\` for invoke recipes and full descriptions.`
    : `Run \`prism tools list --plugin ${catalog.plugin}\` for invoke recipes and full descriptions.`;

/**
 * Full inventory — always-on rules for tool discovery without loading a skill.
 */
export const renderToolCliRulesFull = (
  catalog: ToolCliCatalog,
  options: ToolCliSkillPointerOptions,
): string => {
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
    "These tools are **stateless CLI calls** (in-process `prism tools invoke`).",
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
    options.skillInstalled
      ? `- Full skill doc (optional detail): \`${toolsCliSkillName(catalog.plugin)}\``
      : `- Full tool list: \`prism tools list --plugin ${catalog.plugin}\``,
    "",
  ].join("\n");
};

/**
 * Pointer-only rules for skill mode — headers + skill name, not full bodies.
 * Always-on context tells the agent which tools exist and which skill holds them.
 */
export const renderToolCliRulesPointer = (
  catalog: ToolCliCatalog,
  options: ToolCliSkillPointerOptions,
): string => {
  const names =
    catalog.tools.length === 0
      ? "_(none)_"
      : catalog.tools.map((t) => `\`${t.name}\``).join(", ");

  return [
    `## Prism tools: ${catalog.plugin}`,
    "",
    `Tools: ${names}`,
    "",
    toolInventoryPointer(catalog, options),
    "",
    "Shell surface:",
    "",
    "```bash",
    `prism tools invoke ${catalog.plugin} <tool-name> --input '<json-object>'`,
    `prism tools list --plugin ${catalog.plugin}`,
    "```",
    "",
    "",
  ].join("\n");
};

export const renderToolCliRules = (
  catalog: ToolCliCatalog,
  mode: ToolsCliInjectMode,
  options: ToolCliSkillPointerOptions,
): string =>
  mode === "rules"
    ? renderToolCliRulesFull(catalog, options)
    : renderToolCliRulesPointer(catalog, options);

export interface ToolCliAgentGroup {
  readonly pluginName: string;
  readonly toolNames: ReadonlyArray<string>;
}

/**
 * Thin per-role pointer for plugin-bundle harnesses that cannot inherit a
 * shared AGENTS.md rules region. This deliberately names the skill and CLI
 * command only; it never inlines the generated skill body into every agent.
 */
export const renderToolCliAgentGuidance = (
  groups: ReadonlyArray<ToolCliAgentGroup>,
  mode: ToolsCliInjectMode,
): string => {
  const normalized = groups
    .map((group) => ({
      pluginName: group.pluginName,
      toolNames: [...new Set(group.toolNames)].sort((left, right) => left.localeCompare(right)),
    }))
    .filter((group) => group.toolNames.length > 0)
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName));
  if (normalized.length === 0) return "";

  const lines = [
    "## Prism CLI tools",
    "",
    "Canonical tools are exposed through stateless CLI calls, not MCP tool names.",
    "",
  ];
  for (const group of normalized) {
    const tools = group.toolNames.map((tool) => `\`${tool}\``).join(", ");
    if (mode === "skill") {
      lines.push(
        `- Load skill \`${toolsCliSkillName(group.pluginName)}\` for ${tools}; invoke with \`prism tools invoke ${group.pluginName} <tool-name> --input '<json-object>'\`.`,
      );
    } else {
      lines.push(
        `- ${tools} -> \`prism tools invoke ${group.pluginName} <tool-name> --input '<json-object>'\`.`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

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
  readonly pluginName: string;
  readonly catalog: ToolCliCatalog;
}

export interface PlanToolsCliAgentSurfaceResult {
  readonly files: DesiredFile[];
  readonly regions: DesiredRegion[];
}

const generatedPluginRoot = (
  targetId: "antigravity-cli" | "kimi-code",
  outputRoot: string,
  pluginName: string,
): string => {
  // Antigravity's lowerer predates the shared bundle segment and collapses
  // dots/underscores to hyphens; Kimi uses the shared segment verbatim. The
  // CLI surface must land inside the exact plugin root each lowerer owns.
  const segment = targetId === "antigravity-cli"
    ? pluginName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "plugin"
    : normalizeBundleSegment(pluginName);
  const generatedId = `prism-generated-${segment}`;
  return targetId === "antigravity-cli"
    ? join(outputRoot, "plugins", generatedId)
    : join(outputRoot, "plugins", "managed", generatedId);
};

const toolCliSkillTargetPath = (
  options: PlanToolsCliAgentSurfaceOptions,
  skillName: string,
): string => {
  if (options.targetId === "antigravity-cli" || options.targetId === "kimi-code") {
    return join(
      generatedPluginRoot(options.targetId, options.outputRoot, options.pluginName),
      "skills",
      skillName,
      "SKILL.md",
    );
  }
  return join(options.outputRoot, "skills", skillName, "SKILL.md");
};

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
  const skillInstalled =
    options.mode === "skill" && TOOLS_CLI_SKILL_HARNESSES.has(options.targetId);
  const pointerOptions: ToolCliSkillPointerOptions = { skillInstalled };

  if (skillInstalled) {
    files.push({
      targetPath: toolCliSkillTargetPath(options, skillName),
      content: renderToolCliSkillMarkdown(options.catalog),
      plugin,
    });
  }

  if (options.targetId === "antigravity-cli") {
    files.push({
      targetPath: join(
        generatedPluginRoot(options.targetId, options.outputRoot, plugin),
        "rules",
        `${skillName}.md`,
      ),
      content: renderToolCliRules(options.catalog, options.mode, pointerOptions),
      plugin,
    });
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
      content: renderToolCliRules(options.catalog, options.mode, pointerOptions),
      plugin,
    });
  }

  return { files, regions };
};
