/**
 * Core types for agentpkg - the unified plugin distribution system
 */

// Supported harness identifiers
export type HarnessId =
  | "claude-code"
  | "opencode"
  | "openclaw"
  | "codex-cli"
  | "gemini-cli"
  | "amp-code"
  | "cursor"
  | "factory-droid";

// Harness configuration - describes where each harness stores its artifacts
export interface HarnessConfig {
  id: HarnessId;
  name: string;

  // Path configurations (~ will be expanded)
  globalConfigPath: string;
  projectConfigPath: string | null;

  // Rules configuration (null means agentpkg does not manage a rules surface)
  rulesFile: string | null;
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

  // Alternative rules filenames this harness recognizes
  alternativeRulesFiles?: string[];
}

export const PLUGIN_ARTIFACT_TYPES = ["rules", "commands", "agents", "skills"] as const;
export type PluginArtifactType = (typeof PLUGIN_ARTIFACT_TYPES)[number];

export const TARGET_PRESET_IDS = ["coding-harness", "claw-harness"] as const;
export type TargetPresetId = (typeof TARGET_PRESET_IDS)[number];

export type PluginTargetId = HarnessId | TargetPresetId;
export type PluginManifestTargets = Partial<
  Record<PluginArtifactType, PluginTargetId[]>
>;

// Plugin manifest (plugin.json)
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;

  // Per-artifact install targeting declared in plugin.json
  targets: PluginManifestTargets;

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
  harnesses: HarnessId[];
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
  harness: HarnessId;
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

// Permission type for OpenCode agents
export type OpenCodePermission = "allow" | "ask" | "deny";

// OpenCode typed frontmatter block used where agentpkg models OpenCode-specific settings
export interface OpenCodeAgentFrontmatter {
  // Agent description (triggers agent selection)
  description?: string;

  // Visibility mode
  // - subagent: Only available as Task subagent (not in picker)
  // - primary: Available in agent picker for direct use
  // - all: Available both as subagent and in picker (default)
  mode?: "subagent" | "primary" | "all";

  // Model configuration
  model?: string; // e.g., "anthropic/claude-sonnet-4-20250514"
  temperature?: number; // 0.0 - 2.0
  top_p?: number; // Top-p sampling parameter

  // Tool access - enable/disable specific tools
  tools?: Record<string, boolean>;

  // UI customization
  color?: string; // Hex color (e.g., "#FF5733")

  // Behavior limits
  maxSteps?: number; // Max agentic iterations (positive integer)

  // Agent state
  disable?: boolean; // Disable the agent entirely

  // Permission overrides
  permission?: {
    edit?: OpenCodePermission;
    bash?: OpenCodePermission | Record<string, OpenCodePermission>;
    webfetch?: OpenCodePermission;
    doom_loop?: OpenCodePermission;
    external_directory?: OpenCodePermission;
  };
}

// Claude Code typed frontmatter block
export interface ClaudeCodeFrontmatter {
  description?: string;
  "allowed-tools"?: string[];
  model?: "sonnet" | "opus" | "haiku" | string;
}

// Cursor typed frontmatter block
export interface CursorFrontmatter {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
}

// Factory Droid typed frontmatter block
export interface FactoryDroidFrontmatter {
  description?: string;
  model?: string | "inherit";
  reasoningEffort?: "low" | "medium" | "high";
  tools?: string | string[];
  "user-invocable"?: boolean;
  "disable-model-invocation"?: boolean;
  "argument-hint"?: string;
}

// Codex CLI typed frontmatter block
export interface CodexCliFrontmatter {
  description?: string;
  model?: string;
  model_reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  sandbox_mode?: "read-only" | "full" | "danger-full-access";
}

// Command/Agent frontmatter for unified format
export interface UnifiedFrontmatter {
  description?: string;

  // Harness-specific overrides (typed where known)
  "claude-code"?: ClaudeCodeFrontmatter;
  opencode?: OpenCodeAgentFrontmatter;
  openclaw?: Record<string, unknown>;
  "codex-cli"?: CodexCliFrontmatter;
  "gemini-cli"?: Record<string, unknown>;
  "amp-code"?: Record<string, unknown>;
  cursor?: CursorFrontmatter;
  "factory-droid"?: FactoryDroidFrontmatter;
}

// Skill-specific frontmatter (stricter than unified)
export interface SkillFrontmatter {
  name: string;
  description: string;
  compatibility?: string;
  license?: string;
  "allowed-tools"?: string[];
  metadata?: Record<string, string>;
}

// Skill validation constants
export const SKILL_VALIDATION = {
  NAME_MAX_LENGTH: 64,
  NAME_PATTERN: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  DESCRIPTION_MAX_LENGTH: 1024,
  COMPATIBILITY_MAX_LENGTH: 500,
  RECOMMENDED_BODY_MAX_LINES: 500,
  ALLOWED_FRONTMATTER_KEYS: new Set([
    "name",
    "description",
    "compatibility",
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

// Agent validation result with additional context
export interface AgentValidationResult extends ValidationResult {
  agentName?: string;
  agentPath: string;
}

// Agent validation constants
export const AGENT_VALIDATION = {
  DESCRIPTION_MAX_LENGTH: 1024,
} as const;
