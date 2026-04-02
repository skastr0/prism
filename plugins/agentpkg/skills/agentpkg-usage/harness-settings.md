# Harness Targets and Frontmatter Reference

This reference mirrors the current contract in `src/types.ts` and the install behavior modeled in `src/harnesses.ts`.

## Install Target Model (`plugin.json`)

```typescript
type HarnessId =
  | "claude-code"
  | "opencode"
  | "openclaw"
  | "codex-cli"
  | "gemini-cli"
  | "amp-code"
  | "cursor"
  | "factory-droid";

type PluginArtifactType = "rules" | "commands" | "agents" | "skills";
type TargetPresetId = "coding-harness" | "claw-harness";
type PluginTargetId = HarnessId | TargetPresetId;
type PluginManifestTargets = Partial<Record<PluginArtifactType, PluginTargetId[]>>;

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  targets: PluginManifestTargets;
  projects?: Record<string, ProjectConfig>;
}

interface ProjectConfig {
  pattern?: string;
  rulesDir?: string;
}
```

### Important rules

- `plugin.json` is the only install-targeting source.
- `targets.<artifact>` accepts harness IDs and/or preset IDs.
- There are no file-level install targets for rules, commands, agents, or skills.
- `harness/<id>/...` overlays replace matching shared files for that harness.
- OpenClaw is skills-only, but shared skill files plus matching `harness/openclaw/skills/...` overlays are both materialized into `~/.openclaw/skills/`.

## Unified Markdown Frontmatter (`src/types.ts`)

```typescript
interface UnifiedFrontmatter {
  description?: string;

  "claude-code"?: ClaudeCodeFrontmatter;
  opencode?: OpenCodeAgentFrontmatter;
  openclaw?: Record<string, unknown>;
  "codex-cli"?: CodexCliFrontmatter;
  "gemini-cli"?: Record<string, unknown>;
  "amp-code"?: Record<string, unknown>;
  cursor?: CursorFrontmatter;
  "factory-droid"?: FactoryDroidFrontmatter;
}
```

### Notes

- Use frontmatter for metadata and harness-specific overrides only.
- Do not add file-level `targets` blocks. Install scope belongs in `plugin.json`.
- The typed harness-specific blocks currently exist for `claude-code`, `opencode`, `codex-cli`, `cursor`, and `factory-droid`.
- `openclaw`, `gemini-cli`, and `amp-code` are currently passthrough `Record<string, unknown>` blocks in `src/types.ts`; do not assume extra keys are validated by agentpkg.

## Typed Harness-Specific Blocks

### Claude Code

```typescript
interface ClaudeCodeFrontmatter {
  description?: string;
  "allowed-tools"?: string[];
  model?: "sonnet" | "opus" | "haiku" | string;
}
```

### OpenCode custom-agent block

```typescript
type OpenCodePermission = "allow" | "ask" | "deny";

interface OpenCodeAgentFrontmatter {
  description?: string;
  mode?: "subagent" | "primary" | "all";
  model?: string;
  temperature?: number;
  top_p?: number;
  tools?: Record<string, boolean>;
  color?: string;
  maxSteps?: number;
  disable?: boolean;
  permission?: {
    edit?: OpenCodePermission;
    bash?: OpenCodePermission | Record<string, OpenCodePermission>;
    webfetch?: OpenCodePermission;
    doom_loop?: OpenCodePermission;
    external_directory?: OpenCodePermission;
  };
}
```

Use `mode` for OpenCode custom-agent visibility.

### Codex CLI

```typescript
interface CodexCliFrontmatter {
  description?: string;
  model?: string;
  model_reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  sandbox_mode?: "read-only" | "full" | "danger-full-access";
}
```

### Cursor

```typescript
interface CursorFrontmatter {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
}
```

### Factory Droid

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

### Currently untyped / passthrough blocks

```typescript
openclaw?: Record<string, unknown>;
"gemini-cli"?: Record<string, unknown>;
"amp-code"?: Record<string, unknown>;
```

## OpenClaw Install Behavior (current registry behavior)

OpenClaw does not define typed frontmatter overrides in `src/types.ts`. The current install surface is:

- skills only
- destination: `~/.openclaw/skills/`
- shared skill files install there
- matching `harness/openclaw/skills/...` overlay files replace shared files at the same relative path in that same destination tree
- rules, commands, custom agents, and `openclaw.json` are not managed by agentpkg

## `SKILL.md` Frontmatter (`src/types.ts`)

```typescript
interface SkillFrontmatter {
  name: string;
  description: string;
  compatibility?: string;
  license?: string;
  "allowed-tools"?: string[];
  metadata?: Record<string, string>;
}

const SKILL_VALIDATION = {
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
```

### Skill-frontmatter reminders

- `name` and `description` are required.
- `compatibility`, `license`, `allowed-tools`, and `metadata` are optional.
- Only the keys listed in `ALLOWED_FRONTMATTER_KEYS` are accepted by skill validation.
- Keep `SKILL.md` bodies under the recommended 500-line limit when possible.

## Practical guidance

- Put install scope in `plugin.json`.
- Use `harness/<id>/...` only when one harness truly needs a different file.
- If you need a field that is not shown above, verify it in code before documenting it as part of agentpkg's typed contract.
