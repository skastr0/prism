---
description: Create a new agentpkg plugin with the user's specifications

claude-code:
  allowed-tools: [Bash, Write, Read]
opencode:
  # OpenCode command routing, separate from plugin.json harness targeting
  agent: build
---

# Create agentpkg Plugin

**User Request:** $ARGUMENTS

Help the user create a new agentpkg plugin based on their requirements above.

## If No Request Provided

Ask the user:
- What should this plugin do?
- Which harness IDs should it target? (claude-code, opencode, openclaw, codex-cli, gemini-cli, amp-code, cursor, factory-droid)
- What artifacts are needed? (rules, commands, agents, skills)

## Creation Steps

1. **Create the plugin structure**:
   ```bash
   agentpkg init <name> --dir <path> [--with-agent] [--with-skill]
   ```

2. **Customize `plugin.json` with per-artifact targets**:
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

3. **Customize the shared artifacts**:
   - Create/edit rules in `rules/global/` or `rules/project/`
   - Create/edit commands in `commands/`
   - Create/edit agents in `agents/` only for harness targets that support custom agents (not OpenClaw v1)
   - Create/edit skills in `skills/<name>/SKILL.md` for harnesses with skill support, including OpenClaw's shared skill files
   - If OpenClaw needs a different skill file, add the matching replacement under `harness/openclaw/skills/<name>/...`

4. **Use frontmatter for metadata and harness-specific settings only**:
   ```yaml
   ---
   description: What this artifact does

   # Harness-specific overrides (optional)
   claude-code:
     allowed-tools: [Bash, Read]
   opencode:
     mode: subagent
   ---
   ```

   Do **not** use file-level `targets:` blocks for install planning. `plugin.json` is the source of truth.

5. **Add harness overlays when one harness needs a different file**:
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

   Matching overlay files replace the shared file for that harness only.

6. **For commands that accept arguments**, use the recommended placeholder:
   - `$ARGUMENTS` - entire raw argument string

7. **Validate and test**:
   ```bash
   agentpkg validate <plugin-path>
   agentpkg install <plugin-path> --all --dry-run
   ```

## Usage Examples

```bash
/create-plugin                              # Interactive mode
/create-plugin "code review plugin for Go"  # With description
/create-plugin my-linter --with-skill       # With name and options
```

## Harness Feature Reference

| Feature | claude-code | opencode | openclaw | codex-cli | gemini-cli | amp-code | cursor | factory-droid |
|---------|-------------|----------|-----------|-----------|------------|----------|--------|---------------|
| Rules | global + project | global + project | - | global | global + project | global + project | global + project | global + project |
| Commands | Yes | Yes | - | Yes | Yes | - | Yes | Yes |
| Custom Agents | Yes | Yes | - | Yes | Yes | - | - | Yes |
| Skills | Yes | Yes | shared files + matching overlays | Yes | Yes | Yes | Yes | Yes |

OpenClaw v1 is skills-only. Shared skill files plus matching `harness/openclaw/skills/...` overlays install into `~/.openclaw/skills/`. It does not support rules, commands, or custom-agent distribution.
