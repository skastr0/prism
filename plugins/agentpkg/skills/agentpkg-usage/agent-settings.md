# Agent Settings Reference

Complete type-safe reference for all agent-specific frontmatter settings in agentpkg plugins.

## Type Definitions

### AgentId

```typescript
type AgentId =
  | "claude-code"
  | "opencode"
  | "codex-cli"
  | "gemini-cli"
  | "amp-code"
  | "cursor"
  | "factory-droid";
```

### PluginManifest (plugin.json)

```typescript
interface PluginManifest {
  name: string;                      // Plugin identifier
  version: string;                   // Semantic version (e.g., "1.0.0")
  description?: string;              // What the plugin does
  targets: AgentId[] | "all";        // Which agents to install to
  projects?: Record<string, {        // Optional project-specific rules
    pattern?: string;                // Path pattern to match
    rulesDir?: string;               // Subdirectory in rules/project/
  }>;
}
```

### UnifiedFrontmatter (commands, agents, rules)

```typescript
interface UnifiedFrontmatter {
  description?: string;              // What this artifact does
  targets?: AgentId[];               // Limit to specific agents

  // Agent-specific overrides (merged with base frontmatter)
  "claude-code"?: ClaudeCodeFrontmatter;
  opencode?: OpenCodeFrontmatter;
  "codex-cli"?: CodexCliFrontmatter;
  "gemini-cli"?: GeminiCliFrontmatter;
  "amp-code"?: AmpCodeFrontmatter;
  cursor?: CursorFrontmatter;
  "factory-droid"?: FactoryDroidFrontmatter;
}
```

### SkillFrontmatter (SKILL.md files)

```typescript
interface SkillFrontmatter {
  name: string;                      // Required: kebab-case, max 64 chars
  description: string;               // Required: max 1024 chars, no < >
  license?: string;                  // Optional: license identifier
  "allowed-tools"?: string[];        // Optional: restrict available tools
  metadata?: Record<string, string>; // Optional: custom key-value pairs
}

// Validation constants
const SKILL_VALIDATION = {
  NAME_MAX_LENGTH: 64,
  NAME_PATTERN: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  DESCRIPTION_MAX_LENGTH: 1024,
  RECOMMENDED_BODY_MAX_LINES: 500,
};
```

---

## Claude Code Settings

### ClaudeCodeFrontmatter

```typescript
interface ClaudeCodeFrontmatter {
  // Tool restrictions
  "allowed-tools"?: string[];        // Tools this artifact can use
  
  // Model selection
  model?: "sonnet" | "opus" | "haiku" | string;
  
  // For commands
  description?: string;              // Command description
}
```

### Valid Tools (Claude Code)

```
Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, TodoRead, TodoWrite
```

### Example

```yaml
---
description: Security audit command
targets: [claude-code]

claude-code:
  allowed-tools: [Read, Grep, Glob, Bash]
  model: sonnet
---
```

---

## OpenCode Settings

### OpenCodeAgentFrontmatter

```typescript
interface OpenCodeAgentFrontmatter {
  // Agent description (triggers agent selection)
  description?: string;
  
  // Visibility mode
  mode?: "subagent" | "primary" | "all";
  // - subagent: Only available as Task subagent (not in picker)
  // - primary: Available in agent picker for direct use
  // - all: Available both as subagent and in picker (default)
  
  // Model configuration
  model?: string;                    // e.g., "anthropic/claude-sonnet-4-20250514"
  temperature?: number;              // 0.0 - 2.0
  top_p?: number;                    // Top-p sampling parameter
  
  // Tool access
  tools?: Record<string, boolean>;   // Enable/disable specific tools
  // Example: { write: false, edit: false, bash: true }
  
  // UI customization
  color?: string;                    // Hex color (e.g., "#FF5733")
  
  // Behavior limits
  maxSteps?: number;                 // Max agentic iterations (positive integer)
  
  // Agent state
  disable?: boolean;                 // Disable the agent entirely
  
  // Permission overrides
  permission?: {
    edit?: "allow" | "ask" | "deny";
    bash?: "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">;
    webfetch?: "allow" | "ask" | "deny";
    doom_loop?: "allow" | "ask" | "deny";
    external_directory?: "allow" | "ask" | "deny";
  };
}
```

### Mode Values Explained

| Mode | In Agent Picker | As Task Subagent | Use Case |
|------|-----------------|------------------|----------|
| `subagent` | No | Yes | Background workers, specialized tools |
| `primary` | Yes | No | Main interactive agents |
| `all` | Yes | Yes | Versatile agents (default) |

### Valid Tools (OpenCode)

```
bash, read, write, edit, glob, grep, task, webfetch, todoread, todowrite,
list, type_packages, type_symbols, type_info, type_expand, type_related,
type_search, type_eval, type_file, type_refresh
```

Plus any MCP tools configured in `opencode.json`.

### Example Agent Definition

```yaml
---
description: Code reviewer that focuses on best practices and security
targets: [claude-code, opencode]

claude-code:
  model: sonnet
  allowed-tools: [Read, Grep, Glob]

opencode:
  mode: subagent
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  color: "#4A90D9"
  maxSteps: 50
  tools:
    write: false
    edit: false
    bash: true
  permission:
    edit: deny
    bash:
      "git *": allow
      "*": ask
---

You are a code review specialist...
```

### Common Mistakes (OpenCode)

1. **Using `agent` instead of `mode`** - `agent` is NOT a valid property
2. **Wrong model format** - Use `provider/model-id` format
3. **Invalid hex color** - Must be `#RRGGBB` format

---

## Codex CLI Settings

### CodexCliFrontmatter

```typescript
interface CodexCliFrontmatter {
  description?: string;              // Command description
  // Limited customization - follows simple prompt format
}
```

Commands become accessible as `/prompts:<name>`.

---

## Gemini CLI Settings

### GeminiCliFrontmatter

```typescript
interface GeminiCliFrontmatter {
  description?: string;              // Command description
  // Commands are converted to TOML format automatically
}
```

**Note**: Gemini CLI uses TOML format. agentpkg automatically converts markdown commands to TOML.

---

## Amp Code Settings

### AmpCodeFrontmatter

```typescript
interface AmpCodeFrontmatter {
  description?: string;              // Command description
  // Uses Toolboxes via $AMP_TOOLBOX environment variable
}
```

---

## Cursor Settings

### CursorFrontmatter

```typescript
interface CursorFrontmatter {
  description?: string;              // Rule description
  globs?: string[];                  // File patterns to apply rule to
  alwaysApply?: boolean;             // Apply regardless of context
}
```

**Note**: Cursor supports rules, commands, and skills. Rules are converted to MDC format.

---

## Factory Droid Settings

### FactoryDroidFrontmatter

```typescript
interface FactoryDroidFrontmatter {
  description?: string;
  model?: string | "inherit";
  reasoningEffort?: "low" | "medium" | "high";
  tools?: string | string[];
  "user-invocable"?: boolean;
  "disable-model-invocation"?: boolean;
  "argument-hint"?: string;
}
```

---

## Agent Capabilities Matrix

| Feature | Claude Code | OpenCode | Codex CLI | Gemini CLI | Amp Code | Cursor | Factory Droid |
|---------|-------------|----------|-----------|------------|----------|--------|---------------|
| Global Rules | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Project Rules | Yes | Yes | - | Yes | Yes | Yes | Yes |
| Commands | Yes | Yes | Yes | Yes | - | Yes | Yes |
| Custom Agents | Yes | Yes | - | Yes | - | - | Yes |
| Skills | Yes | Yes* | Yes | Yes | Yes | Yes | Yes |
| MCP Support | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

*OpenCode supports skills natively.

---

## Path Configurations

```typescript
const AGENT_PATHS = {
  "claude-code": {
    global: "~/.claude/",
    project: ".claude/",
    rules: "CLAUDE.md",
    commands: "commands/",
    agents: "agents/",
    skills: "skills/",
  },
  opencode: {
    global: "~/.config/opencode/",
    project: ".opencode/",
    rules: "AGENTS.md",
    commands: "commands/",
    agents: "agents/",
    skills: "skills/",
  },
  "codex-cli": {
    global: "~/.codex/",
    rules: "AGENTS.md",
    commands: "prompts/",
    skills: "skills/",
  },
  "gemini-cli": {
    global: "~/.gemini/",
    project: ".gemini/",
    rules: "GEMINI.md",
    commands: "commands/",
    skills: "skills/",
    agents: "agents/",
  },
  "amp-code": {
    global: "~/.config/amp/",
    project: ".agents/",
    rules: "AGENTS.md",
    skills: "skills/",
  },
  cursor: {
    global: "~/.cursor/",
    project: ".cursor/",
    rules: ".cursorrules",
    rulesDir: "rules/",
    commands: "commands/",
    skills: "skills/",
  },
  "factory-droid": {
    global: "~/.factory/",
    project: ".factory/",
    rules: "AGENTS.md",
    rulesDir: "rules/",
    commands: "commands/",
    agents: "droids/",
    skills: "skills/",
  },
};
```

---

## Frontmatter Merging Behavior

When installing, agent-specific frontmatter is merged with base frontmatter:

```yaml
---
description: Base description
targets: [claude-code, opencode]

claude-code:
  model: sonnet
opencode:
  mode: subagent
  temperature: 0.1
---
```

**For Claude Code**, the effective frontmatter becomes:
```yaml
description: Base description
model: sonnet
```

**For OpenCode**, the effective frontmatter becomes:
```yaml
description: Base description
mode: subagent
temperature: 0.1
```

Properties in agent-specific blocks override base properties.
