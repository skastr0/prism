/**
 * Harness registry - configurations for all supported AI coding harnesses
 */

import { join } from "node:path";
import { expandPath } from "./fs.js";
import type { HarnessConfig, HarnessId, HarnessScope } from "./types.js";

export const HARNESSES: Record<HarnessId, HarnessConfig> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    globalConfigPath: "~/.claude/",
    projectConfigPath: ".claude/",
    rulesFile: "CLAUDE.md",
    rulesDir: null,
    commandsDir: "commands/",
    agentsDir: "agents/",
    toolsDir: null,
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
    toolsDir: null,
    skillsDir: "skills/",
    configFile: "opencode.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["CLAUDE.md"],
  },

  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    globalConfigPath: "~/.openclaw/",
    projectConfigPath: null,
    rulesFile: null,
    rulesDir: null,
    commandsDir: null,
    agentsDir: null,
    toolsDir: null,
    skillsDir: "skills/",
    configFile: null,
    configFormat: "json",
    supportsTools: false,
    supportsCommands: false,
    supportsAgents: false,
    supportsSkills: true,
    supportsMCP: false,
  },

  "codex-cli": {
    id: "codex-cli",
    name: "Codex CLI",
    globalConfigPath: "~/.codex/",
    projectConfigPath: null,
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: "prompts/",
    agentsDir: "agents/",
    toolsDir: null,
    skillsDir: "skills/",
    configFile: "config.toml",
    configFormat: "toml",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
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
    commandsDir: "commands/",
    agentsDir: "agents/",
    toolsDir: null,
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

  "amp-code": {
    id: "amp-code",
    name: "Amp Code",
    globalConfigPath: "~/.config/amp/",
    projectConfigPath: ".agents/",
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: null,
    agentsDir: null,
    toolsDir: null,
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
    rulesFile: ".cursorrules",
    rulesDir: "rules/",
    commandsDir: "commands/",
    agentsDir: null,
    toolsDir: null,
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
    toolsDir: null,
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

export function getHarness(id: HarnessId): HarnessConfig {
  return HARNESSES[id];
}

export function getAllHarnessIds(): HarnessId[] {
  return Object.keys(HARNESSES) as HarnessId[];
}

export function isValidHarnessId(id: string): id is HarnessId {
  return id in HARNESSES;
}

export function resolveHarnessRoot(
  harness: HarnessConfig,
  scope: HarnessScope,
  projectPath?: string
): string | null {
  if (scope === "global") {
    return expandPath(harness.globalConfigPath);
  }

  if (!harness.projectConfigPath || !projectPath) {
    return null;
  }

  return join(expandPath(projectPath), harness.projectConfigPath);
}

export function harnessSupportsProjectScope(harness: HarnessConfig): boolean {
  return harness.projectConfigPath !== null;
}
