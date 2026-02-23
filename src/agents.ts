/**
 * Agent registry - configurations for all supported AI coding agents
 */

import type { AgentConfig, AgentId } from "./types.js";

export const AGENTS: Record<AgentId, AgentConfig> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    globalConfigPath: "~/.claude/",
    projectConfigPath: ".claude/",
    rulesFile: "CLAUDE.md",
    rulesDir: null,
    commandsDir: "commands/",
    agentsDir: "agents/",
    toolsDir: null, // Uses MCP servers
    skillsDir: "skills/",
    configFile: "settings.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["AGENTS.md"],
  },

  opencode: {
    id: "opencode",
    name: "OpenCode",
    globalConfigPath: "~/.config/opencode/",
    projectConfigPath: ".opencode/",
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: "commands/",
    agentsDir: "agents/",
    toolsDir: null, // Uses plugins
    skillsDir: "skills/", // Native support (similar to Claude Code)
    configFile: "opencode.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsSkills: true, // Native support
    supportsMCP: true,
    alternativeRulesFiles: ["CLAUDE.md"],
  },

  "codex-cli": {
    id: "codex-cli",
    name: "Codex CLI",
    globalConfigPath: "~/.codex/",
    projectConfigPath: null, // No project-level config folder
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: "prompts/", // Custom prompts become /prompts:<name>
    agentsDir: "agents/", // Agent role configs (TOML)
    toolsDir: null, // Uses MCP
    skillsDir: "skills/",
    configFile: "config.toml",
    configFormat: "toml",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true, // Multi-agent support via [agents.*] in config.toml
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["CLAUDE.md"],
  },

  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    globalConfigPath: "~/.gemini/",
    projectConfigPath: ".gemini/",
    rulesFile: "GEMINI.md",
    rulesDir: null,
    commandsDir: null,
    agentsDir: "agents/",
    toolsDir: null, // Uses MCP
    skillsDir: "skills/",
    configFile: "settings.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["AGENTS.md"],
  },

  "amp-code": {
    id: "amp-code",
    name: "Amp Code",
    globalConfigPath: "~/.config/amp/",
    projectConfigPath: ".agents/",
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: null,
    agentsDir: null,
    toolsDir: null, // Uses Toolboxes via $AMP_TOOLBOX
    skillsDir: "skills/",
    configFile: "settings.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: false,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["AGENT.md", "CLAUDE.md"],
  },

  cursor: {
    id: "cursor",
    name: "Cursor",
    globalConfigPath: "~/.cursor/",
    projectConfigPath: ".cursor/",
    rulesFile: ".cursorrules", // Legacy, but still supported
    rulesDir: "rules/", // MDC files
    commandsDir: "commands/",
    agentsDir: null,
    toolsDir: null, // Uses MCP
    skillsDir: "skills/",
    configFile: "mcp.json",
    configFormat: "mdc",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: false,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["AGENTS.md"],
  },

  "factory-droid": {
    id: "factory-droid",
    name: "Factory Droid",
    globalConfigPath: "~/.factory/",
    projectConfigPath: ".factory/",
    rulesFile: "AGENTS.md",
    rulesDir: "rules/",
    commandsDir: "commands/",
    agentsDir: "droids/",
    toolsDir: null, // Uses MCP
    skillsDir: "skills/",
    configFile: "settings.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: [".droid.yaml", "CLAUDE.md"],
  },
};

export function getAgent(id: AgentId): AgentConfig {
  return AGENTS[id];
}

export function getAllAgentIds(): AgentId[] {
  return Object.keys(AGENTS) as AgentId[];
}

export function isValidAgentId(id: string): id is AgentId {
  return id in AGENTS;
}
