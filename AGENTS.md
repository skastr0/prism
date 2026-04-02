# agentpkg

A unified plugin distribution system for AI coding harnesses.

## What is this?

`agentpkg` solves the problem of managing configurations, rules, commands, agents, and skills across multiple AI coding assistants. Instead of manually maintaining separate configurations for Claude Code, OpenCode, OpenClaw, Cursor, Codex CLI, Gemini CLI, Amp Code, and Factory Droid, you define your artifacts once in a unified format and distribute them to all targeted harnesses automatically.

## What it does

1. **Formalizes harness configurations** - Knows where each supported harness stores its config files, rules, commands, custom agents, and skills
2. **Unified artifact format** - Write commands, rules, agents, and skills once using a common markdown format with frontmatter
3. **Smart distribution** - Automatically transforms and copies artifacts to each harness's expected location
4. **Safe operations** - No overwrites by default, automatic backups, dry-run mode for previewing changes
5. **Harness-aware targeting** - Declare install targets per artifact in `plugin.json`, use presets like `coding-harness`, and add `harness/<id>/...` overlays when one harness needs a different file

## Supported Harnesses

| Harness | Rules | Commands | Agents | Skills |
|---------|-------|----------|--------|--------|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/commands/` | `~/.claude/agents/` | `~/.claude/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/commands/` | `~/.config/opencode/agents/` | `~/.config/opencode/skills/` |
| OpenClaw | - | - | - | `~/.openclaw/skills/` |
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/prompts/` | `~/.codex/agents/` | `~/.codex/skills/` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `~/.gemini/commands/` | `~/.gemini/agents/` | `~/.gemini/skills/` |
| Amp Code | `~/.config/amp/AGENTS.md` | - | - | `~/.config/amp/skills/` |
| Cursor | `~/.cursor/.cursorrules` | `~/.cursor/commands/` | - | `~/.cursor/skills/` |
| Factory Droid | `~/.factory/AGENTS.md` | `~/.factory/commands/` | `~/.factory/droids/` | `~/.factory/skills/` |

OpenClaw v1 is still skills-only. Shared skill files plus matching `harness/openclaw/skills/...` overlay files install into `~/.openclaw/skills/`. It does not manage rules, `openclaw.json`, commands, custom agents, or additional workspace bootstrap files.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **CLI Framework**: Commander.js
- **Markdown Parsing**: gray-matter (for frontmatter)
- **File Operations**: Bun APIs + Node.js fs/promises

## Building

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Build CLI
bun run build

# Install globally (to ~/.local/bin)
bun run install:local
```

## Running

```bash
# During development
bun run dev -- <command>

# After installation
agentpkg <command>
```

### CLI Commands

```bash
# Create a new plugin
agentpkg init <name> [options]
  --dir <path>      Directory to create plugin in (default: .)
  --with-agent      Include example agent definition
  --with-skill      Include example skill scaffold (preset targets for coding + claw harnesses)
  --minimal         Create minimal plugin (manifest only)

# Install a plugin
agentpkg install <plugin-path> [options]
  --harness <ids>   Comma-separated harness IDs
  --all             Install to all supported harnesses
  --project <path>  Project path for project-specific rules
  --overwrite       Overwrite existing files
  --no-backup       Skip creating backups
  --dry-run         Preview operations without executing

# Validate plugin structure
agentpkg validate <plugin-path>

# List supported harness IDs
agentpkg harnesses
```

## Project Structure

```
agentpkg/
├── src/
│   ├── cli.ts          # CLI entry point and commands
│   ├── types.ts        # TypeScript types and interfaces
│   ├── harnesses.ts    # Harness registry (paths, formats, capabilities)
│   ├── fs.ts           # Filesystem utilities (Bun APIs)
│   ├── manifest.ts     # Plugin manifest and frontmatter parsing
│   └── installer.ts    # Core installation logic
├── dist/               # Built CLI output
├── examples/           # Example plugins
├── plugins/            # Living documentation plugins
├── package.json
├── tsconfig.json
└── AGENTS.md           # This file
```

## Plugin Structure

```
my-plugin/
├── plugin.json         # Manifest (name, version, per-artifact targets)
├── rules/
│   ├── global/         # Appended to each targeted harness's global rules file
│   │   └── *.md
│   └── project/        # Copied to project-aware harnesses when --project is set
│       └── *.md
├── commands/           # Shared slash commands
│   └── *.md
├── agents/             # Shared custom agent definitions
│   └── *.md
├── skills/             # Shared skills (including OpenClaw shared skill files)
│   └── <skill-name>/
│       ├── SKILL.md    # Skill definition
│       └── *.md        # Supporting files
└── harness/            # Optional harness-specific overlays
    └── <id>/           # e.g. opencode, openclaw
        ├── commands/
        │   └── *.md    # Replaces matching shared command files for that harness
        └── skills/
            └── <skill-name>/
                └── *.md # Replaces matching shared skill files for that harness
```

## Harness-Aware Targeting Model

Install targeting lives in `plugin.json` and nowhere else.

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Shared standards plus harness-specific overlays",
  "targets": {
    "rules": ["coding-harness"],
    "commands": ["claude-code", "opencode", "codex-cli", "gemini-cli", "cursor", "factory-droid"],
    "agents": ["claude-code", "opencode"],
    "skills": ["coding-harness", "claw-harness"]
  }
}
```

### Preset groups

- `coding-harness` → `claude-code`, `opencode`, `codex-cli`, `gemini-cli`, `amp-code`, `cursor`, `factory-droid`
- `claw-harness` → `openclaw`

### Rules to remember

- `plugin.json` is the only targeting source for install planning.
- There are no file-level targets for rules, commands, agents, or skills.
- Use explicit harness IDs when a preset would expand to an unsupported surface (for example, `commands` cannot target `amp-code` or `openclaw`).
- If a plugin contains an artifact type, `targets.<artifact>` must declare where that artifact installs.

## Harness Overlays

Use `harness/<id>/...` when one harness needs a different version of a shared artifact.

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

Overlay paths mirror the shared artifact paths. If both a shared file and a harness overlay exist at the same relative path, the harness overlay wins for that harness. Non-overridden files still come from the shared directories.

For OpenClaw, both the shared skill tree and any matching `harness/openclaw/skills/...` replacements are materialized into the same `~/.openclaw/skills/` destination.

## Command Arguments

Custom commands support argument placeholders to accept user input:

### Placeholder Syntax

| Placeholder | Description |
|-------------|-------------|
| `$ARGUMENTS` | The entire raw argument string |

**Note:** For maximum cross-agent compatibility (especially with agents like Gemini CLI), it is highly recommended to design commands to take a single argument string using `$ARGUMENTS`.

### Examples

**Command template:**
```markdown
Review the following code or topic: $ARGUMENTS
```

**Usage:**
```
/review src/main.ts "focusing on security and performance"
```

**Result:**
```
Review the following code or topic: src/main.ts "focusing on security and performance"
```

**Using $ARGUMENTS for free-form input:**
```markdown
---
description: Create a new feature based on user description
---

Create a feature with the following requirements:

$ARGUMENTS
```

**Usage:**
```
/create-feature Add user authentication with OAuth support and session management
```

### Shell Command Injection

Templates also support inline shell execution with backticks:
```markdown
Current branch: `git branch --show-current`
Working directory: `pwd`
```

## Unified Frontmatter Format

All markdown artifacts support a common frontmatter format for metadata and harness-specific settings.

```yaml
---
description: What this artifact does

# Harness-specific overrides
claude-code:
  allowed-tools: [Bash, Read]
opencode:
  mode: subagent
  temperature: 0.1
---

Artifact content goes here...
```

**Important:** Do not use frontmatter `targets` for install planning. Put install targets in `plugin.json` and use `harness/<id>/...` overlays when a harness needs a different file.

## OpenCode Custom Agent Frontmatter Reference

When defining custom agents for OpenCode, use these valid frontmatter properties:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `description` | `string` | - | When to use this agent (triggers selection) |
| `mode` | `"subagent" \| "primary" \| "all"` | `"all"` | Agent visibility mode |
| `model` | `string` | inherited | Model ID (e.g., `anthropic/claude-sonnet-4-20250514`) |
| `temperature` | `number` | model default | Temperature for generation |
| `top_p` | `number` | - | Top-p sampling parameter |
| `tools` | `Record<string, boolean>` | inherited | Enable/disable specific tools |
| `color` | `string` | - | Hex color code (e.g., `#FF5733`) |
| `maxSteps` | `number` | - | Max agentic iterations |
| `disable` | `boolean` | `false` | Disable the agent |
| `permission` | `object` | inherited | Permission overrides |

### Mode Values

- `subagent`: Only available as a Task subagent (not in agent picker)
- `primary`: Available in agent picker for direct use
- `all`: Available both as subagent and in agent picker

### Example Agent Definition

```yaml
---
description: Code reviewer that focuses on best practices
# Install targeting comes from plugin.json -> targets.agents

claude-code:
  model: sonnet

opencode:
  mode: subagent
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  tools:
    write: false
    edit: false
---

You are a code review specialist...
```

**Note:** For OpenCode custom agent definitions, use `mode` to control visibility. Command-specific routing keys are separate harness behavior and are not part of this custom-agent frontmatter reference.

## Code Patterns and Guidelines

### TypeScript

- Use strict mode (`strict: true` in tsconfig)
- Use `noUncheckedIndexedAccess` for safer array access
- Prefer explicit types over inference for function signatures
- Use `type` imports where possible

### File Operations

- Always use the `fs.ts` utilities, not raw Node.js fs or Bun.file directly
- Always expand paths with `expandPath()` before use
- Check existence before operations with `exists()`
- Use `ensureDir()` before writing to potentially non-existent directories

### Error Handling

- Wrap CLI actions in try/catch
- Provide clear error messages with context
- Use `process.exit(1)` for fatal errors

### Installation Logic

- Plan operations first (`planInstallation`)
- Execute planned operations (`executeInstallation`)
- Return structured results (`InstallResult`)
- Support dry-run mode at all stages

### Adding New Harnesses

1. Add the harness ID to `HarnessId` in `types.ts`
2. Add the harness config to the `HARNESSES` registry in `harnesses.ts`
3. Add harness-specific transformations in `installer.ts` if needed
4. Update frontmatter type in `types.ts`

### Adding New Artifact Types

1. Add to `artifact` union type in `FileOperation`
2. Add support flag to `HarnessConfig` (e.g., `supportsX`)
3. Add directory field to `HarnessConfig` (e.g., `xDir`)
4. Create `planXInstallation()` function in `installer.ts`
5. Call it from `planInstallation()` main function
6. Update `init` command to generate examples

## Development Workflow

1. Make changes to `src/` files
2. Run `bun run typecheck` to verify types
3. Test with `bun run dev -- <command>`
4. Build with `bun run build`
5. Reinstall with `bun run install:local`

## Testing Changes

```bash
# Create test plugin
agentpkg init test-plugin --with-agent --with-skill

# Validate
agentpkg validate ./test-plugin

# Dry run to preview
agentpkg install ./test-plugin --all --dry-run

# Install for real (with backup)
agentpkg install ./test-plugin --all
```

## Creating Skills

Skills extend agent capabilities with specialized knowledge, workflows, and tools. They transform agents from general-purpose into specialized assistants with procedural knowledge.

**Supported by:** Claude Code (native), OpenCode (native), OpenClaw (skills root with shared files plus matching `harness/openclaw` overlays)

### Skill Structure

```
skill-name/
├── SKILL.md              # Required: YAML frontmatter + instructions
├── references/           # Optional: docs loaded as needed
├── scripts/              # Optional: deterministic helpers
└── assets/               # Optional: templates, images, fonts for output
```

### SKILL.md Format

```yaml
---
name: kebab-case-name
description: What it does AND when to use it (this triggers the skill)
# compatibility: Optional prerequisites or environment notes
---

# Skill Title

Instructions...
```

**Critical**: The `description` field is the primary trigger. Include both WHAT and WHEN.

### Core Principles

1. **Concise is Key** - Only add context Claude doesn't have. Challenge each piece: "Does this justify its token cost?"

2. **Appropriate Freedom** - Match specificity to task fragility:
   - High: Multiple valid approaches → text instructions
   - Medium: Preferred pattern exists → parameterized examples
   - Low: Fragile operations → exact templates

3. **Progressive Disclosure** - Keep SKILL.md under 500 lines. Split into sibling `.md` files loaded on demand.

### Resource Types

| Type | Purpose | When to Include |
|------|---------|-----------------|
| `references/` | Supporting documentation | Large docs needed contextually |
| `scripts/` | Deterministic helpers | Reliable transforms, validation, or packaging steps |
| `assets/` | Output files | Templates, images, fonts |

### Creation Process

1. **Understand** - Get concrete usage examples
2. **Plan** - Identify reusable supporting files and assets
3. **Initialize** - `agentpkg init my-plugin --with-skill`
4. **Write** - Complete SKILL.md and resources
5. **Validate** - `agentpkg validate ./my-plugin`
6. **Iterate** - Test and improve based on real usage

### Validation Rules

- `name`: kebab-case, lowercase + digits + hyphens, max 64 chars
- `description`: max 1024 chars, no angle brackets `< >`
- `compatibility`: optional string, max 500 chars
- SKILL.md body: recommended max 500 lines

See `plugins/skill-creator/` for the complete skill creation guide with design patterns.
