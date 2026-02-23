# Skill Creator Plugin

A guide for creating effective skills that extend AI agent capabilities.

## What are Skills?

Skills are modular, self-contained packages that extend an agent's capabilities by providing specialized knowledge, workflows, and tools. They transform agents from general-purpose assistants into specialized agents equipped with procedural knowledge.

## Plugin Contents

- **skills/skill-creator/** - Core skill with creation guidance and best practices
- **references/** - Design patterns for workflows and output formats

## Usage

After installing this plugin, mention skill creation to the agent:

- "Help me create a new skill for PDF processing"
- "I want to build a skill for our company's API"
- "Create a skill that helps with data analysis"

## Installation

```bash
agentpkg install ./plugins/skill-creator --all
```

## Note on Scripts

Unlike Anthropic's original skill-creator which includes Python scripts for initialization, validation, and packaging, this plugin relies on agentpkg's built-in commands:

```bash
# Initialize a new skill
agentpkg init my-plugin --with-skill

# Validate skill structure
agentpkg validate ./my-plugin
```

The skill content (what to write, how to structure) is defined in this plugin. The mechanics (file creation, validation) are handled by agentpkg itself.

## Credits

Based on Anthropic's official skill-creator skill from [anthropics/skills](https://github.com/anthropics/skills).
