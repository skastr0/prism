---
name: agentpkg-usage
description: Guide for using agentpkg to create, manage, and install plugins across AI coding agents. Use when working with agentpkg commands, creating plugins, creating skills, or distributing configurations to Claude Code, OpenCode, Cursor, Codex CLI, Gemini CLI, or Amp Code.
---

# agentpkg Usage Guide

agentpkg is a unified plugin distribution system for AI coding agents.

## Quick Reference

```bash
# Create a new plugin
agentpkg init <name> [--with-agent] [--with-skill] [--minimal]

# Install a plugin
agentpkg install <path> [--agent <ids>] [--all] [--dry-run]

# Validate plugin structure
agentpkg validate <path>

# List supported agents
agentpkg agents
```

## Plugin Structure

```
my-plugin/
├── plugin.json         # Required: manifest
├── rules/
│   ├── global/         # Appended to agent's rules file
│   └── project/        # Copied to project root
├── commands/           # Slash commands (.md files)
├── agents/             # Custom agent definitions
└── skills/             # Skills (Claude Code, OpenCode)
    └── <skill-name>/
        ├── SKILL.md
        └── [resources]
```

## Supported Agents

| Agent | Rules | Commands | Agents | Skills |
|-------|-------|----------|--------|--------|
| Claude Code | Yes | Yes | Yes | Yes |
| OpenCode | Yes | Yes | Yes | Yes |
| Codex CLI | Yes | Yes | - | Yes |
| Gemini CLI | Yes | - | Yes | Yes |
| Amp Code | Yes | - | - | Yes |
| Cursor | Yes | Yes | - | Yes |
| Factory Droid| Yes | Yes | Yes | Yes |

*OpenCode natively supports skills via the skill tool.

## plugin.json Format

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "targets": "all"
}
```

`targets`: `"all"` or `["claude-code", "opencode"]`

## Frontmatter Format

```yaml
---
description: What this artifact does
targets: [claude-code, opencode]

claude-code:
  allowed-tools: [Bash, Read]
opencode:
  mode: subagent
---

Content...
```

**Important**: For complete type-safe settings reference for all agents, see [agent-settings.md](agent-settings.md).

## Command Arguments

Commands support argument placeholders:

| Placeholder | Description |
|-------------|-------------|
| `$ARGUMENTS` | Entire raw argument string |
| `$1`, `$2`... | Positional arguments (1-indexed) |

### Parsing Rules

- Unquoted words split by whitespace
- Quoted strings (`"..."` or `'...'`) count as one argument
- Quotes stripped from final value
- Last positional placeholder captures remaining arguments

### Example

```markdown
---
description: Deploy to environment
---

Deploy to $1 with message: $2

# Usage: /deploy production "v1.2.0 release"
# $1 = production
# $2 = v1.2.0 release
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
name: my-skill              # REQUIRED: hyphen-case identifier
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

## OpenCode Agent Settings (Quick Reference)

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

**Note**: The `agent` property is NOT valid for OpenCode. Use `mode` instead.

## Best Practices

1. **Always dry-run first**: `--dry-run` previews changes
2. **Use targets wisely**: Only target agents supporting the artifact
3. **Keep plugins focused**: One plugin = one purpose
4. **Validate before distributing**: `agentpkg validate`

## Examples

See `plugin-examples.md` in this skill's directory for complete plugin examples.
