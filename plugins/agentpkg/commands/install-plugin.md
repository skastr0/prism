---
description: Install an agentpkg plugin to specified agents

claude-code:
  allowed-tools: [Bash, Read]
opencode:
  agent: build
---

# Install agentpkg Plugin

**Plugin Installation Request:** $ARGUMENTS

Help the user install an agentpkg plugin to their AI coding agents.

## Arguments

- `$ARGUMENTS` - Plugin path and any additional options (like `--all` or `--agent`)

## Usage Examples

```bash
/install-plugin ./my-plugin                    # Install, will prompt for targets
/install-plugin ./my-plugin --all              # Install to all agents
/install-plugin ./my-plugin --agent claude-code # Specific agents
/install-plugin                                # Interactive - ask for path
```

## Installation Steps

1. **Locate the plugin**: Use $ARGUMENTS to find the path or ask the user for the path

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

4. **Confirm with user**: Show what will be installed and ask for confirmation

5. **Execute installation**:
   ```bash
   agentpkg install <plugin-path> --all
   ```

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

## Safety Notes

- Always run `--dry-run` first to preview changes
- Backups are created by default (use `--no-backup` to skip)
- Existing files are NOT overwritten unless `--overwrite` is specified
