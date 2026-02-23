/**
 * Plugin manifest parsing and validation
 */

import { join } from "node:path";
import matter from "gray-matter";
import { exists, expandPath, readFile, readJson } from "./fs.js";
import type {
  AgentId,
  AgentValidationResult,
  PluginManifest,
  SkillFrontmatter,
  SkillValidationResult,
  UnifiedFrontmatter,
} from "./types.js";
import { SKILL_VALIDATION, AGENT_VALIDATION } from "./types.js";
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
    "factory-droid",
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

// =============================================================================
// Skill Validation Functions
// =============================================================================

/**
 * Validate a skill name according to Anthropic's spec
 */
export function validateSkillName(name: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof name !== "string") {
    return {
      valid: false,
      error: `Name must be a string, got ${typeof name}`,
    };
  }

  const trimmed = name.trim();

  if (!trimmed) {
    return { valid: false, error: "Name cannot be empty" };
  }

  if (!SKILL_VALIDATION.NAME_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: `Name '${trimmed}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
    };
  }

  if (
    trimmed.startsWith("-") ||
    trimmed.endsWith("-") ||
    trimmed.includes("--")
  ) {
    return {
      valid: false,
      error: `Name '${trimmed}' cannot start/end with hyphen or contain consecutive hyphens`,
    };
  }

  if (trimmed.length > SKILL_VALIDATION.NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Name is too long (${trimmed.length} characters). Maximum is ${SKILL_VALIDATION.NAME_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate a skill description according to Anthropic's spec
 */
export function validateSkillDescription(description: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof description !== "string") {
    return {
      valid: false,
      error: `Description must be a string, got ${typeof description}`,
    };
  }

  const trimmed = description.trim();

  if (!trimmed) {
    return { valid: false, error: "Description cannot be empty" };
  }

  if (trimmed.includes("<") || trimmed.includes(">")) {
    return {
      valid: false,
      error: "Description cannot contain angle brackets (< or >)",
    };
  }

  if (trimmed.length > SKILL_VALIDATION.DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description is too long (${trimmed.length} characters). Maximum is ${SKILL_VALIDATION.DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate skill frontmatter keys (whitelist check)
 */
export function validateSkillFrontmatterKeys(
  frontmatter: Record<string, unknown>
): { valid: boolean; error?: string } {
  const unexpectedKeys = Object.keys(frontmatter).filter(
    (key) => !SKILL_VALIDATION.ALLOWED_FRONTMATTER_KEYS.has(key)
  );

  if (unexpectedKeys.length > 0) {
    const allowed = [...SKILL_VALIDATION.ALLOWED_FRONTMATTER_KEYS]
      .sort()
      .join(", ");
    return {
      valid: false,
      error: `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.sort().join(", ")}. Allowed properties are: ${allowed}`,
    };
  }

  return { valid: true };
}

/**
 * Validate optional skill fields (allowed-tools, metadata, license)
 */
export function validateSkillOptionalFields(
  frontmatter: Record<string, unknown>
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate allowed-tools if present
  if (frontmatter["allowed-tools"] !== undefined) {
    const tools = frontmatter["allowed-tools"];
    if (!Array.isArray(tools)) {
      errors.push(
        `'allowed-tools' must be an array, got ${typeof tools}`
      );
    } else if (!tools.every((t) => typeof t === "string")) {
      errors.push("'allowed-tools' must be an array of strings");
    }
  }

  // Validate metadata if present
  if (frontmatter.metadata !== undefined) {
    const metadata = frontmatter.metadata;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      errors.push("'metadata' must be an object");
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string") {
          warnings.push(
            `metadata.${key} should be a string, got ${typeof value}`
          );
        }
      }
    }
  }

  // Validate license if present
  if (
    frontmatter.license !== undefined &&
    typeof frontmatter.license !== "string"
  ) {
    errors.push(`'license' must be a string, got ${typeof frontmatter.license}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Parse and validate a SKILL.md file
 */
export async function parseSkillFile(
  filePath: string
): Promise<{
  frontmatter: SkillFrontmatter;
  content: string;
  lineCount: number;
}> {
  const raw = await readFile(filePath);
  const { data, content } = matter(raw);
  const lineCount = content.split("\n").length;

  return {
    frontmatter: data as SkillFrontmatter,
    content: content.trim(),
    lineCount,
  };
}

/**
 * Comprehensive skill validation
 */
export async function validateSkill(
  skillPath: string,
  skillDirName?: string
): Promise<SkillValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const expandedPath = expandPath(skillPath);
  const skillMdPath = join(expandedPath, "SKILL.md");

  // Check SKILL.md exists
  if (!(await exists(skillMdPath))) {
    return {
      valid: false,
      errors: ["SKILL.md not found"],
      warnings: [],
      skillPath: expandedPath,
    };
  }

  // Parse the file
  let frontmatter: Record<string, unknown>;
  let content: string;
  let lineCount: number;

  try {
    const raw = await readFile(skillMdPath);

    // Check frontmatter format
    if (!raw.startsWith("---")) {
      return {
        valid: false,
        errors: ["No YAML frontmatter found (file must start with ---)"],
        warnings: [],
        skillPath: expandedPath,
      };
    }

    const { data, content: parsedContent } = matter(raw);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {
        valid: false,
        errors: ["Frontmatter must be a YAML dictionary"],
        warnings: [],
        skillPath: expandedPath,
      };
    }

    frontmatter = data as Record<string, unknown>;
    content = parsedContent.trim();
    lineCount = content.split("\n").length;
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings: [],
      skillPath: expandedPath,
    };
  }

  // Validate frontmatter keys (whitelist)
  const keysResult = validateSkillFrontmatterKeys(frontmatter);
  if (!keysResult.valid && keysResult.error) {
    errors.push(keysResult.error);
  }

  // Validate required field: name
  if (!("name" in frontmatter)) {
    errors.push("Missing 'name' in frontmatter");
  } else {
    const nameResult = validateSkillName(frontmatter.name);
    if (!nameResult.valid && nameResult.error) {
      errors.push(nameResult.error);
    }

    // Check name matches directory name (if provided)
    if (
      skillDirName &&
      typeof frontmatter.name === "string" &&
      frontmatter.name !== skillDirName
    ) {
      warnings.push(
        `Skill name '${frontmatter.name}' does not match directory name '${skillDirName}'`
      );
    }
  }

  // Validate required field: description
  if (!("description" in frontmatter)) {
    errors.push("Missing 'description' in frontmatter");
  } else {
    const descResult = validateSkillDescription(frontmatter.description);
    if (!descResult.valid && descResult.error) {
      errors.push(descResult.error);
    }
  }

  // Validate optional fields
  const optionalResult = validateSkillOptionalFields(frontmatter);
  errors.push(...optionalResult.errors);
  warnings.push(...optionalResult.warnings);

  // Check body length (warning only)
  if (lineCount > SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES) {
    warnings.push(
      `SKILL.md body is ${lineCount} lines (recommended max: ${SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES}). Consider splitting into reference files.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    skillName: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
    skillPath: expandedPath,
  };
}

/**
 * Validate all skills in a plugin
 */
export async function validatePluginSkills(
  pluginPath: string
): Promise<SkillValidationResult[]> {
  const results: SkillValidationResult[] = [];
  const skillsDir = join(expandPath(pluginPath), "skills");

  if (!(await exists(skillsDir))) {
    return results;
  }

  // Get all subdirectories in skills/
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = join(skillsDir, entry.name);
      const result = await validateSkill(skillPath, entry.name);
      results.push(result);
    }
  }

  return results;
}

// =============================================================================
// Agent Validation Functions
// =============================================================================

/**
 * Validate an agent description
 */
export function validateAgentDescription(description: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof description !== "string") {
    return {
      valid: false,
      error: `Description must be a string, got ${typeof description}`,
    };
  }

  const trimmed = description.trim();

  if (!trimmed) {
    return { valid: false, error: "Description cannot be empty" };
  }

  if (trimmed.length > AGENT_VALIDATION.DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description is too long (${trimmed.length} characters). Maximum is ${AGENT_VALIDATION.DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate an agent definition file
 */
export async function validateAgent(
  agentPath: string
): Promise<AgentValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const expandedPath = expandPath(agentPath);
  const agentName = agentPath.split("/").pop()?.replace(/\.md$/, "");

  // Check file exists
  if (!(await exists(expandedPath))) {
    return {
      valid: false,
      errors: ["Agent file not found"],
      warnings: [],
      agentPath: expandedPath,
    };
  }

  // Parse the file
  let frontmatter: Record<string, unknown>;

  try {
    const raw = await readFile(expandedPath);

    // Check frontmatter format
    if (!raw.startsWith("---")) {
      return {
        valid: false,
        errors: ["No YAML frontmatter found (file must start with ---)"],
        warnings: [],
        agentPath: expandedPath,
        agentName,
      };
    }

    const { data } = matter(raw);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {
        valid: false,
        errors: ["Frontmatter must be a YAML dictionary"],
        warnings: [],
        agentPath: expandedPath,
        agentName,
      };
    }

    frontmatter = data as Record<string, unknown>;
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings: [],
      agentPath: expandedPath,
      agentName,
    };
  }

  // Validate required field: description
  if (!("description" in frontmatter)) {
    errors.push("Missing 'description' in frontmatter");
  } else {
    const descResult = validateAgentDescription(frontmatter.description);
    if (!descResult.valid && descResult.error) {
      errors.push(descResult.error);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    agentName,
    agentPath: expandedPath,
  };
}

/**
 * Validate all agents in a plugin
 */
export async function validatePluginAgents(
  pluginPath: string
): Promise<AgentValidationResult[]> {
  const results: AgentValidationResult[] = [];
  const agentsDir = join(expandPath(pluginPath), "agents");

  if (!(await exists(agentsDir))) {
    return results;
  }

  // Get all .md files in agents/
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(agentsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const agentPath = join(agentsDir, entry.name);
      const result = await validateAgent(agentPath);
      results.push(result);
    }
  }

  return results;
}
