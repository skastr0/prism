# agentpkg Plugin Examples

## Example 1: Shared Rules Plugin

A plugin that adds coding guidelines to every rules-capable harness in the coding preset:

```text
coding-standards/
├── plugin.json
└── rules/
    └── global/
        └── standards.md
```

**plugin.json:**
```json
{
  "name": "coding-standards",
  "version": "1.0.0",
  "description": "Company coding standards",
  "targets": {
    "rules": ["coding-harness"]
  }
}
```

**rules/global/standards.md:**
```markdown
---
description: Company coding standards
---

# Coding Standards

- Use meaningful variable names
- Write tests for all new features
- Document public APIs
```

## Example 2: Shared Command Plugin

A plugin that adds useful slash commands to command-capable harnesses:

```text
dev-commands/
├── plugin.json
└── commands/
    ├── review.md
    └── deploy.md
```

**plugin.json:**
```json
{
  "name": "dev-commands",
  "version": "1.0.0",
  "description": "Shared developer commands",
  "targets": {
    "commands": ["claude-code", "opencode", "codex-cli", "gemini-cli", "cursor", "factory-droid"]
  }
}
```

**commands/review.md:**
```markdown
---
description: Review code changes

claude-code:
  allowed-tools: [Read, Grep, Glob]
opencode:
  mode: subagent
---

# Code Review

**Review Request:** $ARGUMENTS

Review the code for:
1. Potential bugs
2. Security issues
3. Performance concerns
4. Code style violations
```

**commands/deploy.md:**
```markdown
---
description: Deploy to an environment
---

# Deploy

**Deploy Configuration:** $ARGUMENTS

Deploy the application based on the configuration above.
```

## Example 3: Custom Agent Plugin

A plugin that adds specialized agents where agent installs are supported:

```text
specialized-agents/
├── plugin.json
└── agents/
    └── security-auditor.md
```

**plugin.json:**
```json
{
  "name": "specialized-agents",
  "version": "1.0.0",
  "description": "Security-focused custom agents",
  "targets": {
    "agents": ["claude-code", "opencode"]
  }
}
```

**agents/security-auditor.md:**
```markdown
---
description: Security-focused code auditor

claude-code:
  model: sonnet
opencode:
  mode: subagent
  tools:
    write: false
    edit: false
---

You are a security auditor. Your role is to:

1. Identify security vulnerabilities
2. Check for common attack vectors (XSS, SQL injection, etc.)
3. Verify authentication and authorization logic
4. Review sensitive data handling
```

## Example 4: Skill Plugin Using Presets

A plugin that shares one skill across the coding harnesses plus OpenClaw:

```text
debugging-skill/
├── plugin.json
└── skills/
    └── advanced-debugging/
        ├── SKILL.md
        └── techniques.md
```

**plugin.json:**
```json
{
  "name": "debugging-skill",
  "version": "1.0.0",
  "description": "Advanced debugging guidance",
  "targets": {
    "skills": ["coding-harness", "claw-harness"]
  }
}
```

**skills/advanced-debugging/SKILL.md:**
```markdown
---
name: advanced-debugging
description: Advanced debugging techniques for complex issues. Use when debugging errors, tracing bugs, or investigating unexpected behavior.
---

# Advanced Debugging Skill

You have expertise in debugging complex issues.
```

**Note:** The `name` field must match the directory name (`advanced-debugging`). The `description` must explain both what the skill does and when to use it. If OpenClaw needs a different `SKILL.md` or companion file, add the matching replacement under `harness/openclaw/skills/advanced-debugging/`.

## Example 5: Harness Overlay Plugin

A plugin that keeps shared defaults but replaces one file for OpenCode and one file for OpenClaw:

```text
harness-aware-plugin/
├── plugin.json
├── commands/
│   └── test.md
├── skills/
│   └── example-skill/
│       ├── SKILL.md
│       └── checklist.md
└── harness/
    ├── opencode/
    │   └── commands/
    │       └── test.md
    └── openclaw/
        └── skills/
            └── example-skill/
                └── SKILL.md
```

**plugin.json:**
```json
{
  "name": "harness-aware-plugin",
  "version": "1.0.0",
  "description": "Shared defaults with harness-specific replacements",
  "targets": {
    "commands": ["claude-code", "opencode", "codex-cli", "gemini-cli", "cursor", "factory-droid"],
    "skills": ["coding-harness", "claw-harness"]
  }
}
```

**Overlay behavior:**
- `commands/test.md` is the shared default command.
- `harness/opencode/commands/test.md` replaces that command only for OpenCode.
- `skills/example-skill/SKILL.md` is the shared default skill entry point.
- `harness/openclaw/skills/example-skill/SKILL.md` replaces only the `SKILL.md` file for OpenClaw.
- `skills/example-skill/checklist.md` stays shared for every targeted harness because there is no matching overlay file.
- For OpenClaw, both the shared files and any matching overlay replacements end up under the same `~/.openclaw/skills/example-skill/` destination tree.

## Installation Examples

```bash
# Install to all targeted harnesses
agentpkg install ./coding-standards --all

# Install to specific harness IDs
agentpkg install ./dev-commands --harness claude-code,opencode

# Preview changes first
agentpkg install ./specialized-agents --all --dry-run

# Validate overlay behavior
agentpkg validate ./harness-aware-plugin
agentpkg install ./harness-aware-plugin --harness opencode --dry-run
agentpkg install ./harness-aware-plugin --harness openclaw --dry-run
```
