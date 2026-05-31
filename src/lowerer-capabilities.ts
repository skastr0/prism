import type { HarnessId } from "./types.js";

export type GeneratedCanonicalToolSupport = "executable" | "unsupported";
export type SkillPermissionSupport = "supported" | "unsupported";
export type CompileSurfaceSupport = "supported" | "unsupported";

export interface CompileTargetCapabilities {
  readonly agents: CompileSurfaceSupport;
  readonly generatedCanonicalTools: GeneratedCanonicalToolSupport;
  readonly hooks: CompileSurfaceSupport;
  readonly skillPermissions: SkillPermissionSupport;
}

export const LOWERER_SURFACE_IDS = [
  "pluginBundle",
  "rules",
  "commands",
  "agents",
  "skills",
  "generatedTools",
  "hooks",
  "mcpConfig",
  "agentConfig",
] as const;

export type LowererSurfaceId = (typeof LOWERER_SURFACE_IDS)[number];

export const LOWERER_SURFACE_KINDS = [
  "native-plugin-api",
  "native-plugin-bundle",
  "generated-mcp",
  "markdown-file",
  "direct-file",
  "config-patch",
  "unsupported",
] as const;

export type LowererSurfaceKind = (typeof LOWERER_SURFACE_KINDS)[number];

export type HarnessFamily = "coding-harness" | "claw-harness";

export interface LowererSurfaceCapability {
  readonly kind: LowererSurfaceKind;
  readonly summary: string;
  readonly path?: string;
}

export interface LowererCapabilityProfile {
  readonly harness: HarnessId;
  readonly family: HarnessFamily;
  readonly compile: CompileTargetCapabilities;
  readonly surfaces: Record<LowererSurfaceId, LowererSurfaceCapability>;
  readonly notes?: readonly string[];
}

const unsupported = (summary = "Prism does not manage this surface."): LowererSurfaceCapability => ({
  kind: "unsupported",
  summary,
});

const compileUnsupported: CompileTargetCapabilities = {
  agents: "unsupported",
  generatedCanonicalTools: "unsupported",
  hooks: "unsupported",
  skillPermissions: "unsupported",
};

const compileSupported = (
  overrides: Partial<CompileTargetCapabilities> = {},
): CompileTargetCapabilities => ({
  agents: "supported",
  generatedCanonicalTools: "executable",
  hooks: "supported",
  skillPermissions: "supported",
  ...overrides,
});

export const LOWERER_CAPABILITIES = {
  "claude-code": {
    harness: "claude-code",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-bundle",
        path: "<claude-root>/plugins/prism-generated-<plugin>/",
        summary: "Compile emits Claude Code plugin directories with plugin metadata.",
      },
      rules: {
        kind: "direct-file",
        path: "<claude-root>/CLAUDE.md",
        summary: "Install appends managed sections to the native instructions file.",
      },
      commands: {
        kind: "direct-file",
        path: "<claude-root>/commands/",
        summary: "Install writes markdown command files.",
      },
      agents: {
        kind: "markdown-file",
        path: "<generated-plugin>/agents/",
        summary: "Compile writes Claude-style subagent markdown inside the plugin bundle.",
      },
      skills: {
        kind: "markdown-file",
        path: "<generated-plugin>/skills/",
        summary: "Compile bundles targeted skills and orbit skills as Agent Skills.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<generated-plugin>/.mcp.json",
        summary: "Canonical tools lower through a plugin-local generated MCP server.",
      },
      hooks: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/hooks/hooks.json",
        summary: "Hooks are bundled in Claude Code's plugin hook layout.",
      },
      mcpConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/.mcp.json",
        summary: "MCP config is plugin-local, not a global settings patch.",
      },
      agentConfig: unsupported("Claude agent behavior lives in generated agent frontmatter."),
    },
  },
  opencode: {
    harness: "opencode",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-api",
        path: "<opencode-root>/plugins/prism-generated-<plugin>/",
        summary: "Compile emits an OpenCode plugin using @opencode-ai/plugin APIs.",
      },
      rules: {
        kind: "direct-file",
        path: "<opencode-root>/AGENTS.md",
        summary: "Install appends managed sections to the native instructions file.",
      },
      commands: {
        kind: "direct-file",
        path: "<opencode-root>/commands/",
        summary: "Install writes markdown command files.",
      },
      agents: {
        kind: "markdown-file",
        path: "<opencode-root>/agents/",
        summary: "Compile writes OpenCode agent markdown files.",
      },
      skills: {
        kind: "markdown-file",
        path: "<opencode-root>/skills/",
        summary: "Install and compile write Agent Skill folders.",
      },
      generatedTools: {
        kind: "native-plugin-api",
        path: "<generated-plugin>/dist/server.mjs",
        summary: "Canonical tools lower to OpenCode plugin tools.",
      },
      hooks: {
        kind: "native-plugin-api",
        path: "<generated-plugin>/dist/server.mjs",
        summary: "Hooks lower through the OpenCode plugin API.",
      },
      mcpConfig: unsupported("Prism-generated OpenCode tools do not require MCP config."),
      agentConfig: {
        kind: "config-patch",
        path: "<opencode-root>/opencode.json#agent.<name>",
        summary: "Compile patches compiler-owned agent keys and plugin entries.",
      },
    },
  },
  openclaw: {
    harness: "openclaw",
    family: "claw-harness",
    compile: compileUnsupported,
    surfaces: {
      pluginBundle: unsupported("Prism does not manage OpenClaw plugin bundles yet."),
      rules: unsupported(),
      commands: unsupported(),
      agents: unsupported(),
      skills: {
        kind: "direct-file",
        path: "<openclaw-root>/skills/",
        summary: "Install writes Agent Skill folders only.",
      },
      generatedTools: unsupported(),
      hooks: unsupported(),
      mcpConfig: unsupported(),
      agentConfig: unsupported(),
    },
    notes: ["OpenClaw remains Prism skills-only for now."],
  },
  hermes: {
    harness: "hermes",
    family: "claw-harness",
    compile: compileSupported({
      agents: "unsupported",
      hooks: "unsupported",
      skillPermissions: "unsupported",
    }),
    surfaces: {
      pluginBundle: unsupported("Prism does not emit native Hermes Python plugins yet."),
      rules: unsupported(),
      commands: unsupported(),
      agents: unsupported("Hermes compiled agents are intentionally fail-closed."),
      skills: {
        kind: "markdown-file",
        path: "<hermes-root>/skills/",
        summary: "Install and compile write Hermes skill folders.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<hermes-root>/prism/mcp/prism_generated_<plugin>/server.mjs",
        summary: "Canonical tools lower to a generated MCP server.",
      },
      hooks: unsupported("Hermes native hooks are not lowered by Prism yet."),
      mcpConfig: {
        kind: "config-patch",
        path: "<hermes-root>/config.yaml#mcp_servers",
        summary: "Compile patches the Hermes MCP server map.",
      },
      agentConfig: unsupported(),
    },
  },
  "codex-cli": {
    harness: "codex-cli",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: unsupported("Codex CLI currently uses file and config surfaces, not plugin bundles."),
      rules: {
        kind: "direct-file",
        path: "<codex-root>/AGENTS.md",
        summary: "Install appends managed sections to the native instructions file.",
      },
      commands: {
        kind: "direct-file",
        path: "<codex-root>/prompts/",
        summary: "Install writes prompt markdown files.",
      },
      agents: {
        kind: "direct-file",
        path: "<codex-root>/agents/<name>.toml",
        summary: "Compile writes Codex agent TOML files.",
      },
      skills: {
        kind: "markdown-file",
        path: "<codex-root>/skills/",
        summary: "Install and compile write Agent Skill folders.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<codex-root>/mcp/prism_generated_<plugin>/server.mjs or <mcp-runtime-root>/prism/mcp/prism_generated_<plugin>/server.mjs",
        summary: "Canonical tools lower to a generated MCP server; Streamable HTTP mode uses the shared Prism runtime path.",
      },
      hooks: {
        kind: "config-patch",
        path: "<codex-root>/config.toml#hooks",
        summary: "Compile patches managed Codex hook entries and wrapper files.",
      },
      mcpConfig: {
        kind: "config-patch",
        path: "<codex-root>/config.toml#mcp_servers",
        summary: "Compile patches generated MCP server tables.",
      },
      agentConfig: {
        kind: "direct-file",
        path: "<codex-root>/agents/<name>.toml",
        summary: "Codex agent settings live in generated TOML files.",
      },
    },
  },
  "antigravity-cli": {
    harness: "antigravity-cli",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-bundle",
        path: "<antigravity-root>/plugins/prism-generated-<plugin>/",
        summary: "Compile emits Antigravity plugin bundles with plugin.json.",
      },
      rules: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/rules/",
        summary: "Rules are bundled into Antigravity plugins.",
      },
      commands: unsupported("Antigravity commands are represented as skills/plugins, not direct command files."),
      agents: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/agents/",
        summary: "Compile writes subagent markdown inside the Antigravity plugin bundle.",
      },
      skills: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/",
        summary: "Compile bundles targeted skills and orbit skills.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<generated-plugin>/mcp_config.json",
        summary: "Canonical tools lower to a generated MCP server referenced by plugin config.",
      },
      hooks: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/hooks.json",
        summary: "Hooks are bundled in Antigravity plugin format.",
      },
      mcpConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/mcp_config.json",
        summary: "MCP config is plugin-local for generated plugin bundles.",
      },
      agentConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/agents/",
        summary: "Agent settings live in generated frontmatter.",
      },
    },
  },
  "kimi-code": {
    harness: "kimi-code",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-bundle",
        path: "<kimi-root>/plugins/managed/prism-generated-<plugin>/",
        summary: "Compile emits a Kimi plugin bundle with kimi.plugin.json and registers it in plugins/installed.json.",
      },
      rules: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/prism-context/SKILL.md",
        summary: "Rules lower into a sessionStart skill because Kimi plugins inject Markdown skills, not arbitrary rule files.",
      },
      commands: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/prism-command-<name>/SKILL.md",
        summary: "Command-like workflows lower as manual Kimi flow skills.",
      },
      agents: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/prism-agent-<name>/SKILL.md",
        summary: "Compiled agents lower honestly as role/workflow skills; Kimi subagents are runtime dispatches, not custom agent files.",
      },
      skills: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/",
        summary: "Compile bundles targeted plugin skills and orbit skills into the generated Kimi plugin.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<generated-plugin>/kimi.plugin.json#mcpServers",
        summary: "Canonical tools lower to a generated MCP server declared by the Kimi plugin manifest.",
      },
      hooks: {
        kind: "config-patch",
        path: "<kimi-root>/config.toml#hooks",
        summary: "Hooks lower to managed [[hooks]] config entries plus generated wrapper scripts.",
      },
      mcpConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/kimi.plugin.json#mcpServers + <kimi-root>/plugins/installed.json",
        summary: "MCP config is plugin-local and enabled through Kimi's installed plugin record; Prism patches config.toml only for hooks.",
      },
      agentConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/prism-agent-<name>/SKILL.md",
        summary: "Agent role settings and instructions live in generated Kimi role skills.",
      },
    },
    notes: [
      "The active Kimi Code target uses ~/.kimi-code; legacy ~/.kimi paths are not a Prism compatibility target.",
      "Kimi Code plugins are user-scoped in official docs; Prism keeps project scope unsupported for this lowerer.",
      "Kimi Code subagents are runtime dispatches, so Prism compiled agents lower as role skills rather than native subagent definitions.",
    ],
  },
  "amp-code": {
    harness: "amp-code",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-api",
        path: "<amp-root>/plugins/prism-generated-<plugin>.ts",
        summary: "Compile emits a TypeScript Amp plugin using @ampcode/plugin APIs.",
      },
      rules: {
        kind: "direct-file",
        path: "<amp-root>/AGENTS.md",
        summary: "Install appends managed sections to the native instructions file.",
      },
      commands: {
        kind: "native-plugin-api",
        path: "<generated-plugin>.ts",
        summary: "Commands lower to Amp registerCommand definitions that append Prism command prompts to the active thread.",
      },
      agents: {
        kind: "markdown-file",
        path: "<amp-root>/skills/prism-agent-<name>/SKILL.md",
        summary: "Compiled agents lower as generated role skills; Prism does not claim a native Amp custom-agent surface yet.",
      },
      skills: {
        kind: "markdown-file",
        path: "<amp-root>/skills/",
        summary: "Install and compile write Agent Skill folders.",
      },
      generatedTools: {
        kind: "native-plugin-api",
        path: "<generated-plugin>.ts",
        summary: "Canonical tools lower to Amp registerTool definitions.",
      },
      hooks: {
        kind: "native-plugin-api",
        path: "<generated-plugin>.ts",
        summary: "Supported Prism hooks lower to Amp amp.on(...) plugin event handlers; session.end fails closed because Amp has no native session-end event.",
      },
      mcpConfig: unsupported("Prism-generated Amp tools use plugin APIs instead of MCP config."),
      agentConfig: unsupported("No Prism-managed Amp agent config patch exists."),
    },
    notes: [
      "Amp generated commands, tools, and supported hooks use the native plugin API; compiled agents currently lower as role-skill guidance.",
      "Amp exposes session.start, tool.call, tool.result, agent.start, and agent.end plugin events; Prism does not map portable session.end to agent.end.",
    ],
  },
  cursor: {
    harness: "cursor",
    family: "coding-harness",
    compile: compileSupported({
      agents: "unsupported",
      hooks: "unsupported",
      skillPermissions: "unsupported",
    }),
    surfaces: {
      pluginBundle: unsupported("Prism does not manage Cursor extensions."),
      rules: {
        kind: "direct-file",
        path: "<cursor-root>/.cursorrules or rules/",
        summary: "Install writes Cursor rules files.",
      },
      commands: {
        kind: "direct-file",
        path: "<cursor-root>/commands/",
        summary: "Install writes Cursor command markdown files.",
      },
      agents: unsupported(),
      skills: {
        kind: "direct-file",
        path: "<cursor-root>/skills/",
        summary: "Install writes Agent Skill folders.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<cursor-root>/mcp/prism_generated_<plugin>/server.mjs or <mcp-runtime-root>/prism/mcp/prism_generated_<plugin>/server.mjs",
        summary: "Canonical tools lower to a generated MCP server referenced by Cursor mcp.json.",
      },
      hooks: unsupported(),
      mcpConfig: {
        kind: "config-patch",
        path: "<cursor-root>/mcp.json#mcpServers",
        summary: "Compile patches a compiler-owned Cursor MCP server entry.",
      },
      agentConfig: unsupported(),
    },
    notes: [
      "Cursor compile support is tools-only for now; compiled agents, orbits, hooks, and skill permission visibility remain unsupported.",
      "Cursor IDE and CLI share the same mcp.json contract.",
    ],
  },
  "factory-droid": {
    harness: "factory-droid",
    family: "coding-harness",
    compile: compileSupported({ skillPermissions: "unsupported" }),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-bundle",
        path: "<factory-root>/plugins/prism-generated-<plugin>/",
        summary: "Compile emits Factory plugin bundles with .factory-plugin/plugin.json.",
      },
      rules: {
        kind: "direct-file",
        path: "<factory-root>/AGENTS.md or rules/",
        summary: "Install writes Factory instruction/rule files.",
      },
      commands: {
        kind: "direct-file",
        path: "<factory-root>/commands/",
        summary: "Install writes Factory command markdown files.",
      },
      agents: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/droids/",
        summary: "Compile writes generated droids inside the Factory plugin bundle.",
      },
      skills: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/",
        summary: "Compiled bundles own targeted skills; skills-only plugins still install direct skills.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<generated-plugin>/mcp.json",
        summary: "Canonical tools lower to plugin-local generated MCP servers.",
      },
      hooks: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/hooks/hooks.json",
        summary: "Hooks are bundled in Factory plugin format.",
      },
      mcpConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/mcp.json",
        summary: "MCP config is plugin-local; Prism does not patch settings.json.",
      },
      agentConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/droids/",
        summary: "Droid settings live in generated frontmatter.",
      },
    },
  },
  pi: {
    harness: "pi",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-bundle",
        path: "<pi-root>/packages/prism-generated-<plugin>/",
        summary: "Compile emits a local Pi package and registers it through settings.json packages.",
      },
      rules: {
        kind: "native-plugin-api",
        path: "<generated-package>/extensions/prism-extension.js",
        summary: "Rules lower as Pi before_agent_start context injection in the generated extension.",
      },
      commands: {
        kind: "native-plugin-bundle",
        path: "<generated-package>/prompts/",
        summary: "Compile writes Prism command markdown as Pi prompt templates in the generated package.",
      },
      agents: {
        kind: "markdown-file",
        path: "~/.pi/agents/<name>.md or .pi/agents/<name>.md",
        summary: "Compiled agents lower to the markdown files discovered by the pi-agents package.",
      },
      skills: {
        kind: "native-plugin-bundle",
        path: "<generated-package>/skills/",
        summary: "Compile bundles targeted skills and concrete orbit skills into the generated Pi package.",
      },
      generatedTools: {
        kind: "native-plugin-api",
        path: "<generated-package>/extensions/prism-extension.js",
        summary: "Canonical tools lower through Pi's extension registerTool API.",
      },
      hooks: {
        kind: "native-plugin-api",
        path: "<generated-package>/extensions/prism-extension.js and <generated-package>/hooks/",
        summary: "Hooks lower through Pi extension events and generated wrapper files.",
      },
      mcpConfig: unsupported("Prism-generated Pi tools use extension APIs instead of MCP config."),
      agentConfig: {
        kind: "markdown-file",
        path: "~/.pi/agents/<name>.md or .pi/agents/<name>.md",
        summary: "Pi agent settings live in generated agent frontmatter.",
      },
    },
    notes: [
      "Pi packages are referenced from settings.json#packages; project scope uses .pi/settings.json.",
      "Compiled Pi agents use pi-agents markdown discovery: ~/.pi/agents globally and nearest .pi/agents in project scope.",
    ],
  },
  grok: {
    harness: "grok",
    family: "coding-harness",
    compile: compileSupported(),
    surfaces: {
      pluginBundle: {
        kind: "native-plugin-bundle",
        path: "<grok-root>/plugins/prism-generated-<plugin>/",
        summary: "Compile emits Grok plugin bundles.",
      },
      rules: {
        kind: "direct-file",
        path: "<grok-root>/AGENTS.md",
        summary: "Install appends managed sections to the native instructions file.",
      },
      commands: unsupported("Grok commands are not managed directly by Prism."),
      agents: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/agents/",
        summary: "Compile writes generated agents inside the Grok plugin bundle.",
      },
      skills: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/skills/",
        summary: "Compile bundles targeted skills and orbit skills.",
      },
      generatedTools: {
        kind: "generated-mcp",
        path: "<generated-plugin>/.mcp.json",
        summary: "Canonical tools lower to plugin-local generated MCP servers.",
      },
      hooks: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/hooks/hooks.json",
        summary: "Hooks are bundled in Grok plugin format.",
      },
      mcpConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/.mcp.json",
        summary: "MCP config is plugin-local; Prism does not patch config.toml.",
      },
      agentConfig: {
        kind: "native-plugin-bundle",
        path: "<generated-plugin>/agents/",
        summary: "Agent settings live in generated frontmatter.",
      },
    },
  },
} as const satisfies Record<HarnessId, LowererCapabilityProfile>;

export const getCompileTargetCapabilities = (
  harness: string,
): CompileTargetCapabilities =>
  Object.hasOwn(LOWERER_CAPABILITIES, harness)
    ? LOWERER_CAPABILITIES[harness as HarnessId].compile
    : compileUnsupported;
