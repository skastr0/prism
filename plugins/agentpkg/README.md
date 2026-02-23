# agentpkg Plugin

Living documentation for agentpkg - the unified plugin distribution system for AI coding agents.

## Purpose

This plugin teaches AI coding agents how to:
1. Use the `agentpkg` CLI tool
2. Create properly structured plugins
3. Format artifacts with correct frontmatter
4. Install plugins to various agents

## What's Included

### Skill: agentpkg-usage (Claude Code, OpenCode)
Comprehensive knowledge about agentpkg including:
- CLI commands and options
- Plugin structure and format
- Frontmatter syntax
- Skill creation guide
- Agent feature support matrix
- Best practices

**Note:** OpenCode requires the `opencode-skills` plugin for skill support.

### Commands

- `/create-plugin` - Guides agents through creating a new plugin
- `/install-plugin` - Helps install plugins to target agents

## Installation

```bash
# From the agentpkg project root
agentpkg install ./plugins/agentpkg --all

# Preview first
agentpkg install ./plugins/agentpkg --all --dry-run
```

## Structure

```
agentpkg/
├── plugin.json
├── commands/
│   ├── create-plugin.md    # Help create new plugins
│   └── install-plugin.md   # Help install plugins
└── skills/
    └── agentpkg-usage/
        ├── SKILL.md            # Core agentpkg knowledge
        ├── plugin-examples.md  # Example plugin structures
        └── skill-creation.md   # Skill creation guide
```

## Keeping Updated

This plugin serves as living documentation. When agentpkg is updated:

1. Update the skill/command files with new features
2. Increment version in plugin.json
3. Reinstall to all agents:
   ```bash
   agentpkg install ./plugins/agentpkg --all --overwrite
   ```

## Supported Agents

| Agent | Commands | Skills |
|-------|----------|--------|
| Claude Code | /create-plugin, /install-plugin | agentpkg-usage |
| OpenCode | /create-plugin, /install-plugin | agentpkg-usage* |
| Codex CLI | /create-plugin, /install-plugin | agentpkg-usage |
| Gemini CLI | /create-plugin, /install-plugin | agentpkg-usage |
| Amp Code | - | agentpkg-usage |
| Cursor | /create-plugin, /install-plugin | agentpkg-usage |
| Factory Droid | /create-plugin, /install-plugin | agentpkg-usage |

*Requires `opencode-skills` plugin
