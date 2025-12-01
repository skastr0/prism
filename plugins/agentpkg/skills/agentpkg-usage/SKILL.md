---
description: Knowledge about agentpkg - the unified plugin distribution system for AI coding agents
targets: [claude-code]
---

# agentpkg Skill

You have expertise in using `agentpkg`, the unified plugin distribution system for AI coding agents.

## What is agentpkg?

agentpkg allows you to create plugins once and distribute them to multiple AI coding agents (Claude Code, OpenCode, Codex CLI, Gemini CLI, Amp Code, Cursor). Instead of manually configuring each agent separately, you define artifacts in a unified format and agentpkg handles the distribution.

## CLI Commands

### Create a Plugin
```bash
agentpkg init <name> [options]
```
Options:
- `--dir <path>` - Directory to create plugin in (default: .)
- `--with-agent` - Include example agent definition
- `--with-skill` - Include example skill (Claude Code only)
- `--minimal` - Create minimal plugin (manifest only)

### Install a Plugin
```bash
agentpkg install <plugin-path> [options]
```
Options:
- `--agent <ids>` - Comma-separated agent IDs (e.g., `claude-code,opencode`)
- `--all` - Install to all supported agents
- `--project <path>` - Project path for project-specific rules
- `--overwrite` - Overwrite existing files (default: false)
- `--no-backup` - Skip creating backups
- `--dry-run` - Preview operations without executing

### Other Commands
```bash
agentpkg validate <plugin-path>  # Validate plugin structure
agentpkg agents                   # List supported agents
```

## Plugin Structure

```
my-plugin/
├── plugin.json         # Required: manifest
├── rules/
│   ├── global/         # Appended to agent's global rules
│   │   └── *.md
│   └── project/        # For project-specific rules
│       └── *.md
├── commands/           # Slash commands
│   └── *.md
├── agents/             # Custom agent definitions
│   └── *.md
└── skills/             # Skills (Claude Code only)
    └── <skill-name>/
        ├── SKILL.md
        └── *.md
```

## plugin.json Format

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "targets": "all"
}
```

The `targets` field can be:
- `"all"` - Install to all agents
- `["claude-code", "opencode"]` - Array of specific agent IDs

## Supported Agent IDs

- `claude-code` - Anthropic's Claude Code CLI
- `opencode` - SST's OpenCode CLI
- `codex-cli` - OpenAI's Codex CLI
- `gemini-cli` - Google's Gemini CLI
- `amp-code` - Sourcegraph's Amp Code
- `cursor` - Cursor IDE/CLI

## Frontmatter Format

All markdown artifacts support frontmatter for metadata and agent targeting:

```yaml
---
description: What this artifact does
targets: [claude-code, opencode]  # Optional: limits to specific agents

# Agent-specific overrides
claude-code:
  allowed-tools: [Bash, Read]
  model: sonnet
opencode:
  agent: build
  temperature: 0.1
---

Content goes here...
```

## Best Practices

1. **Always dry-run first**: Use `--dry-run` to preview changes before installing
2. **Use targets wisely**: Only target agents that support the artifact type
3. **Keep plugins focused**: One plugin = one purpose
4. **Version your plugins**: Increment version in plugin.json when making changes
5. **Test with validate**: Run `agentpkg validate` before distributing

## Agent Feature Support

| Feature | claude-code | opencode | codex-cli | gemini-cli | amp-code | cursor |
|---------|-------------|----------|-----------|------------|----------|--------|
| Rules | Yes | Yes | Yes | Yes | Yes | Yes |
| Commands | Yes | Yes | Yes | Yes (TOML) | Yes | No |
| Agents | Yes | Yes | No | No | No | No |
| Skills | Yes | No | No | No | No | No |
