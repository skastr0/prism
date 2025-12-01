# agentpkg

A unified plugin distribution system for AI coding agents.

## What is this?

`agentpkg` solves the problem of managing configurations, rules, commands, agents, and skills across multiple AI coding assistants. Instead of manually maintaining separate configurations for Claude Code, OpenCode, Cursor, Codex CLI, Gemini CLI, and Amp Code, you define your artifacts once in a unified format and distribute them to all agents automatically.

## What it does

1. **Formalizes agent configurations** - Knows where each agent stores its config files, rules, commands, and custom agents
2. **Unified artifact format** - Write commands, rules, agents, and skills once using a common markdown format with frontmatter
3. **Smart distribution** - Automatically transforms and copies artifacts to each agent's expected location
4. **Safe operations** - No overwrites by default, automatic backups, dry-run mode for previewing changes
5. **Agent targeting** - Use `targets: [agent1, agent2]` in frontmatter to limit artifacts to specific agents

## Supported Agents

| Agent | Rules | Commands | Agents | Skills |
|-------|-------|----------|--------|--------|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/commands/` | `~/.claude/agents/` | `~/.claude/skills/` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/command/` | `~/.config/opencode/agent/` | - |
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/prompts/` | - | - |
| Gemini CLI | `~/.gemini/GEMINI.md` | `~/.gemini/commands/` (TOML) | - | - |
| Amp Code | `~/.config/amp/AGENTS.md` | `~/.config/amp/commands/` | - | - |
| Cursor | `~/.cursor/.cursorrules` | - | - | - |

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
cp dist/cli.js ~/.local/bin/agentpkg
chmod +x ~/.local/bin/agentpkg
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
  --with-skill      Include example skill (Claude Code)
  --minimal         Create minimal plugin (manifest only)

# Install a plugin
agentpkg install <plugin-path> [options]
  --agent <ids>     Comma-separated agent IDs
  --all             Install to all supported agents
  --project <path>  Project path for project-specific rules
  --overwrite       Overwrite existing files
  --no-backup       Skip creating backups
  --dry-run         Preview operations without executing

# Validate plugin structure
agentpkg validate <plugin-path>

# List supported agents
agentpkg agents
```

## Project Structure

```
agentpkg/
├── src/
│   ├── cli.ts          # CLI entry point and commands
│   ├── types.ts        # TypeScript types and interfaces
│   ├── agents.ts       # Agent registry (paths, formats, capabilities)
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
├── plugin.json         # Manifest (name, version, targets)
├── rules/
│   ├── global/         # Appended to agent's global rules file
│   │   └── *.md
│   └── project/        # Copied to project (when --project specified)
│       └── *.md
├── commands/           # Slash commands
│   └── *.md
├── agents/             # Custom agent definitions
│   └── *.md
└── skills/             # Skills (Claude Code only)
    └── <skill-name>/
        ├── SKILL.md    # Skill definition
        └── *.md        # Supporting files
```

## Unified Frontmatter Format

All markdown artifacts support a common frontmatter format:

```yaml
---
description: What this artifact does
targets: [claude-code, opencode]  # Optional: limits to specific agents

# Agent-specific overrides
claude-code:
  allowed-tools: [Bash, Read]
  model: sonnet
opencode:
  agent: build
  temperature: 0.1
---

Artifact content goes here...
```

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

### Adding New Agents

1. Add agent ID to `AgentId` type in `types.ts`
2. Add agent config to `AGENTS` registry in `agents.ts`
3. Add agent-specific transformations in `installer.ts` if needed
4. Update frontmatter type in `types.ts`

### Adding New Artifact Types

1. Add to `artifact` union type in `FileOperation`
2. Add support flag to `AgentConfig` (e.g., `supportsX`)
3. Add directory field to `AgentConfig` (e.g., `xDir`)
4. Create `planXInstallation()` function in `installer.ts`
5. Call it from `planInstallation()` main function
6. Update `init` command to generate examples

## Development Workflow

1. Make changes to `src/` files
2. Run `bun run typecheck` to verify types
3. Test with `bun run dev -- <command>`
4. Build with `bun run build`
5. Reinstall with `cp dist/cli.js ~/.local/bin/agentpkg`

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
