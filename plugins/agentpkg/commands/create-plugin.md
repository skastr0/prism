---
description: Create a new agentpkg plugin with the user's specifications

claude-code:
  allowed-tools: [Bash, Write, Read]
opencode:
  agent: build
---

# Create agentpkg Plugin

**User Request:** $ARGUMENTS

Help the user create a new agentpkg plugin based on their requirements above.

## If No Request Provided

Ask the user:
- What should this plugin do?
- Which agents should it target? (claude-code, opencode, codex-cli, gemini-cli, amp-code, cursor)
- What artifacts are needed? (rules, commands, agents, skills)

## Creation Steps

1. **Create the plugin structure**:
   ```bash
   agentpkg init <name> --dir <path> [--with-agent] [--with-skill]
   ```

2. **Customize the artifacts**:
   - Edit `plugin.json` with proper name, version, description, and targets
   - Create/edit rules in `rules/global/` or `rules/project/`
   - Create/edit commands in `commands/`
   - Create/edit agents in `agents/` (if targeting claude-code or opencode)
   - Create/edit skills in `skills/<name>/SKILL.md` (if targeting claude-code or opencode)

3. **Use proper frontmatter** in all markdown files:
   ```yaml
   ---
   description: What this artifact does
   targets: [agent1, agent2]  # Optional
   
   # Agent-specific overrides (optional)
   claude-code:
     allowed-tools: [Bash, Read]
   opencode:
     agent: build
   ---
   ```

4. **For commands that accept arguments**, use placeholders:
   - `$ARGUMENTS` - entire raw argument string
   - `$1`, `$2`, etc. - positional arguments (quotes are stripped)

5. **Validate and test**:
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

## Agent Feature Reference

| Feature | claude-code | opencode | codex-cli | gemini-cli | amp-code | cursor |
|---------|-------------|----------|-----------|------------|----------|--------|
| Rules | global + project | global + project | global | global + project | global + project | global + project |
| Commands | commands/*.md | command/*.md | prompts/*.md | commands/*.toml | commands/*.md | - |
| Agents | agents/*.md | agent/*.md | - | - | - | - |
| Skills | skills/*/SKILL.md | skills/*/SKILL.md* | - | - | - | - |

*OpenCode requires the `opencode-skills` plugin for skills support.
