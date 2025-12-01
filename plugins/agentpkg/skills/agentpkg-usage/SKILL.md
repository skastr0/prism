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
| OpenCode | Yes | Yes | Yes | Yes* |
| Codex CLI | Yes | Yes | - | - |
| Gemini CLI | Yes | Yes (TOML) | - | - |
| Amp Code | Yes | Yes | - | - |
| Cursor | Yes | - | - | - |

*OpenCode requires the `opencode-skills` plugin for skills support.

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
  agent: build
---

Content...
```

## Creating Skills

Skills follow Anthropic's Skills Specification v1.0 and work with both Claude Code and OpenCode.

### Skill Structure

```
skills/my-skill/
├── SKILL.md              # Required: main skill definition
├── references/           # Optional: docs loaded as needed
├── scripts/              # Optional: executable code
└── assets/               # Optional: templates, images
```

### SKILL.md Format

```yaml
---
name: my-skill            # Must match directory name
description: What it does AND when to trigger it (min 20 chars)
---

# My Skill

Instructions for the agent...
```

**Key insight**: The `description` field triggers the skill. Include both WHAT it does and WHEN to use it.

### Installation Paths

| Agent | Global Skills Path |
|-------|-------------------|
| Claude Code | `~/.claude/skills/` |
| OpenCode | `~/.config/opencode/skills/` |

### Core Skill Principles

1. **Concise is Key** - Only add what the agent doesn't know
2. **Appropriate Freedom** - Match specificity to task fragility
3. **Progressive Disclosure** - Keep SKILL.md <500 lines, split to references

### OpenCode Skills Setup

To enable skills in OpenCode, install the `opencode-skills` plugin:

```json
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-skills"]
}
```

Then skills in `~/.config/opencode/skills/` will be auto-discovered.

## Best Practices

1. **Always dry-run first**: `--dry-run` previews changes
2. **Use targets wisely**: Only target agents supporting the artifact
3. **Keep plugins focused**: One plugin = one purpose
4. **Validate before distributing**: `agentpkg validate`

## Examples

See `plugin-examples.md` in this skill's directory for complete plugin examples.
