---
description: Install an agentpkg plugin to specified harnesses

claude-code:
  allowed-tools: [Bash, Read]
opencode:
  # OpenCode command routing, separate from plugin.json harness targeting
  agent: build
---

# Install agentpkg Plugin

**Plugin Installation Request:** $ARGUMENTS

Help the user install an agentpkg plugin to their target harnesses.

## Arguments

- `$ARGUMENTS` - Plugin path and any additional options (like `--all` or `--harness`)

## Usage Examples

```bash
/install-plugin ./my-plugin                    # Install, will prompt for targets
/install-plugin ./my-plugin --all              # Install to all harnesses
/install-plugin ./my-plugin --harness claude-code,openclaw # Specific harness IDs
/install-plugin                                # Interactive - ask for path
```

## Installation Steps

1. **Locate the plugin**: Use $ARGUMENTS to find the path or ask the user for the path

2. **Validate first**:
   ```bash
   agentpkg validate <plugin-path>
   ```

3. **Inspect the harness model**:
   - `plugin.json` decides which harnesses receive each artifact type.
   - `--harness` or `--all` only chooses which harnesses to consider for this run.
   - Optional `harness/<id>/...` overlays replace matching shared files for the selected harness.

4. **Preview the installation**:
   ```bash
   agentpkg install <plugin-path> --all --dry-run
   ```
   Or for specific harness IDs:
    ```bash
    agentpkg install <plugin-path> --harness claude-code,opencode,openclaw --dry-run
    ```

5. **Confirm with user**: Show what will be installed and ask for confirmation

6. **Execute installation**:
   ```bash
   agentpkg install <plugin-path> --all
   ```

## Installation Options

- `--all` - Install to all supported harnesses
- `--harness <ids>` - Comma-separated harness IDs
- `--project <path>` - Include project-specific rules
- `--overwrite` - Overwrite existing files
- `--no-backup` - Skip creating backups
- `--dry-run` - Preview only

## Supported Harness IDs

- `claude-code` - ~/.claude/
- `opencode` - ~/.config/opencode/
- `openclaw` - ~/.openclaw/ (skills only; shared skill files + matching `harness/openclaw/skills/...` overlays land in `skills/`)
- `codex-cli` - ~/.codex/
- `gemini-cli` - ~/.gemini/
- `amp-code` - ~/.config/amp/
- `cursor` - ~/.cursor/
- `factory-droid` - ~/.factory/

## Safety Notes

- Always run `--dry-run` first to preview changes
- Backups are created by default (use `--no-backup` to skip)
- Existing files are NOT overwritten unless `--overwrite` is specified
- There are no file-level install targets in artifact frontmatter; install scope comes from `plugin.json`
