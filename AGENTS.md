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
  --scope <scope>   Compile output scope: global or project
  --overwrite       Overwrite existing files
  --no-backup       Skip creating backups
  --dry-run         Preview operations without executing

# Install every child plugin in a directory
agentpkg install-all <directory> [options]
  --harness <ids>   Comma-separated harness IDs
  --all             Install to all supported harnesses
  --project <path>  Project path for project-specific rules
  --scope <scope>   Compile output scope: global or project
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
│   ├── installer.ts    # Core installation logic (file-router phase)
│   └── compile/        # Agent-language compiler (OpenCode v0.1)
│       ├── sources.ts           # Effect Schema source models
│       ├── registry.ts          # Per-plugin indexes
│       ├── context.ts           # CompileContext Effect service
│       ├── errors.ts            # Tagged compile errors
│       ├── load.ts              # Filesystem discovery + Bun module loading
│       ├── validate-contract.ts # Contract export + schema-bridge compatibility checks
│       ├── resolve.ts           # Bundle → ResolvedBundle (reference resolution)
│       ├── compose.ts           # ResolvedBundle → ComposedAgent (target-agnostic)
│       ├── runtime/
│       │   └── schema-bridge.ts # Effect Schema → OpenCode tool.schema bridge
│       ├── pipeline.ts          # Orchestrator (load → resolve → compose → lower → emit)
│       └── lowerers/
│           └── opencode.ts      # OpenCode target: markdown + config patch + generated plugin sync
├── dist/               # Built CLI output
├── examples/           # Example plugins
├── plugins/            # Living documentation plugins
├── package.json
├── tsconfig.json
└── AGENTS.md           # This file
```

## Compile pipeline (v0.1)

agentpkg has two phases. The **install** phase is a file router that copies plugin artifacts (rules, commands, markdown agents, skills) to per-harness locations. The **compile** phase (v0.1) is a structured language-and-compiler for durable agent surfaces: you author identities, personalities, toolspaces, modelspaces, skillspaces, traits, agents, and lifecycles, and agentpkg lowers them into per-harness artifacts.

In the converged language, **canonical tools own business logic** and **traits attach and refine them**. A canonical tool declares a strict input/output contract and a portable implementation. Traits then reference canonical tools, optionally overriding description, refining schemas via slots, and adding capability-specific instructions. Agents bind traits with agent-specific slot values. Lowering still stops at ordinary resolved tool bindings plus ordered trait instructions; target lowerers do not need to understand trait or tool internals.

### Canonical source types

Canonical structured source artifacts are TypeScript-authored:

| Type | Where | What |
|------|-------|------|
| `identity` | `identities/<name>.identity.md` | Prose identity for a stable agent role |
| `personality` | `personalities/<name>.personality.md` | Reusable personality policy (temperament, virtues, communication) |
| `toolspace` | `toolspaces/<name>.toolspace.ts` | Logical tool vocabulary plus per-target concrete tool-name bindings |
| `modelspace` | `modelspaces/<name>.modelspace.ts` | Logical model profiles plus per-target concrete model config blocks |
| `skillspace` | `skillspaces/<name>.skillspace.ts` | Logical unmanaged or harness-native skill vocabulary plus per-target concrete skill names |
| `tool` | `tools/<name>.tool.ts` | Canonical tool definition: strict input/output contract + portable handle implementation |
| `trait` | `traits/<name>.trait.ts` | Canonical protocol/capability unit: slot declarations, canonical tool attachments, ordered instructions, skill permission intent, and logical access intent |
| `agent` | `agents/<name>.agent.ts` | Canonical compiled agent definition |
| `lifecycle` | `lifecycles/<name>.lifecycle.ts` | Higher-order recipe composing agents / other lifecycles with compile-time validation |

Prose-heavy artifacts remain markdown-only by design: identities and personalities.

### Typed refs and dep-alias indirection

The canonical source model uses typed helper constructors rather than raw target strings as the only authoring surface.

Helpers exported from `agentpkg` include:

```ts
import {
  bindTrait,
  defineAgent,
  defineLifecycle,
  defineTool,
  defineToolspace,
  defineModelspace,
  defineSkillspace,
  defineTrait,
  agentRef,
  lifecycleRef,
  traitRef,
  toolRef,
  toolGroupRef,
  modelProfileRef,
  skillRef,
  skillspaceRef,
  schemaSlot,
} from "agentpkg";
```

Example:

```ts
export default defineAgent({
  name: "builder",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  traits: [bindTrait("submittable"), bindTrait("self-assessing")],
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
    tools: [toolRef("agent-core", "workspace-tools", "run_shell")],
  },
});
```

Dep-alias rebinding remains the cross-plugin indirection mechanism. Bare refs resolve locally; prefixed refs resolve through `plugin.json -> deps`.

### Traits and agent capability conformance

Traits are **internal compile-time source artifacts**. They do not lower into target harness artifacts, they are not installable skill-like outputs, and they are not a standalone `plugin.json` target family.

Agents declare capability conformance with `traits: []`, and the canonical current shape is to use `bindTrait(...)` when the agent must provide slot/config values.

Each trait may:

- `slots` — declare the binding contract for agent-provided schema/config values
- `tools` — attach canonical tools by `ref`, optionally overriding description or refining input/output schemas (business-logic override is not allowed)
- `instructions` — add capability-specific guidance to the generated agent in the same order the agent binds traits
- `access.skills` / `inject.skills` — grant permission or visibility for skills without making them direct agent dependencies
- `require.tools` / `require.skills` — assert that the final combined synthetic surface contains those resolved tools or concrete skills
- `access` — declare logical tool / tool-group / skill intent that resolves through toolspaces and skillspaces for the selected harness target

Agent-level `skills` are direct dependencies and render as recommended skills in the generated agent body. Use `skillRef(...)` for managed plugin skills in `skills/<name>/SKILL.md`, and `skillspaceRef(...)` when referencing unmanaged or harness-native skills through a target-specific skillspace. Plain skill strings are not accepted in the compile language.

Canonical tools are the semantic interface. The compiler resolves canonical tool refs, merges trait attachments with the canonical base, validates agent-provided slot bindings fail-closed, materializes ordinary resolved synthetic tool modules, and hands those to lowerers just like any other resolved tool binding.

The compiler resolves traits and their attached canonical tools through the same cross-plugin reference model as agents, toolspaces, and modelspaces. It combines explicit agent access intent with trait access intent, and validates the final surface fail-closed.

### Toolspaces and modelspaces

Toolspaces, modelspaces, and skillspaces move target-bound tool/model/skill strings out of semantic agent definitions.

#### Toolspace

Toolspaces define:

- logical tools
- logical groups
- per-target concrete tool names

Traits and agents reference logical tool refs / tool-group refs. Resolution is target-aware and fail-closed if a required mapping is missing.

#### Modelspace

Modelspaces define:

- logical model profiles
- per-target concrete model config blocks

Agents reference model profiles through `modelProfileRef(...)`. Resolution is target-aware and fail-closed if the selected target has no binding.

#### Skillspace

Skillspaces define:

- logical unmanaged or harness-native skills
- per-target concrete skill names

Agents and traits reference skill permissions through `skillRef(...)` or `skillspaceRef(...)`. Resolution is target-aware and fail-closed if a managed skill is not targeted to the compile harness or if a skillspace mapping is missing.

See `docs/skillspaces.md` for the current global OpenCode / Claude Code / Codex skill inventory and the `skillRef(...)` versus `skillspaceRef(...)` authoring rule.

### Parameterized lifecycle templates

Lifecycle files can be either:

- **templates** — declare `parameters:` and stay source-only until another lifecycle binds them
- **instances** — omit `parameters:` and compile directly into concrete target skills

Template binding is explicit at the phase site via `lifecycle_binding`:

```ts
export default defineLifecycle({
  name: "experiment",
  description: "Reusable experiment lifecycle for ${H}",
  parameters: [
    { name: "H", description: "Hypothesis being tested" },
    { name: "App", description: "Application context" },
  ],
  phases: [
    {
      name: "Run experiment for ${App}",
      notes: {
        Input: "Hypothesis ${H}",
        Done: "Decision recorded for ${App}",
      },
    },
  ],
});
```

```ts
export default defineLifecycle({
  name: "release-experiment",
  description: "Concrete release experiment",
  phases: [
    {
      name: "Experiment",
      lifecycle_binding: {
        lifecycle: lifecycleRef("experiment"),
        bindings: {
          H: "Async commits reduce latency",
          App: "release pipeline",
        },
      },
    },
  ],
});
```

Compile-time rules:

- template placeholders use `${Name}` and must match declared `parameters`
- direct `phase.lifecycle` references may only target non-parameterized lifecycles
- parameterized lifecycle references must use `lifecycle_binding`
- required parameters must be bound, unknown bindings fail the compile
- agent assignment refs and trait requirement refs may not contain template placeholders
- lowering emits only concrete skills with substituted values; templates themselves do not become target-side runtime artifacts

### Lifecycle phase assignment and capability requirements

Lifecycle phases act as compile-time orchestration contracts over assigned agents.

Each phase may declare:

- `agents: []` — one or more concrete agent refs assigned to the phase
- `requires:` — one or more requirement blocks using:
  - `all: []` — trait refs every matching assigned agent must contain
  - `min:` — minimum number of assigned agents that must satisfy `all` (defaults to `1`)

Example:

```ts
export default defineLifecycle({
  name: "delivery-contract",
  description: "Compile-time orchestration contract",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [{ all: [traitRef("committable"), traitRef("self-assessing")] }],
    },
    {
      name: "Hand off work",
      agents: [agentRef("builder"), agentRef("reviewer")],
      requires: [{ all: [traitRef("submittable")], min: 2 }],
    },
  ],
});
```

Validation rules:

- every assigned agent ref must resolve
- every required trait ref must resolve
- for each requirement, the compiler counts assigned agents whose canonical trait set includes **all** required traits
- compile fails if that count is less than `min`

### Lifecycle tool permissions

Lifecycle files may assign canonical tool permissions to agents assigned in that lifecycle. Permissions are protocol-agnostic: the compiler does not know whether the tool backs a work-item board, a queue, Matrix transport, an approval ledger, or something else.

Use `bind` when the lifecycle wants a generated wrapper to pre-fill canonical-tool input fields:

```ts
export default defineLifecycle({
  name: "delivery-contract",
  description: "Compile-time orchestration contract",
  phases: [{ name: "Implement change", agents: [agentRef("builder")] }],
  tool_permissions: [
    {
      agents: [agentRef("builder")],
      tools: [
        {
          ref: "protocol-core:create_item",
          as: "create_item",
          bind: { board: "project-alpha" },
        },
      ],
    },
  ],
});
```

The generated wrapper omits bound fields from the agent-facing input schema and injects them when it calls the canonical tool handle. Bound values must be JSON-serializable. Protocol-specific names such as board ids, queue names, rooms, or channels belong in plugin-owned tools and bindings, not in the compiler.

Lowered lifecycle skills reflect the assigned agents (`agent \`builder\``, `agents \`builder\`, \`reviewer\``) but do **not** expose internal trait requirement machinery to the target harness.

### Canonical tools and trait attachments

Canonical tools are first-class source artifacts in `tools/`. Each canonical tool owns a strict input/output contract and a portable handle implementation:

```ts
import { Schema } from "effect";
import { defineTool } from "agentpkg";

export default defineTool({
  name: "submit_review",
  description: "Submit review findings for a work item.",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
```

Traits attach canonical tools by `ref` and can refine description or input/output schemas via slots. The canonical handle is always reused; traits cannot override business logic:

```ts
import { Schema } from "effect";
import { bindTrait, defineAgent, defineTool, defineTrait, schemaSlot } from "agentpkg";

export default defineTool({
  name: "submit_review",
  description: "Submit review findings.",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  slots: {
    verdict: schemaSlot({ description: "Agent-specific review verdict fields" }),
  },
  async handle(input, context) {
    return { acknowledged: true };
  },
});

export const reviewable = defineTrait({
  name: "reviewable",
  tools: {
    submit_review: { ref: "submit_review" },
  },
});

defineAgent({
  name: "security-reviewer",
  description: "Security reviewer variant",
  identity: "reviewer",
  traits: [
    bindTrait("reviewable", {
      slots: {
        verdict: Schema.Struct({
          summary: Schema.String,
          severity: Schema.Literal("low", "medium", "high"),
        }),
      },
    }),
  ],
});
```

During compile, agentpkg resolves canonical tool refs, merges trait attachments with the canonical base, validates the bound slot values, checks that the resulting tool schemas stay inside the schema-bridge-compatible subset, materializes ordinary resolved synthetic tool modules for lowering, and emits generated contract files internally where a lowerer needs them.

Generated canonical tool execution is target-capability-gated. OpenCode currently supports executable generated canonical tools through compiler-owned generated plugins. Claude Code currently does not have an equivalent generated-tool runtime in agentpkg: it can receive native `allowed-tools` frontmatter from toolspaces, but compiling an agent that binds canonical synthetic tools to Claude Code fails closed instead of emitting non-executable prose.

### Canonical tools vs harness-native plugins

The canonical `tools/` family is for **portable pure-TypeScript tool logic**.

Use canonical tools when the capability can be expressed without importing a harness SDK directly. Business logic belongs here; lowerers then decide how to expose it in each target.

Do **not** force harness-specific runtime behavior into canonical tools. If the capability needs session transport, hook callbacks, TUI routes/dialogs, provider/auth integration, or other harness-native APIs directly, that capability belongs in a standalone harness-native plugin project rather than in the canonical compile-time source model.

Current design examples:

- `lifecycle-core` in `ai-plugins` = canonical lifecycle-domain protocol tools
- `session-inbox` as a standalone OpenCode project = session transport / sendoff UX

Runtime-context guarantees for generated OpenCode adapters remain:

- always present: `sessionID`, `agent`, `timestamp`
- normalized workspace fields: `workingDirectory`, `repoRoot`
- optional when the harness/runtime surfaces them: `sessionTitle`, `durationMs`, `cost`

Agents can still layer inline access/permission overrides on top of trait-owned access intent, but those overrides do not silently remove mandatory trait-owned tool or access requirements.

### Generated OpenCode plugin layout

On compile, agentpkg emits one compiler-owned OpenCode plugin **per compiled source plugin** under the selected OpenCode root:

- global (default): `~/.config/opencode/plugins/agentpkg-generated-<source-plugin>/`
- project-local (`--scope project --project <path>`): `<path>/.opencode/plugins/agentpkg-generated-<source-plugin>/`

The generated layout is:

```text
agentpkg-generated-<source-plugin>/
├── package.json
└── src/
    ├── server.ts
    ├── runtime/
    │   └── schema-bridge.ts
    ├── adapters/
    │   └── <source-plugin>/<name>.adapter.ts
    └── plugins/
        └── <source-plugin>/
            ├── contracts/*.contract.ts
            ├── schemas/*.ts
            └── tools/*.tool.ts
```

Synthetic tool names are scoped by source plugin + agent: `<source-plugin>_<agent-name>_<logical-tool-name>`.

### Cross-plugin references

Agents, traits, toolspaces, modelspaces, and lifecycle phases can reference parts from other plugins:

```json
{
  "deps": {
    "agent-core": "../agent-core"
  },
  "targets": {
    "agents": ["opencode"],
    "lifecycles": ["opencode"],
    "tools": ["opencode"],
    "toolspaces": ["opencode", "claude-code"],
    "modelspaces": ["opencode", "claude-code"]
  }
}
```

Reference form stays dep-alias based: `<dep-name>:<name>` for direct refs, with typed helper constructors carrying the same dep alias when you need structured refs.

v1 supports **local filesystem paths only**. Git / HTTP URL deps are reserved for future.

### Plugin manifest and compile targets

Compile-phase targets live in `plugin.json` just like install-phase targets.

Canonical example:

```json
{
  "name": "my-agents",
  "version": "0.1.0",
  "deps": {
    "agent-core": "../agent-core"
  },
  "targets": {
    "agents": ["opencode", "claude-code"],
    "lifecycles": ["opencode", "claude-code"],
    "toolspaces": ["opencode", "claude-code"],
    "modelspaces": ["opencode", "claude-code"]
  }
}
```

Notes:

- compile-phase targets are `agents`, `lifecycles`, `tools`, `toolspaces`, and `modelspaces`
- `lifecycles`, `tools`, `toolspaces`, and `modelspaces` name source-language artifact families, not fake harness directories
- agents that bind canonical tools should target only harnesses with executable generated-tool support, currently OpenCode, unless a future explicit adapter exists

### CLI

```bash
# Compile a plugin's source artifacts to OpenCode outputs
agentpkg compile ./my-plugin --harness opencode

# Compile a plugin's source artifacts to Claude Code outputs
agentpkg compile ./my-plugin --harness claude-code

# Compile into a project-local OpenCode root for a business/app repo
agentpkg compile ./my-plugin --harness opencode --scope project --project ~/code/my-app

# Dry run
agentpkg compile ./my-plugin --harness claude-code --dry-run
```

### Lowered outputs

#### OpenCode

- Writes `<opencode-root>/agents/<name>.md` for each compiled agent with composed body
- Writes `<opencode-root>/skills/<lifecycle-name>/SKILL.md` for each concrete lifecycle instance
- Patches `agent.<name>` in `<opencode-root>/opencode.json` with compiler-owned model/behavior keys
- Syncs `<opencode-root>/plugins/agentpkg-generated-<source-plugin>/` for synthetic tool plumbing when any compiled agent binds typed tool slots

#### Claude Code

- Writes `<claude-root>/agents/<name>.md` for each compiled agent with Claude-style YAML frontmatter
- Supports `description`, `model`, `temperature`, `top_p`, and `allowed-tools` from compile output
- Writes `<claude-root>/skills/<lifecycle-name>/SKILL.md` for each concrete lifecycle instance
- Does **not** emit generated plugins or synthetic contract tools
- Fails closed when the composed agent surface contains canonical tool bindings, because those bindings require an executable generated-tool runtime

Compile is **idempotent**: re-running with unchanged sources produces no writes.

Lifecycle source artifacts are source-language constructs. For the current supported targets, concrete lifecycle instances lower into harness-intelligible skills at `skills/<lifecycle-name>/SKILL.md`; agentpkg does not emit generic target-side `lifecycles/` folders. A future harness may add a native lifecycle surface, but that would be a target-specific capability rather than the default output shape.

### Compile cache and lockfile

- Successful non-dry-run compiles write a plugin-local cache under `<plugin>/dist/.agentpkg-cache/`
- Each compiled agent cache entry is keyed by `sha256(source-fingerprint + target + scope)`
- The source fingerprint includes the agent source plus the referenced identity, personality, trait bindings, and toolspace/modelspace sources that affect composition for that agent
- Cache hits skip agent resolution/composition and reuse the serialized `ComposedAgent`; cache misses rebuild only that agent
- Successful non-dry-run compiles also write `<plugin>/agentpkg.lock`

### Adding a new target

1. Add a lowerer module under `src/compile/lowerers/`
2. Wire it into `src/compile/pipeline.ts`
3. Update `SUPPORTED_TARGETS` in pipeline.ts
4. Declare compile target capabilities in `src/compile/target-capabilities.ts`, especially whether generated canonical tools are executable
5. Ensure canonical toolspace/modelspace bindings have a corresponding `targets.<id>` block for the new harness

### Install + compile unified

`agentpkg install <plugin>` runs compile first (if the plugin has compile-phase targets for that harness) and then install.

`agentpkg install-all <directory>` applies the same compile-first behavior to each discovered child plugin and honors the same `--scope` / `--project` compile options.

For project-local OpenCode compilation via the unified command:

```bash
agentpkg install ./my-plugin --harness opencode --scope project --project ~/code/my-app
agentpkg install-all ./plugins --harness opencode,claude-code --scope project --project ~/code/my-app
```

Reserved for future:

- Git / HTTP URL deps (currently local paths only)
- richer permission/access ownership after the next work item
- lifecycle runtime orchestration (heartbeat manager stays runtime state in opencode-config)

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
├── skillspaces/        # Compile-time skill name disambiguation tables
│   └── *.skillspace.ts
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
    "skills": ["coding-harness", "claw-harness"],
    "skillspaces": ["opencode", "claude-code"]
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
