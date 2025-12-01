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
    commandsDir: "command/",
    agentsDir: "agent/",
    toolsDir: null, // Uses plugins
    skillsDir: null,
    configFile: "opencode.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsSkills: false,
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
    agentsDir: null,
    toolsDir: null, // Uses MCP
    skillsDir: null,
    configFile: "config.toml",
    configFormat: "toml",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: false,
    supportsSkills: false,
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
    commandsDir: "commands/", // TOML format
    agentsDir: null,
    toolsDir: null, // Uses MCP
    skillsDir: null,
    configFile: "settings.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: false,
    supportsSkills: false,
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
    commandsDir: "commands/",
    agentsDir: null,
    toolsDir: null, // Uses Toolboxes via $AMP_TOOLBOX
    skillsDir: null,
    configFile: "settings.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: false,
    supportsSkills: false,
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
    commandsDir: null,
    agentsDir: null,
    toolsDir: null, // Uses MCP
    skillsDir: null,
    configFile: "mcp.json",
    configFormat: "mdc",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: false,
    supportsSkills: false,
    supportsMCP: true,
    alternativeRulesFiles: ["AGENTS.md"],
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
