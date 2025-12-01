/**
 * Plugin manifest parsing and validation
 */

import { join } from "node:path";
import matter from "gray-matter";
import { exists, expandPath, readFile, readJson } from "./fs.js";
import type { AgentId, PluginManifest, UnifiedFrontmatter } from "./types.js";
import { isValidAgentId } from "./agents.js";

const MANIFEST_FILE = "plugin.json";

/**
 * Read and validate plugin manifest
 */
export async function readManifest(pluginPath: string): Promise<PluginManifest> {
  const manifestPath = join(expandPath(pluginPath), MANIFEST_FILE);

  if (!(await exists(manifestPath))) {
    throw new Error(`Plugin manifest not found: ${manifestPath}`);
  }

  const manifest = await readJson<PluginManifest>(manifestPath);
  validateManifest(manifest);
  return manifest;
}

/**
 * Validate manifest structure
 */
function validateManifest(manifest: unknown): asserts manifest is PluginManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: must be an object");
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new Error("Invalid manifest: 'name' is required");
  }

  if (typeof m.version !== "string" || m.version.length === 0) {
    throw new Error("Invalid manifest: 'version' is required");
  }

  if (m.targets !== "all") {
    if (!Array.isArray(m.targets)) {
      throw new Error("Invalid manifest: 'targets' must be 'all' or an array of agent IDs");
    }
    for (const target of m.targets) {
      if (!isValidAgentId(target)) {
        throw new Error(`Invalid manifest: unknown agent ID '${target}'`);
      }
    }
  }
}

/**
 * Check if manifest targets a specific agent
 */
export function manifestTargetsAgent(
  manifest: PluginManifest,
  agentId: AgentId
): boolean {
  if (manifest.targets === "all") {
    return true;
  }
  return manifest.targets.includes(agentId);
}

/**
 * Parse markdown file with frontmatter
 */
export async function parseMarkdownFile(
  filePath: string
): Promise<{ frontmatter: UnifiedFrontmatter; content: string }> {
  const raw = await readFile(filePath);
  const { data, content } = matter(raw);
  return {
    frontmatter: data as UnifiedFrontmatter,
    content: content.trim(),
  };
}

/**
 * Extract agent-specific frontmatter, merging with base frontmatter
 */
export function getAgentFrontmatter(
  frontmatter: UnifiedFrontmatter,
  agentId: AgentId
): Record<string, unknown> {
  const { targets, ...base } = frontmatter;

  // Remove all agent-specific keys from base
  const agentKeys: AgentId[] = [
    "claude-code",
    "opencode",
    "codex-cli",
    "gemini-cli",
    "amp-code",
    "cursor",
  ];

  const cleanBase: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!agentKeys.includes(key as AgentId)) {
      cleanBase[key] = value;
    }
  }

  // Merge with agent-specific overrides
  const agentSpecific = frontmatter[agentId] ?? {};
  return { ...cleanBase, ...agentSpecific };
}

/**
 * Check if frontmatter targets a specific agent
 */
export function frontmatterTargetsAgent(
  frontmatter: UnifiedFrontmatter,
  agentId: AgentId
): boolean {
  if (!frontmatter.targets) {
    return true; // No targets = all agents
  }
  return frontmatter.targets.includes(agentId);
}

/**
 * Serialize frontmatter back to YAML format
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>
): string {
  if (Object.keys(frontmatter).length === 0) {
    return "";
  }

  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;

    if (typeof value === "string") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.every((v) => typeof v === "string")) {
        lines.push(`${key}: [${value.join(", ")}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`  ${k}: ${v}`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Reconstruct markdown file with new frontmatter
 */
export function reconstructMarkdown(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  const fm = serializeFrontmatter(frontmatter);
  if (fm.length === 0) {
    return content;
  }
  return `${fm}\n\n${content}`;
}
