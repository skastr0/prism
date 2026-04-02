# agentpkg Plugin

Living documentation for agentpkg - the unified plugin distribution system for AI coding harnesses.

## Purpose

This plugin teaches users and coding agents how to:
1. Use the `agentpkg` CLI tool
2. Create properly structured plugins
3. Format artifacts with correct frontmatter
4. Install plugins to various harnesses

## Harness-aware model

- `plugin.json` is the only source of install targeting.
- Targets are declared per artifact (`rules`, `commands`, `agents`, `skills`).
- Presets like `coding-harness` and `claw-harness` expand to supported harness groups.
- Optional `harness/<id>/...` overlays replace matching shared files for that harness.
- Artifact frontmatter is for metadata and harness-specific settings, not file-level install targets.

## What's Included

### Skill: agentpkg-usage (skill-capable harnesses, including OpenClaw)
Comprehensive knowledge about agentpkg including:
- CLI commands and options
- Plugin structure and format
- Frontmatter syntax
- Harness-aware targeting and overlays
- Harness feature support matrix
- Best practices

**Note:** OpenClaw v1 is skills-only. Shared skill files plus matching `harness/openclaw/skills/...` overlay files install into `~/.openclaw/skills/`. It does not support rules, commands, or custom-agent distribution.

### Commands

- `/create-plugin` - Guides agents through creating a new plugin
- `/install-plugin` - Helps install plugins to target harnesses

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
        ├── harness-settings.md # Current typed frontmatter + target contract
        └── skill-creation.md   # Skill creation guide
```

## Keeping Updated

This plugin serves as living documentation. When agentpkg is updated:

1. Update the skill/command files with new features
2. Increment version in plugin.json
3. Reinstall to all harnesses:
   ```bash
   agentpkg install ./plugins/agentpkg --all --overwrite
   ```

## Supported Harnesses

| Harness | Commands | Skills |
|---------|----------|--------|
| Claude Code | /create-plugin, /install-plugin | agentpkg-usage |
| OpenCode | /create-plugin, /install-plugin | agentpkg-usage |
| OpenClaw | - | agentpkg-usage (skills-only; shared files + matching overlays) |
| Codex CLI | /create-plugin, /install-plugin | agentpkg-usage |
| Gemini CLI | /create-plugin, /install-plugin | agentpkg-usage |
| Amp Code | - | agentpkg-usage |
| Cursor | /create-plugin, /install-plugin | agentpkg-usage |
| Factory Droid | /create-plugin, /install-plugin | agentpkg-usage |
