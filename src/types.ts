/**
 * Core types for agentpkg - the unified plugin distribution system
 */

// Supported agent identifiers
export type AgentId =
  | "claude-code"
  | "opencode"
  | "codex-cli"
  | "gemini-cli"
  | "amp-code"
  | "cursor";

// Agent configuration - describes where each agent stores its artifacts
export interface AgentConfig {
  id: AgentId;
  name: string;

  // Path configurations (~ will be expanded)
  globalConfigPath: string;
  projectConfigPath: string | null;

  // Rules configuration
  rulesFile: string;
  rulesDir: string | null;

  // Artifact directories (relative to config paths)
  commandsDir: string | null;
  agentsDir: string | null;
  toolsDir: string | null;
  skillsDir: string | null;

  // Main config file
  configFile: string | null;
  configFormat: "json" | "yaml" | "toml" | "markdown" | "mdc";

  // Feature support
  supportsTools: boolean;
  supportsCommands: boolean;
  supportsAgents: boolean;
  supportsSkills: boolean;
  supportsMCP: boolean;

  // Alternative rules filenames this agent recognizes
  alternativeRulesFiles?: string[];
}

// Plugin manifest (plugin.json)
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;

  // Which agents this plugin targets ("all" or specific list)
  targets: AgentId[] | "all";

  // Project patterns for project-specific rules
  projects?: Record<string, ProjectConfig>;
}

export interface ProjectConfig {
  // Path pattern or name to match
  pattern?: string;
  // Subdirectory in rules/project/ to use
  rulesDir?: string;
}

// Installation options
export interface InstallOptions {
  pluginPath: string;
  agents: AgentId[];
  projectPath?: string;
  overwrite: boolean;
  backup: boolean;
  dryRun: boolean;
}

// File operation types for the installation plan
export type FileOperationType = "copy" | "append" | "merge" | "skip";

export interface FileOperation {
  type: FileOperationType;
  source: string;
  target: string;
  agent: AgentId;
  artifact: "rules" | "command" | "agent" | "tool" | "skill" | "config";
  reason?: string; // For skips or special handling
}

// Result of an installation
export interface InstallResult {
  success: boolean;
  operations: FileOperation[];
  errors: InstallError[];
  backups: string[];
}

export interface InstallError {
  operation: FileOperation;
  message: string;
}

// Command/Agent frontmatter for unified format
export interface UnifiedFrontmatter {
  description?: string;
  targets?: AgentId[];

  // Agent-specific overrides
  "claude-code"?: Record<string, unknown>;
  opencode?: Record<string, unknown>;
  "codex-cli"?: Record<string, unknown>;
  "gemini-cli"?: Record<string, unknown>;
  "amp-code"?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
}

// Skill-specific frontmatter (stricter than unified)
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  "allowed-tools"?: string[];
  metadata?: Record<string, string>;
}

// Skill validation constants
export const SKILL_VALIDATION = {
  NAME_MAX_LENGTH: 64,
  NAME_PATTERN: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  DESCRIPTION_MAX_LENGTH: 1024,
  RECOMMENDED_BODY_MAX_LINES: 500,
  ALLOWED_FRONTMATTER_KEYS: new Set([
    "name",
    "description",
    "license",
    "allowed-tools",
    "metadata",
  ]),
} as const;

// Validation result type
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Skill validation result with additional context
export interface SkillValidationResult extends ValidationResult {
  skillName?: string;
  skillPath: string;
}
