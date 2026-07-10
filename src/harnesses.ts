/**
 * Harness registry - configurations for all supported AI coding harnesses
 */

import { join } from "node:path";
import { Layer } from "effect";
import { expandPath } from "./fs.js";
import { HarnessRoots, type HarnessRootsEnv } from "./services/prism-env.js";
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
    agentsDir: "agents/",
    toolsDir: null,
    skillsDir: "skills/",
    configFile: null,
    configFormat: "json",
    supportsTools: false,
    supportsCommands: false,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: false,
  },

  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    globalConfigPath: "~/.hermes/",
    projectConfigPath: null,
    rulesFile: null,
    rulesDir: null,
    commandsDir: null,
    agentsDir: null,
    toolsDir: null,
    skillsDir: "skills/",
    configFile: "config.yaml",
    configFormat: "yaml",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: false,
    supportsSkills: true,
    supportsMCP: true,
  },

  "codex-cli": {
    id: "codex-cli",
    name: "Codex CLI",
    globalConfigPath: "~/.codex/",
    projectConfigPath: ".codex/",
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

  "antigravity-cli": {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    globalConfigPath: "~/.gemini/antigravity-cli/",
    projectConfigPath: ".agents/",
    rulesFile: null,
    rulesDir: "rules/",
    commandsDir: null,
    agentsDir: "agents/",
    toolsDir: null,
    skillsDir: "skills/",
    configFile: "mcp_config.json",
    configFormat: "json",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: ["AGENTS.md", "ANTIGRAVITY.md"],
  },

  "kimi-code": {
    id: "kimi-code",
    name: "Kimi Code",
    globalConfigPath: "~/.kimi-code/",
    projectConfigPath: null,
    rulesFile: null,
    rulesDir: null,
    commandsDir: null,
    agentsDir: null,
    toolsDir: null,
    skillsDir: "skills/",
    configFile: "config.toml",
    configFormat: "toml",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: false,
    supportsSkills: true,
    supportsMCP: true,
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
    commandsDir: null,
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

  pi: {
    id: "pi",
    name: "Pi",
    globalConfigPath: "~/.pi/agent/",
    projectConfigPath: ".pi/",
    rulesFile: null,
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
    supportsMCP: false,
  },

  grok: {
    id: "grok",
    name: "Grok Build",
    globalConfigPath: "~/.grok/",
    projectConfigPath: ".grok/",
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: null,
    agentsDir: "agents/",
    toolsDir: null,
    skillsDir: "skills/",
    configFile: "config.toml",
    configFormat: "toml",
    supportsTools: true,
    supportsCommands: false,
    supportsAgents: true,
    supportsSkills: true,
    supportsMCP: true,
    alternativeRulesFiles: [
      "Agents.md",
      "Claude.md",
      "AGENT.md",
      "CLAUDE.md",
      "CLAUDE.local.md",
    ],
  },

  devin: {
    id: "devin",
    name: "Devin CLI",
    globalConfigPath: "~/.config/devin/",
    projectConfigPath: ".devin/",
    rulesFile: "AGENTS.md",
    rulesDir: null,
    commandsDir: null,
    agentsDir: null,
    toolsDir: null,
    skillsDir: "skills/",
    // config.json is user-shared (herdr hooks, model prefs). Prism never
    // whole-file owns it; PR1 MCP is unsupported and hooks lower as
    // project/global hooks.v1.json + wrapper files.
    configFile: "config.json",
    configFormat: "json",
    supportsTools: false,
    supportsCommands: false,
    supportsAgents: false,
    supportsSkills: true,
    supportsMCP: false,
    alternativeRulesFiles: ["AGENT.md", "CLAUDE.md", "AGENTS.local.md"],
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

/**
 * Live layer mapping each harness to its registry globalConfigPath, expanded
 * through the current HOME. This belongs with the registry because it is the
 * only module that owns the harness definitions.
 */
export const HarnessRootsLive: Layer.Layer<HarnessRoots> = Layer.succeed(
  HarnessRoots,
  {
    resolve: (harnessId: HarnessId) => expandPath(HARNESSES[harnessId].globalConfigPath),
  },
);

export function resolveHarnessRoot(
  harness: HarnessConfig,
  scope: HarnessScope,
  projectPath?: string,
  roots?: HarnessRootsEnv,
): string | null {
  if (scope === "global") {
    return roots ? roots.resolve(harness.id) : expandPath(harness.globalConfigPath);
  }

  if (!harness.projectConfigPath || !projectPath) {
    return null;
  }

  return join(expandPath(projectPath), harness.projectConfigPath);
}

export function harnessSupportsProjectScope(harness: HarnessConfig): boolean {
  return harness.projectConfigPath !== null;
}
