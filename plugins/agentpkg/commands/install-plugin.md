---
description: Install an agentpkg plugin to specified agents

claude-code:
  allowed-tools: [Bash, Read]
opencode:
  agent: build
---

# Install agentpkg Plugin

Help the user install an agentpkg plugin to their AI coding agents.

## Your Task

1. **Locate the plugin**: Find the plugin path from `$ARGUMENTS` or ask the user

2. **Validate first**:
   ```bash
   agentpkg validate <plugin-path>
   ```

3. **Preview the installation**:
   ```bash
   agentpkg install <plugin-path> --all --dry-run
   ```
   Or for specific agents:
   ```bash
   agentpkg install <plugin-path> --agent claude-code,opencode --dry-run
   ```

4. **Confirm with user**: Show them what will be installed and ask for confirmation

5. **Execute installation**:
   ```bash
   agentpkg install <plugin-path> --all
   ```

## Arguments

`$ARGUMENTS` should contain:
- Plugin path (required)
- Target agents (optional, defaults to --all)

## Installation Options

- `--all` - Install to all supported agents
- `--agent <ids>` - Comma-separated agent IDs
- `--project <path>` - Include project-specific rules
- `--overwrite` - Overwrite existing files
- `--no-backup` - Skip creating backups
- `--dry-run` - Preview only

## Supported Agents

- `claude-code` - ~/.claude/
- `opencode` - ~/.config/opencode/
- `codex-cli` - ~/.codex/
- `gemini-cli` - ~/.gemini/
- `amp-code` - ~/.config/amp/
- `cursor` - ~/.cursor/

## Example Commands

```bash
# Install to all agents
agentpkg install ./my-plugin --all

# Install to specific agents only
agentpkg install ./my-plugin --agent claude-code,opencode

# Install with project-specific rules
agentpkg install ./my-plugin --all --project ~/code/my-project

# Force overwrite existing files
agentpkg install ./my-plugin --all --overwrite
```

## Safety Notes

- Always run `--dry-run` first to preview changes
- Backups are created by default (use `--no-backup` to skip)
- Existing files are NOT overwritten unless `--overwrite` is specified
- The tool will show skipped files and reasons
