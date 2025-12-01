# my-standards

A plugin for AI coding agents.

## Structure

```
my-standards/
├── plugin.json          # Plugin manifest
├── rules/
│   ├── global/          # Rules applied globally
│   └── project/         # Rules for specific projects
├── commands/            # Custom slash commands
├── agents/              # Custom agent definitions
└── skills/              # Skills (Claude Code)
```

## Installation

```bash
# Install to all agents
agentpkg install ./my-standards --all

# Install to specific agents
agentpkg install ./my-standards --agent claude-code,opencode

# Install with project context
agentpkg install ./my-standards --all --project ~/code/my-project

# Preview without installing
agentpkg install ./my-standards --all --dry-run
```

## Supported Agents

- claude-code (commands, agents, skills)
- opencode (commands, agents)
- codex-cli (prompts/commands)
- gemini-cli (commands)
- amp-code (commands)
- cursor (rules only)
