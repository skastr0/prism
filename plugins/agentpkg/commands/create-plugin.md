---
description: Create a new agentpkg plugin with the user's specifications

claude-code:
  allowed-tools: [Bash, Write, Read]
opencode:
  agent: build
---

# Create agentpkg Plugin

Help the user create a new agentpkg plugin based on their requirements.

## Your Task

1. **Understand the requirements**: Ask the user what kind of plugin they want:
   - What should this plugin do?
   - Which agents should it target? (claude-code, opencode, codex-cli, gemini-cli, amp-code, cursor)
   - What artifacts are needed? (rules, commands, agents, skills)

2. **Create the plugin structure**:
   ```bash
   agentpkg init <name> --dir <path> [--with-agent] [--with-skill]
   ```

3. **Customize the artifacts**:
   - Edit `plugin.json` with proper name, version, description, and targets
   - Create/edit rules in `rules/global/` or `rules/project/`
   - Create/edit commands in `commands/`
   - Create/edit agents in `agents/` (if targeting claude-code or opencode)
   - Create/edit skills in `skills/<name>/SKILL.md` (if targeting claude-code)

4. **Use proper frontmatter** in all markdown files:
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

5. **Validate and test**:
   ```bash
   agentpkg validate <plugin-path>
   agentpkg install <plugin-path> --all --dry-run
   ```

## Arguments

Use `$ARGUMENTS` for any specifications the user provides, such as:
- Plugin name
- Target agents
- Plugin purpose/description

## Example Workflow

```bash
# Create plugin skeleton
agentpkg init my-plugin --with-agent --with-skill

# Validate structure
agentpkg validate ./my-plugin

# Preview installation
agentpkg install ./my-plugin --all --dry-run

# Install when ready
agentpkg install ./my-plugin --all
```

## Agent Feature Reference

| Feature | claude-code | opencode | codex-cli | gemini-cli | amp-code | cursor |
|---------|-------------|----------|-----------|------------|----------|--------|
| Rules | global + project | global + project | global | global + project | global + project | global + project |
| Commands | commands/*.md | command/*.md | prompts/*.md | commands/*.toml | commands/*.md | - |
| Agents | agents/*.md | agent/*.md | - | - | - | - |
| Skills | skills/*/SKILL.md | - | - | - | - | - |
