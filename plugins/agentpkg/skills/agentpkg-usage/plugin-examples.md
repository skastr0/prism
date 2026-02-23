# agentpkg Plugin Examples

## Example 1: Simple Rules Plugin

A plugin that adds coding guidelines to all agents:

```
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
  "targets": "all"
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

## Example 2: Command Plugin

A plugin that adds useful slash commands:

```
dev-commands/
├── plugin.json
└── commands/
    ├── review.md
    └── deploy.md
```

**commands/review.md:**
```markdown
---
description: Review code changes
targets: [claude-code, opencode]

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

## Usage

- `/review` - Review all staged changes
- `/review src/auth.ts` - Review specific file
- `/review src/api focusing on security` - Review with focus area
```

**commands/deploy.md:**
```markdown
---
description: Deploy to an environment
targets: [claude-code, opencode]
---

# Deploy

**Deploy Configuration:** $ARGUMENTS

Deploy the application based on the configuration above.

## Arguments

- `$ARGUMENTS` - Target environment and message

## Usage

- `/deploy staging` - Deploy to staging
- `/deploy production --message "v2.0 release"` - Deploy with message
```

## Example 3: Custom Agent Plugin

A plugin that adds specialized agents:

```
specialized-agents/
├── plugin.json
└── agents/
    └── security-auditor.md
```

**agents/security-auditor.md:**
```markdown
---
description: Security-focused code auditor
targets: [claude-code, opencode]

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

You have READ-ONLY access. Report findings without modifying code.
```

## Example 4: Skill Plugin (Claude Code + OpenCode)

A plugin that adds a specialized skill (works with both Claude Code and OpenCode with opencode-skills plugin):

```
debugging-skill/
├── plugin.json
└── skills/
    └── advanced-debugging/
        ├── SKILL.md
        └── techniques.md
```

**skills/advanced-debugging/SKILL.md:**
```markdown
---
name: advanced-debugging
description: Advanced debugging techniques for complex issues. Use when debugging errors, tracing bugs, or investigating unexpected behavior.
---

# Advanced Debugging Skill

You have expertise in debugging complex issues.

## Approach
1. Reproduce consistently
2. Isolate the problem
3. Form hypotheses
4. Test systematically
5. Document findings
```

**Note:** The `name` field must match the directory name (`advanced-debugging`). The `description` must be at least 20 characters and explain both what the skill does AND when to use it.

## Example 5: Agent-Specific Plugin

A plugin that only targets specific agents:

```
claude-only/
├── plugin.json
├── commands/
│   └── think.md
└── skills/
    └── reasoning/
        └── SKILL.md
```

**plugin.json:**
```json
{
  "name": "claude-only",
  "version": "1.0.0",
  "description": "Claude Code specific enhancements",
  "targets": ["claude-code"]
}
```

## Installation Examples

```bash
# Install to all agents
agentpkg install ./coding-standards --all

# Install to specific agents
agentpkg install ./dev-commands --agent claude-code,opencode

# Preview changes first
agentpkg install ./specialized-agents --all --dry-run

# Install and overwrite existing
agentpkg install ./debugging-skill --all --overwrite
```
