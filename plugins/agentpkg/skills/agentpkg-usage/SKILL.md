---
name: agentpkg-usage
description: Guide for using agentpkg to create, manage, and install plugins across AI coding harnesses. Use when working with agentpkg commands, creating plugins, creating skills, or distributing configurations to Claude Code, OpenCode, OpenClaw, Cursor, Codex CLI, Gemini CLI, Amp Code, or Factory Droid.
---

# agentpkg Usage Guide

agentpkg is a unified plugin distribution system for AI coding harnesses.

## Quick Reference

```bash
# Create a new plugin
agentpkg init <name> [--with-agent] [--with-skill] [--minimal]

# Install a plugin
agentpkg install <path> [--harness <ids>] [--all] [--dry-run]

# Validate plugin structure
agentpkg validate <path>

# List supported harness IDs
agentpkg harnesses
```

## Plugin Structure

```
my-plugin/
├── plugin.json         # Required: manifest with per-artifact targets
├── rules/
│   ├── global/         # Shared rules appended to targeted rules files
│   └── project/        # Shared project rules copied when --project is set
├── commands/           # Shared slash commands (.md files)
├── agents/             # Shared custom agent definitions
├── skills/             # Shared skills (including OpenClaw shared skill files)
│   └── <skill-name>/
│       ├── SKILL.md
│       └── [resources]
└── harness/            # Optional harness-specific overlays
    └── <id>/...
```

## Supported Harnesses

| Harness | Rules | Commands | Agents | Skills |
|---------|-------|----------|--------|--------|
| Claude Code | Yes | Yes | Yes | Yes |
| OpenCode | Yes | Yes | Yes | Yes |
| OpenClaw | - | - | - | Yes* |
| Codex CLI | Yes | Yes | Yes | Yes |
| Gemini CLI | Yes | Yes | Yes | Yes |
| Amp Code | Yes | - | - | Yes |
| Cursor | Yes | Yes | - | Yes |
| Factory Droid | Yes | Yes | Yes | Yes |

*OpenClaw v1 is skills-only. Shared skill files plus matching `harness/openclaw/skills/...` overlay files install into `~/.openclaw/skills/`.

## Harness-aware targeting model

### `plugin.json` format

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "targets": {
    "rules": ["coding-harness"],
    "commands": ["claude-code", "opencode", "codex-cli", "gemini-cli", "cursor", "factory-droid"],
    "agents": ["claude-code", "opencode"],
    "skills": ["coding-harness", "claw-harness"]
  }
}
```

### Preset groups

- `coding-harness` → `claude-code`, `opencode`, `codex-cli`, `gemini-cli`, `amp-code`, `cursor`, `factory-droid`
- `claw-harness` → `openclaw`

### Key rules

- `plugin.json` is the only source of install targeting.
- Targets are declared per artifact type: `rules`, `commands`, `agents`, `skills`.
- There are no file-level install targets in artifact frontmatter.
- Use explicit harness IDs when a preset would expand to an unsupported surface (for example, `commands` cannot target `amp-code` or `openclaw`).

## Harness overlays

Use `harness/<id>/...` when one harness needs a different file than the shared default.

```text
harness/
├── opencode/
│   └── commands/
│       └── review.md
└── openclaw/
    └── skills/
        └── debugging/
            └── SKILL.md
```

Overlay paths mirror the shared artifact paths. If both a shared file and a harness overlay exist at the same relative path, the harness overlay wins for that harness. Non-overridden files still come from the shared directories.

## Frontmatter Format

Use frontmatter for artifact metadata and harness-specific settings, not install targeting.

```yaml
---
description: What this artifact does

claude-code:
  allowed-tools: [Bash, Read]
opencode:
  mode: subagent
---

Content...
```

**Important**: For the current typed frontmatter surface and notes about loosely typed harness blocks, see [harness-settings.md](harness-settings.md).

## Command Arguments

Commands support argument placeholders. For maximum compatibility across agents, design commands to accept a single argument string:

| Placeholder | Description |
|-------------|-------------|
| `$ARGUMENTS` | Entire raw argument string |

### Parsing Rules

- `$ARGUMENTS` captures the entire unparsed string provided after the command.

### Example

```markdown
---
description: Deploy to environment
---

Deploy to the specified target: $ARGUMENTS

# Usage: /deploy production --message "v1.2.0 release"
# $ARGUMENTS = production --message "v1.2.0 release"
```

## Creating Skills

See [skill-creation.md](skill-creation.md) for the complete guide.

### Quick Skill Setup

```
skills/my-skill/
├── SKILL.md              # Required
├── *.md                  # Optional: supporting docs (flat structure)
└── assets/               # Optional: templates, images
```

### SKILL.md Format

```yaml
---
name: my-skill              # REQUIRED: kebab-case identifier
description: What it does AND when to trigger it  # REQUIRED
---

# My Skill

Instructions for the agent...
```

**Required frontmatter fields:**
- `name` - Hyphen-case identifier (lowercase, digits, hyphens only). Max 64 chars.
- `description` - What the skill does AND when to use it. Max 1024 chars, no angle brackets.

**Key insight**: The `description` field triggers the skill. Include both WHAT it does and WHEN to use it.

### Core Skill Principles

1. **Concise is Key** - Only add what the agent doesn't know
2. **Appropriate Freedom** - Match specificity to task fragility
3. **Progressive Disclosure** - Keep SKILL.md <500 lines, split to sibling files

## OpenCode Custom-Agent Settings (Quick Reference)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `description` | string | - | When to use this agent |
| `mode` | `"subagent"` \| `"primary"` \| `"all"` | `"all"` | Visibility mode |
| `model` | string | inherited | e.g., `anthropic/claude-sonnet-4-20250514` |
| `temperature` | number | model default | 0.0 - 2.0 |
| `top_p` | number | - | Top-p sampling |
| `tools` | `Record<string, boolean>` | inherited | Enable/disable tools |
| `color` | string | - | Hex color (`#FF5733`) |
| `maxSteps` | number | - | Max iterations |
| `disable` | boolean | `false` | Disable agent |
| `permission` | object | inherited | Permission overrides |

**Note**: This quick reference covers the typed custom-agent block modeled in `src/types.ts`. Use `mode` for OpenCode custom agents. Command-routing keys such as `opencode.agent` live outside this typed reference.

## Best Practices

1. **Always dry-run first**: `--dry-run` previews changes
2. **Use artifact targets wisely**: Only target harnesses supporting the artifact surface
3. **Keep plugins focused**: One plugin = one purpose
4. **Validate before distributing**: `agentpkg validate`
5. **Reach for overlays sparingly**: Use `harness/<id>/...` only when a shared file is not enough

## Examples

See `plugin-examples.md` in this skill's directory for complete plugin examples.
