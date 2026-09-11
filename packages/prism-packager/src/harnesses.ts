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
    alternativeRulesFiles: ["CLAUDE.md"],
  },

  // Shares ~/.config/opencode/ with OpenCode 1.x until V1/V2 consolidate.
  // Detected by the `opencode2` binary, not by this shared config root.
  opencode2: {
    id: "opencode2",
    name: "OpenCode 2",
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
  },

  omp: {
    id: "omp",
    name: "Oh My Pi",
    globalConfigPath: "~/.omp/agent/",
    projectConfigPath: ".omp/",
    rulesFile: null,
    rulesDir: "rules/",
    commandsDir: "commands/",
    agentsDir: "agents/",
    toolsDir: null,
    skillsDir: "skills/",
    extensionsDir: "extensions/",
    configFile: "config.yml",
    configFormat: "yaml",
    supportsTools: true,
    supportsCommands: true,
    supportsAgents: true,
    supportsSkills: true,
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

/**
 * Home-relative harness layout (`~/.config/opencode/` → `.config/opencode`).
 * Used when `--compile-root` is a sandbox prefix rather than one harness root.
 */
export function relativeHarnessHome(harness: HarnessConfig): string {
  return harness.globalConfigPath.replace(/^~\//, "").replace(/\/+$/, "");
}

/**
 * Map a shared `--compile-root` onto one harness tree.
 *
 * The compile-root is a fake HOME / sandbox prefix. Each harness keeps the
 * same relative layout it has under the real home (or under a project root
 * when `scope` is `project`). Pipeline `root` remains an exact override;
 * callers that already resolved a per-harness directory should pass that
 * through unchanged.
 */
export function resolveCompileSandboxRoot(
  compileRoot: string,
  harness: HarnessConfig,
  scope: HarnessScope,
): string {
  const prefix = expandPath(compileRoot);
  if (scope === "project" && harness.projectConfigPath) {
    return join(prefix, harness.projectConfigPath);
  }
  return join(prefix, relativeHarnessHome(harness));
}

export type CompileSandboxCollision = {
  readonly root: string;
  readonly harnesses: readonly HarnessId[];
};

/**
 * OpenCode 1.x and 2 share `~/.config/opencode/` (and `.opencode/` in
 * project scope). Nesting both under one compile-root prefix maps them to
 * the same physical tree; later compile then prune-treats the earlier
 * harness as orphaned. Callers that nest several harnesses must fail closed
 * on a collision rather than writing both IDs into one home.
 */
export function collidingCompileSandboxGroups(
  compileRoot: string,
  harnessIds: readonly HarnessId[],
  scope: HarnessScope,
): readonly CompileSandboxCollision[] {
  const byRoot = new Map<string, HarnessId[]>();
  for (const id of harnessIds) {
    const root = resolveCompileSandboxRoot(compileRoot, getHarness(id), scope);
    const group = byRoot.get(root);
    if (group) group.push(id);
    else byRoot.set(root, [id]);
  }
  return [...byRoot.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([root, harnesses]) => ({ root, harnesses }));
}

export function harnessSupportsProjectScope(harness: HarnessConfig): boolean {
  return harness.projectConfigPath !== null;
}
