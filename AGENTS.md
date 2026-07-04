# prism

A unified plugin distribution system for AI coding harnesses.

## What is this?

`prism` solves the problem of managing configurations, rules, commands, agents, and skills across multiple AI coding assistants. Instead of manually maintaining separate configurations for Claude Code, OpenCode, OpenClaw, Hermes Agent, Cursor, Codex CLI, Antigravity CLI, Kimi Code, Amp Code, Grok Build, Factory Droid, and Pi, you define your artifacts once in a unified format and distribute them to all targeted harnesses automatically.

## What it does

1. **Formalizes harness configurations** - Knows where each supported harness stores its config files, rules, commands, custom agents, and skills
2. **Unified artifact format** - Write commands, rules, agents, and skills once using a common markdown format with frontmatter
3. **Smart distribution** - Automatically transforms and copies artifacts to each harness's expected location
4. **Safe operations** - No unmanaged overwrites by default, Prism-owned backups, dry-run mode for previewing changes, and stale-output pruning for files Prism owns
5. **Harness-aware targeting** - Declare install targets per artifact in `plugin.json`, use presets like `coding-harness`, and add `harness/<id>/...` overlays when one harness needs a different file

## Supported Harnesses

| Harness | Rules | Commands | Agents | Skills |
|---------|-------|----------|--------|--------|
| Claude Code | `~/.claude/CLAUDE.md` | generated skills-dir plugin `commands/` | generated skills-dir plugin `agents/` | `~/.claude/skills/` + generated skills-dir plugins |
| OpenCode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/commands/` | `~/.config/opencode/agents/` | `~/.config/opencode/skills/` |
| OpenClaw | - | - | - | `~/.openclaw/skills/` |
| Hermes Agent | - | - | - | `~/.hermes/skills/` |
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/prompts/` | `~/.codex/agents/` | `~/.codex/skills/` |
| Antigravity CLI | generated plugin `rules/` | - | generated plugin `agents/` | generated plugin `skills/` |
| Kimi Code | generated plugin `prism-context` skill | generated plugin command skills | generated plugin role skills | generated plugin skills |
| Amp Code | `~/.config/amp/AGENTS.md` | generated plugin `registerCommand` | generated role skills | `~/.config/amp/skills/` |
| Grok Build | `~/.grok/AGENTS.md` | - | generated plugin bundle | `~/.grok/skills/` |
| Cursor | `~/.cursor/.cursorrules` | generated local plugin `commands/` | - | `~/.cursor/skills/` + generated MCP |
| Factory Droid | `~/.factory/AGENTS.md` | `~/.factory/commands/` | generated plugin `droids/` | `~/.factory/skills/` |
| Pi | generated package extension context | generated package `prompts/` | pi-agents markdown discovery | generated package `skills/` |

OpenClaw v1 is still skills-only. Shared skill files plus matching `harness/openclaw/skills/...` overlay files install into `~/.openclaw/skills/`. It does not manage rules, `openclaw.json`, commands, custom agents, or additional workspace bootstrap files.

Hermes first-party support is skills plus generated MCP tools. Shared skill files plus matching `harness/hermes/skills/...` overlay files install into `~/.hermes/skills/`. Compile-phase `tools/*.tool.ts` artifacts lower into Prism's canonical generated MCP bundle under `<PRISM_HOME>/runtime/mcp/<source-plugin>/server.mjs`, and Prism patches `~/.hermes/config.yaml -> mcp_servers` to reference that bundle. Hermes profile-local MCP is expressed by compiling the normal `hermes` target against a profile home such as `~/.hermes/profiles/coder` with `--root` / `--compile-root`. Prism does not lower Hermes rules, commands, custom agents, SOUL/personality files, runtime delegation, or native Python plugins.

Claude Code is part of the `coding-harness` preset with compile-phase skills-directory plugin support. Prism emits one generated plugin under `<claude-root>/skills/prism-generated-<source-plugin>/` with `.claude-plugin/plugin.json` plus root-level `commands/`, `agents/`, `skills/`, `hooks/`, and `.mcp.json` components. This is Prism's canonical generated-local Claude surface: it uses Claude's documented in-place skills-directory plugin autoload path instead of writing marketplace cache internals. Plugin skills and commands are namespaced by the generated plugin name, so Prism does not write direct `~/.claude/commands/` files for command artifacts. Skills-only plugins may still install shared skills directly into `~/.claude/skills/`; when a plugin also targets Claude compile surfaces, targeted skills are bundled into the generated plugin to avoid double-loading Prism-owned skill files.

Antigravity CLI is part of the `coding-harness` preset with compile-phase plugin-bundle support. Prism emits one generated plugin under `<antigravity-root>/plugins/prism-generated-<source-plugin>/` using Antigravity's native root `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/`, `agents/`, and `skills/` layout. Managed skills and concrete orbit instances lower as plugin skills; official Antigravity CLI skills surface as slash commands, so Prism does not write direct command files and direct `targets.commands: ["antigravity-cli"]` fails manifest validation.

Grok Build is part of the `coding-harness` preset. Install-phase rules append to `~/.grok/AGENTS.md`, shared skills install into `~/.grok/skills/`, and compile-phase agents, managed skills, orbit skills, hooks, and canonical tools lower into `~/.grok/plugins/prism-generated-<source-plugin>/`. Prism does not install Grok commands or patch `~/.grok/config.toml`; preset expansion is artifact-aware, so `targets.commands: ["coding-harness"]` skips Grok while direct `targets.commands: ["grok"]` remains invalid.

Factory Droid is part of the `coding-harness` preset with full compile-phase plugin-bundle support. Install-phase rules append/copy into `.factory` roots and install-phase commands still write `commands/`. Skills-only plugins still install shared skills directly into `.factory/skills/`; when a plugin also targets Factory compile surfaces, targeted skills are bundled into `<factory-root>/plugins/prism-generated-<source-plugin>/skills/` instead to avoid double-loading Prism-owned skill files. Compile-phase agents, orbit skills, hooks, and canonical tools lower into the same generated bundle using Factory's native plugin layout: `.factory-plugin/plugin.json`, root `droids/`, `skills/`, `mcp.json`, and `hooks/hooks.json`. Prism does not patch `~/.factory/settings.json` for generated plugin bundles.

Kimi Code is part of the `coding-harness` preset with compile-phase generated plugin support. The active Kimi Code target uses the current `~/.kimi-code` home exclusively. Prism emits one generated user-scoped plugin under `<kimi-root>/plugins/managed/prism-generated-<source-plugin>/` with `kimi.plugin.json`, plugin skills, session-start context, plugin-declared MCP servers, and hook wrappers, then registers it in `<kimi-root>/plugins/installed.json` so Kimi loads it as an enabled plugin. Prism patches `<kimi-root>/config.toml -> [[hooks]]` for Kimi hooks because official Kimi plugins ignore hook fields. The current Moonshot-hosted Kimi Code CLI docs also support project-local `.kimi-code/skills/` and `.kimi-code/mcp.json`, but Prism keeps generated Kimi plugin output global/user-scoped for now because Kimi plugin installs are user-scoped. Compiled agents lower honestly as role/workflow skills, not native agent files, because Kimi has no headless agent/sub-agent file surface. The Prism workflow worker drives Kimi with `--prompt --output-format stream-json` and loads the generated plugin's `skills/` directory via `--skills-dir`; Kimi's prompt mode does not accept `--yolo` or `--auto`, so headless tool-use automation is limited to single-prompt responses.

Amp Code is part of the `coding-harness` preset with compile-phase native TypeScript plugin support. Prism emits one generated plugin under `.amp/plugins/prism-generated-<source-plugin>.ts` for project scope or `<amp-root>/plugins/prism-generated-<source-plugin>.ts` for global/system scope, lowers markdown commands with Amp's `registerCommand` API by appending the command prompt to the active thread, registers canonical tools with Amp's `registerTool` API, and lowers supported Prism hooks through Amp's `amp.on(...)` plugin events. Prism maps `tool.before -> tool.call`, `tool.after -> tool.result`, and `session.start -> session.start`; `session.end` fails closed because Amp does not expose a native session-end event. Compiled agents still lower as generated role skills rather than experimental custom Amp agent modes.

Cursor is part of the `coding-harness` preset with tools-only compile support. Install-phase rules and skills still write to Cursor's direct file surfaces; command artifacts lower into a generated local Cursor plugin under `<cursor-root>/plugins/local/prism-generated-<source-plugin>/` with `.cursor-plugin/plugin.json` and `commands/` component discovery. Cursor Agent Skills are docs-backed under `.cursor/skills/` and `~/.cursor/skills/`. Compile-phase `tools/*.tool.ts` artifacts lower into Prism's canonical generated MCP bundle under `<PRISM_HOME>/runtime/mcp/<source-plugin>/server.mjs`, and Prism patches one compiler-owned `mcpServers.prism-generated-<source-plugin>` entry in `~/.cursor/mcp.json` globally or `.cursor/mcp.json` for project scope. Generated MCP uses Cursor's Streamable HTTP `url` plus `headers` shape. Prism does not compile Cursor agents, orbits, hooks, or per-agent skill permission visibility yet.

Pi is part of the `coding-harness` preset with compile-phase package support plus pi-agents markdown discovery. Prism writes compiled agents to `~/.pi/agents/<name>.md` for global scope and `.pi/agents/<name>.md` for project scope, emits one generated local Pi package under `<pi-settings-root>/packages/prism-generated-<source-plugin>/`, patches `<pi-settings-root>/settings.json -> packages`, bundles targeted skills and concrete orbit skills into package `skills/`, lowers commands as Pi prompt templates in package `prompts/`, injects rules/context through a generated extension, registers canonical tools through Pi's `registerTool` extension API, and runs Prism hooks through Pi extension events plus generated hook wrappers.

## Architecture invariants (owner doctrine — binding on all agents working in this repo)

These are settled owner rulings, not suggestions. Do not re-litigate them; when code violates one, the code is the bug. Work items: PQ-154 (model addressing), PQ-162 (per-kind contract laws), PQ-163 (harness registry) on the `prism` Tower board.

1. **Shape in core, data in userland.** Prism core owns the *contract* (types/schema) of every artifact kind — agents, skills, tools, MCP servers, rules, commands, hooks, modelspaces, workflows. The *data* is user-aligned and lives in 0..n plugins in the dependency graph. Core ships no default data.
2. **Merge-or-crash, declared per kind.** Multiple plugins may carry the same artifact kind only where that kind's contract declares a dedupe-and-merge law (e.g. modelspaces merge by (modelspace, profile, harness) cell; shared-file regions merge by fence key). Where no merge law is sensible — duplicated agents, duplicated tools — the law is **crash**: a plan/validate-time hard error naming both plugins. Never silent last-writer-wins.
3. **One representation per artifact, across all consumers.** Within a plugin, harness lowering and workflow type generation must speak the same representation of the same artifact. Two stacks addressing the same concept differently is a bug (see: amp workflow mode vs modelspaces, closed by PQ-154).
4. **Model identifiers are harness-bound.** There is no transcendent model value. Each harness owns its addressing shape (opencode slug; codex slug+effort; pi provider+model; amp `mode: deep|rush`). Profile cells are typed with each harness's own shape. Never introduce a shared "model" type; the only shared thing is the record structure.
5. **Demand follows capability.** A resolver may only require data that some consuming surface actually uses. Do not demand a model target for a harness whose compiled agent surface cannot carry one. Capability truth lives in the lowerer-capabilities registry — the single harness enumeration; all other harness lists derive from it or are gated against it.
6. **No warnings.** A warning is a deferred error: it accumulates until a real error is buried in it, and in AI-era economics fixes are near-instant. Every state is either declared-valid (silent) or invalid (hard error). Errors carry their remediation verbatim — file, line, and the exact one-line edits — so any agent fixes them in one shot (error-as-prompt). Batch isolation is kept: one plugin's error never aborts its neighbors' convergence.
7. **No adopt, ever.** Prism never takes ownership of a file it cannot deterministically prove it owns (namespace, fence, or ledger). A persistent `blocked` means the *claim* is wrong (e.g. a whole-file claim on a shared user file), not that adoption machinery is missing. Shared user files (AGENTS.md, config.toml, settings) take fenced regions only — never whole-file ownership.
8. **When runtime polices what types could forbid, the type is lying — fix the type.** Prefer making the invalid state unrepresentable (required records, per-harness sums, exhaustive switches) over runtime membership checks. Runtime checks survive only at cross-version plugin boundaries.
9. **Leaf before lesson.** An error that violates one of these invariants is a leaf bug: fix it at leaf scope plus at most one mechanical assertion. New doctrine requires counted recurrence (≥2 independent surfaces), never narrative elegance.

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

# Install dev binary as prism-dev (symlink to dist/; does not touch mise-managed prism)
bun run install:dev
```

## Running

```bash
# During development
bun run dev -- <command>

# After installation
prism <command>
```

### CLI Commands

```bash
# Create a new plugin
prism init <name> [options]
  --dir <path>      Directory to create plugin in (default: .)
  --with-agent      Include example agent definition
  --with-skill      Include example skill scaffold (preset targets for coding + claw harnesses)
  --minimal         Create minimal plugin (manifest only)

# Refresh a plugin
prism refresh <plugin-path> [options]
  --harness <ids>   Comma-separated harness IDs
  --all             Refresh all supported harnesses
  --project <path>  Project path for project-specific rules
  --scope <scope>   Compile output scope: global or project
  --overwrite       Overwrite existing files
  --dry-run         Preview the refresh plan without writing

# Preview refresh changes
prism plan <plugin-path> [options]
  --harness <ids>   Comma-separated harness IDs
  --all             Plan all supported harnesses
  --json            Print a machine-readable JSON envelope

# Refresh every child plugin in a directory
prism refresh --plugins <directory> [options]
  --harness <ids>   Comma-separated list of harness IDs
  --all             Refresh all supported harnesses
  --project <path>  Project path for project-specific rules
  --scope <scope>   Compile output scope: global or project
  --overwrite       Overwrite existing files
  --dry-run         Preview operations without executing

# Diagnose harness config and refresh-plan health
prism doctor <plugin-path> [options]
  --harness <ids>   Comma-separated list of harness IDs
  --all             Check all supported harnesses
  --fix             Apply refresh changes when possible
  --json            Print a machine-readable JSON report

# Validate plugin structure
prism validate <plugin-path>

# List supported harness IDs
prism harnesses
```

### Prism home and managed state

Prism stores cross-harness state in Prism home, defaulting to `~/.prism` and overridable with `PRISM_HOME`.

- `~/.prism/config.json` controls managed behavior. The current config shape is `{ "version": 1, "backup": { "mode": "always" | "never", "retentionPerTarget": 3 } }`.
- `~/.prism/backups/` stores managed backups outside harness config trees. Prism preserves original filenames and does not create sibling `.bak` files.
- `~/.prism/state/roots/*.json` records files and rule sections Prism owns for each harness root.
- Re-running `prism refresh` is the sync operation. It compiles first where relevant, writes desired outputs, skips unchanged content, fails closed on drift, and prunes stale Prism-owned outputs.
- Existing files that Prism does not own are not silently adopted. Use `--overwrite` when deliberately replacing an unmanaged whole-file artifact.

## Project Structure

```
prism/
├── src/
│   ├── cli.ts          # CLI entry point and commands
│   ├── types.ts        # TypeScript types and interfaces
│   ├── harnesses.ts    # Harness registry (paths, formats, capabilities)
│   ├── lowerer-capabilities.ts # Typed lowerer surface-kind contract
│   ├── fs.ts           # Filesystem utilities (Bun APIs)
│   ├── manifest.ts     # Plugin manifest and frontmatter parsing
│   ├── refresh.ts      # Unified file-router refresh planning
│   ├── doctor.ts       # Harness config and refresh-plan diagnostics
│   ├── sync/           # Desired-state planner and one-writer apply engine
│   ├── state/          # Per-root snapshot manifests
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

prism has two phases. The **install** phase is a file router that copies plugin artifacts (rules, commands, markdown agents, skills) to per-harness locations. The **compile** phase (v0.1) is a structured language-and-compiler for durable agent surfaces: you author identities, personalities, toolspaces, modelspaces, skillspaces, traits, agents, and orbits, and prism lowers them into per-harness artifacts.

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
| `orbit` | `orbits/<name>.orbit.ts` | Higher-order recipe composing agents / other orbits with compile-time validation |

Prose-heavy artifacts remain markdown-only by design: identities and personalities.

### Typed refs and dep-alias indirection

The canonical source model uses typed helper constructors rather than raw target strings as the only authoring surface.

Helpers exported from `prism` include:

```ts
import {
  agentRef,
  orbitRef,
  traitRef,
  toolRef,
  toolGroupRef,
  modelProfileRef,
  skillRef,
  skillspaceRef,
  schemaSlot,
  type AgentSource,
  type ModelspaceSource,
  type OrbitSource,
  type SkillspaceSource,
  type ToolSource,
  type ToolspaceSource,
  type TraitSource,
} from "prism";
```

Example:

```ts
export default {
  name: "builder",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  traits: ["submittable", "self-assessing"],
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
    tools: [toolRef("agent-core", "workspace-tools", "run_shell")],
  },
} satisfies AgentSource;
```

Dep-alias rebinding remains the cross-plugin indirection mechanism. Bare refs resolve locally; prefixed refs resolve through `plugin.json -> deps`.

### Traits and agent capability conformance

Traits are **internal compile-time source artifacts**. They do not lower into target harness artifacts, they are not installable skill-like outputs, and they are not a standalone `plugin.json` target family.

Agents declare capability conformance with `traits: []`. The canonical current shape is a plain trait ref for simple conformance, or an object binding when the agent must provide tool slot/config values.

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

### Parameterized orbit templates

Orbit files can be either:

- **templates** — declare `parameters:` and stay source-only until another orbit binds them
- **instances** — omit `parameters:` and compile directly into concrete target skills

Template binding is explicit at the phase site via `orbit_binding`:

```ts
import type { OrbitSource } from "prism";

export default {
  name: "experiment",
  description: "Reusable experiment orbit for ${H}",
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
} satisfies OrbitSource;
```

```ts
import { orbitRef, type OrbitSource } from "prism";

export default {
  name: "release-experiment",
  description: "Concrete release experiment",
  phases: [
    {
      name: "Experiment",
      orbit_binding: {
        orbit: orbitRef("experiment"),
        bindings: {
          H: "Async commits reduce latency",
          App: "release pipeline",
        },
      },
    },
  ],
} satisfies OrbitSource;
```

Compile-time rules:

- template placeholders use `${Name}` and must match declared `parameters`
- direct `phase.orbit` references may only target non-parameterized orbits
- parameterized orbit references must use `orbit_binding`
- required parameters must be bound, unknown bindings fail the compile
- agent assignment refs and trait requirement refs may not contain template placeholders
- lowering emits only concrete skills with substituted values; templates themselves do not become target-side runtime artifacts

### Orbit phase assignment and capability requirements

Orbit phases act as compile-time orchestration contracts over assigned agents.

Each phase may declare:

- `agents: []` — one or more concrete agent refs assigned to the phase
- `requires:` — one or more requirement blocks using:
  - `all: []` — trait refs every matching assigned agent must contain
  - `min:` — minimum number of assigned agents that must satisfy `all` (defaults to `1`)

Example:

```ts
import { agentRef, traitRef, type OrbitSource } from "prism";

export default {
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
} satisfies OrbitSource;
```

Validation rules:

- every assigned agent ref must resolve
- every required trait ref must resolve
- for each requirement, the compiler counts assigned agents whose canonical trait set includes **all** required traits
- compile fails if that count is less than `min`

### Orbit tool permissions

Orbit files may assign canonical tool permissions to agents assigned in that orbit. Permissions are protocol-agnostic: the compiler does not know whether the tool backs a work-item board, a queue, Matrix transport, an approval ledger, or something else.

Use `bind` when the orbit wants a generated wrapper to pre-fill canonical-tool input fields:

```ts
import { agentRef, type OrbitSource } from "prism";

export default {
  name: "delivery-contract",
  description: "Compile-time orchestration contract",
  phases: [{ name: "Implement change", agents: [agentRef("builder")] }],
  tool_permissions: [
    {
      agents: [agentRef("builder")],
      tools: [
        {
          ref: "protocol-core:create_glyph",
          as: "create_glyph",
          bind: { board: "project-alpha" },
        },
      ],
    },
  ],
} satisfies OrbitSource;
```

The generated wrapper omits bound fields from the agent-facing input schema and injects them when it calls the canonical tool handle. Bound values must be JSON-serializable. Protocol-specific names such as board ids, queue names, rooms, or channels belong in plugin-owned tools and bindings, not in the compiler.

Lowered orbit skills reflect the assigned agents (`agent \`builder\``, `agents \`builder\`, \`reviewer\``) but do **not** expose internal trait requirement machinery to the target harness.

### Canonical tools and trait attachments

Canonical tools are first-class source artifacts in `tools/`. Each canonical tool owns a strict input/output contract and a portable handle implementation:

```ts
import { Schema } from "effect";
import type { ToolSource } from "prism";

export default {
  name: "submit_review",
  description: "Submit review findings for a glyph.",
  input: Schema.Struct({ summary: Schema.String }),
  output: Schema.Struct({ acknowledged: Schema.Boolean }),
  async handle(input, context) {
    return { acknowledged: true };
  },
} satisfies ToolSource;
```

Traits attach canonical tools by `ref` and can refine description or input/output schemas via slots. The canonical handle is always reused; traits cannot override business logic:

```ts
import { Schema } from "effect";
import { schemaSlot, type AgentSource, type ToolSource, type TraitSource } from "prism";

export const submitReviewTool = {
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
} satisfies ToolSource;

export const reviewable = {
  name: "reviewable",
  tools: {
    submit_review: { ref: "submit_review" },
  },
} satisfies TraitSource;

export default {
  name: "security-reviewer",
  description: "Security reviewer variant",
  identity: "reviewer",
  traits: [
    {
      trait: "reviewable",
      tools: {
        submit_review: {
          slots: {
            verdict: Schema.Struct({
              summary: Schema.String,
              severity: Schema.Literal("low", "medium", "high"),
            }),
          },
        },
      },
    },
  ],
} satisfies AgentSource;
```

During compile, prism resolves canonical tool refs, merges trait attachments with the canonical base, validates the bound slot values, checks that the resulting tool schemas stay inside the schema-bridge-compatible subset, materializes ordinary resolved synthetic tool modules for lowering, and emits generated contract files internally where a lowerer needs them.

Generated canonical tool execution is target-capability-gated. OpenCode supports executable generated canonical tools through compiler-owned generated plugins. Claude Code, Antigravity CLI, Kimi Code, Grok, and Factory Droid support them through compiler-owned plugin bundles with bundled MCP servers. Cursor supports tool-only plugins through generated MCP entries in `mcp.json`. Pi supports canonical tools through compiler-owned package extensions using Pi's native `registerTool` API.

### Canonical tools vs harness-native plugins

The canonical `tools/` family is for **portable pure-TypeScript tool logic**.

Use canonical tools when the capability can be expressed without importing a harness SDK directly. Business logic belongs here; lowerers then decide how to expose it in each target.

Do **not** force harness-specific runtime behavior into canonical tools. If the capability needs session transport, hook callbacks, TUI routes/dialogs, provider/auth integration, or other harness-native APIs directly, that capability belongs in a standalone harness-native plugin project rather than in the canonical compile-time source model.

Current design examples:

- `orbit-core` in `ai-plugins` = canonical orbit-domain protocol tools
- `session-inbox` as a standalone OpenCode project = session transport / sendoff UX

Runtime-context guarantees for generated OpenCode adapters remain:

- always present: `sessionID`, `agent`, `timestamp`
- normalized workspace fields: `workingDirectory`, `repoRoot`
- optional when the harness/runtime surfaces them: `sessionTitle`, `durationMs`, `cost`

Agents can still layer inline access/permission overrides on top of trait-owned access intent, but those overrides do not silently remove mandatory trait-owned tool or access requirements.

### Generated OpenCode plugin layout

On compile, prism emits one compiler-owned OpenCode plugin **per compiled source plugin** under the selected OpenCode root:

- global (default): `~/.config/opencode/plugins/prism-generated-<source-plugin>/`
- project-local (`--scope project --project <path>`): `<path>/.opencode/plugins/prism-generated-<source-plugin>/`

The generated layout is:

```text
prism-generated-<source-plugin>/
└── dist/
    └── server.mjs
```

Synthetic tool names are scoped by source plugin + agent: `<source-plugin>_<agent-name>_<logical-tool-name>`.

### Cross-plugin references

Agents, traits, toolspaces, modelspaces, and orbit phases can reference parts from other plugins:

```json
{
  "deps": {
    "agent-core": "../agent-core"
  },
  "targets": {
    "agents": ["opencode"],
    "orbits": ["opencode"],
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
    "agents": ["opencode", "claude-code", "antigravity-cli", "grok", "factory-droid", "pi", "kimi-code"],
    "orbits": ["opencode", "claude-code", "antigravity-cli", "grok", "factory-droid", "pi", "kimi-code"],
    "tools": ["opencode", "antigravity-cli", "grok", "factory-droid", "pi", "kimi-code", "cursor"],
    "toolspaces": ["opencode", "claude-code", "antigravity-cli", "grok", "factory-droid", "pi", "kimi-code"],
    "modelspaces": ["opencode", "claude-code", "antigravity-cli", "grok", "factory-droid", "pi", "kimi-code"]
  }
}
```

Notes:

- compile-phase targets are `agents`, `orbits`, `tools`, `toolspaces`, `modelspaces`, `skillspaces`, and `hooks`
- `orbits`, `tools`, `toolspaces`, `modelspaces`, `skillspaces`, and `hooks` name source-language artifact families, not fake harness directories
- agents that bind canonical tools should target only harnesses with both an agent surface and executable generated-tool support, such as OpenCode, Antigravity CLI, Kimi Code, Grok, Factory Droid, and Pi; tools-only plugins may target Hermes or Cursor for generated MCP exposure

### CLI

```bash
# Refresh a plugin's source artifacts into OpenCode outputs
prism refresh ./my-plugin --harness opencode

# Refresh a plugin's source artifacts into Claude Code outputs
prism refresh ./my-plugin --harness claude-code

# Refresh canonical tools into a Hermes MCP server and config entry
prism refresh ./my-plugin --harness hermes

# Refresh Antigravity agents, skills, hooks, rules, and canonical tools into a generated plugin bundle
prism refresh ./my-plugin --harness antigravity-cli

# Refresh Grok agents, skills, hooks, and canonical tools into a generated Grok plugin bundle
prism refresh ./my-plugin --harness grok

# Refresh Factory Droid agents, skills, hooks, and canonical tools into a generated Factory plugin bundle
prism refresh ./my-plugin --harness factory-droid

# Refresh Pi agents, prompt templates, hooks, and canonical tools into generated Pi surfaces
prism refresh ./my-plugin --harness pi

# Refresh Kimi role skills, plugin MCP, and hooks into generated Kimi surfaces
prism refresh ./my-plugin --harness kimi-code

# Refresh canonical tools into Cursor mcp.json
prism refresh ./my-plugin --harness cursor

# Refresh into a project-local OpenCode root for a business/app repo
prism refresh ./my-plugin --harness opencode --scope project --project ~/code/my-app

# Plan without writing
prism plan ./my-plugin --harness claude-code
```

### Lowered outputs

#### OpenCode

- Writes `<opencode-root>/agents/<name>.md` for each compiled agent with composed body
- Writes `<opencode-root>/skills/<orbit-name>/SKILL.md` for each concrete orbit instance
- Patches `agent.<name>` in `<opencode-root>/opencode.json` with compiler-owned model/behavior keys
- Syncs `<opencode-root>/plugins/prism-generated-<source-plugin>/` for synthetic tool plumbing when any compiled agent binds typed tool slots

#### Claude Code

- Writes one generated skills-directory plugin bundle per compiled source plugin under `<claude-root>/skills/prism-generated-<source-plugin>/`
- Writes compiled agents into the generated plugin's `agents/<name>.md` with Claude-style YAML frontmatter
- Supports `description`, `model`, `temperature`, `top_p`, and `allowed-tools` from compile output
- Writes targeted managed skills and concrete orbit instances into the generated plugin's `skills/<name>/SKILL.md`
- Writes command artifacts into the generated plugin's root `commands/` component; Claude exposes plugin commands/skills under a namespaced slash-command form such as `/prism-generated-my-plugin:review`
- Emits canonical `tools/*.tool.ts` through Prism's canonical Streamable HTTP MCP bundle at `<PRISM_HOME>/runtime/mcp/<source-plugin>/server.mjs`, plus plugin-local `.mcp.json`; omitted manifest ports are selected before config write

#### Hermes

- Writes targeted plugin skills into `<hermes-root>/skills/<skill-name>/...`
- Writes concrete orbit instances into `<hermes-root>/skills/<orbit-name>/SKILL.md`
- Emits canonical `tools/*.tool.ts` as Prism's canonical generated MCP bundle at `<PRISM_HOME>/runtime/mcp/<source-plugin>/server.mjs`
- Patches `<hermes-root>/config.yaml` with a compiler-owned `mcp_servers.prism-generated-<source-plugin>` entry using a managed Streamable HTTP loopback `url`; omitted HTTP ports are selected before config write
- A Hermes profile is treated as a harness root: use `--compile-root ~/.hermes/profiles/<name>` for `refresh` or `plan`
- Fails closed for compiled agents and hooks; SOUL/personality lowering, runtime delegation, and native Hermes Python plugins are intentionally out of scope

#### Antigravity CLI

- Writes one generated plugin bundle per compiled source plugin under `<antigravity-root>/plugins/prism-generated-<source-plugin>/`
- Writes root `plugin.json`, plugin `rules/context.md`, and compiled agents into `agents/<name>.md` with Antigravity frontmatter
- Writes targeted managed skills and concrete orbit instances into the generated plugin's `skills/<name>/SKILL.md`
- Emits canonical `tools/*.tool.ts` through Prism's canonical Streamable HTTP MCP bundle plus plugin-local `mcp_config.json` using Antigravity's `serverUrl` field and Prism-managed runtime metadata, with omitted manifest ports selected before config write
- Emits root `hooks.json` and bundled hook wrappers for Prism hook DSL events mapped to Antigravity hook names: `tool.before`/`tool.after`/`session.start`/`session.end` become `PreToolUse`/`PostToolUse`/`PreInvocation`/`Stop`. The wrapper preserves the native Antigravity payload at `event.native`, but Prism does not expose Antigravity-only `PostInvocation`, `injectSteps`, or `terminationBehavior` as compile-language hook outputs.
- Does not lower direct command files; commands should be modeled as plugin skills/orbits, and direct `targets.commands: ["antigravity-cli"]` fails manifest validation
#### Grok Build

- Writes one generated plugin bundle per compiled source plugin under `<grok-root>/plugins/prism-generated-<source-plugin>/`
- Writes compiled agents into the generated plugin's `agents/<name>.md` with Grok frontmatter overrides from `targets.grok`
- Writes targeted managed skills and concrete orbit instances into the generated plugin's `skills/<name>/SKILL.md`
- Emits canonical `tools/*.tool.ts` through Prism's canonical Streamable HTTP MCP bundle plus plugin-local `.mcp.json`; generated sessions use the `X-Prism-Mcp-Exposure` header for deny-by-default tool exposure
- Emits `hooks/hooks.json` and bundled hook wrappers using Grok hook event names and Grok deny output for blocking `tool.before` hooks
- Does not install commands or patch `config.toml` in PR1

#### Factory Droid

- Writes one generated plugin bundle per compiled source plugin under `<factory-root>/plugins/prism-generated-<source-plugin>/`
- Writes `.factory-plugin/plugin.json` plus compiled droids into the generated plugin's `droids/<name>.md` with Factory frontmatter overrides from `targets.factory-droid`; known Factory tool categories are expanded to concrete tool arrays before generated MCP tool names are added
- Writes targeted managed skills and concrete orbit instances into the generated plugin's `skills/<name>/SKILL.md`
- Emits canonical `tools/*.tool.ts` through Prism's canonical Streamable HTTP MCP bundle plus plugin-local `mcp.json`; generated tools use Factory's `mcp__<server>__<tool>` tool-name pattern in droid frontmatter and hook matchers; omitted manifest ports let Prism select the managed daemon port before config write
- Emits `hooks/hooks.json` and bundled hook wrappers using Factory hook event names and `${DROID_PLUGIN_ROOT}` wrapper commands
- Bundles targeted skills and direct `skillRef(...)` dependencies, but fails closed for permission-only skill visibility because Factory's documented droid frontmatter does not expose per-droid skill allowlists
- Does not install compile-owned commands or patch `settings.json`; install-phase rules and commands retain direct `.factory/` behavior, while skills-only plugins still install to `.factory/skills/` and compiled Factory bundles carry targeted skills inside the generated plugin to avoid double-loading Prism-owned skill files

#### Kimi Code

- Writes one generated user-scoped plugin bundle per compiled source plugin under `<kimi-root>/plugins/managed/prism-generated-<source-plugin>/`
- Writes `kimi.plugin.json` with plugin `skills`, optional `sessionStart.skill`, and plugin-declared `mcpServers`
- Registers the generated plugin in `<kimi-root>/plugins/installed.json`, preserving user plugin and MCP enable/disable state
- Writes targeted managed skills, concrete orbit instances, command workflows, and compiled agent role/workflow fallbacks into plugin `skills/<name>/SKILL.md`
- Emits canonical `tools/*.tool.ts` through Prism's canonical Streamable HTTP MCP bundle; generated tools use Kimi's plugin MCP runtime names with the `mcp__<server>__<tool>` qualification in role skills and hook matchers; omitted manifest ports let Prism select the managed daemon port before config write
- Emits hook wrappers under plugin `hooks/` and patches `<kimi-root>/config.toml` with managed `[[hooks]]` entries using Kimi hook event names
- Keeps project scope unsupported because official Kimi plugin installs are user-scoped
- Does not currently mix project-local `.kimi-code/skills/` or `.kimi-code/mcp.json` with generated plugin bundles

#### Cursor

- Emits canonical `tools/*.tool.ts` as a generated MCP server
- Patches `<cursor-root>/mcp.json` with one compiler-owned `mcpServers.prism-generated-<source-plugin>` entry
- Uses Streamable HTTP `url`/`headers` for generated MCP, matching Cursor's IDE and CLI MCP contract; omitted manifest ports let Prism select the managed daemon port before config write
- Supports global `~/.cursor/mcp.json` and project `.cursor/mcp.json`
- Installs command artifacts through generated local Cursor plugins under `<cursor-root>/plugins/local/prism-generated-<source-plugin>/commands/`
- Keeps install-phase skills direct because Cursor documents Agent Skills under `.cursor/skills/` and `~/.cursor/skills/`
- Fails closed for compiled agents, orbits, hooks, and per-agent skill permission visibility

#### Pi

- Writes one generated package per compiled source plugin under `<pi-settings-root>/packages/prism-generated-<source-plugin>/`
- Patches `<pi-settings-root>/settings.json` with a compiler-owned `packages` entry pointing at `./packages/prism-generated-<source-plugin>`
- Writes compiled agents as pi-agents markdown at `~/.pi/agents/<name>.md` globally and `.pi/agents/<name>.md` for project scope
- Writes targeted managed skills and concrete orbit instances into package `skills/<name>/SKILL.md`
- Writes install-phase command markdown as Pi prompt templates under package `prompts/`
- Injects targeted rules/context through package `extensions/prism-extension.js` using Pi's extension event API
- Emits canonical `tools/*.tool.ts` through the same generated Pi extension using `registerTool`
- Emits hook wrappers under package `hooks/` and wires them to Pi extension events
- Does not emit MCP config because generated Pi tools use native extension APIs rather than MCP

Compile is **idempotent**: re-running with unchanged sources produces no writes.

Orbit source artifacts are source-language constructs. For the current supported targets, concrete orbit instances lower into harness-intelligible skills at `skills/<orbit-name>/SKILL.md`; prism does not emit generic target-side `orbits/` folders. A future harness may add a native orbit surface, but that would be a target-specific capability rather than the default output shape.

### Compile cache and lockfile

- Successful non-dry-run compiles write a plugin-local cache under `<plugin>/dist/.prism-cache/`
- Each compiled agent cache entry is keyed by `sha256(source-fingerprint + target + scope)`
- The source fingerprint includes the agent source plus the referenced identity, personality, trait bindings, and toolspace/modelspace sources that affect composition for that agent
- Cache hits skip agent resolution/composition and reuse the serialized `ComposedAgent`; cache misses rebuild only that agent
- Successful non-dry-run compiles also write `<plugin>/prism.lock`

### Adding a new target

1. Add a lowerer module under `src/compile/lowerers/`
2. Wire it into `src/compile/pipeline.ts`
3. Declare the harness surface contract in `src/lowerer-capabilities.ts`, including compile target capabilities and whether the lowerer uses native plugin APIs, native plugin bundles, generated MCP, direct files, config patches, or unsupported surfaces
4. Ensure canonical toolspace/modelspace bindings have a corresponding `targets.<id>` block for the new harness

### Refresh + compile unified

`prism refresh <plugin>` runs compile first (if the plugin has compile-phase targets for that harness) and then reconciles file-router artifacts.

`prism refresh --plugins <directory>` applies the same compile-first behavior to each discovered child plugin and honors the same `--scope` / `--project` compile options.

For project-local OpenCode compilation via the unified command:

```bash
prism refresh ./my-plugin --harness opencode --scope project --project ~/code/my-app
prism refresh --plugins ./plugins --harness opencode,claude-code --scope project --project ~/code/my-app
```

Reserved for future:

- Git / HTTP URL deps (currently local paths only)
- richer permission/access ownership after the next glyph
- orbit runtime orchestration (heartbeat manager stays runtime state in opencode-config)

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
├── skills/             # Shared skills (including OpenClaw and Hermes shared skill files)
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
    "commands": ["claude-code", "opencode", "codex-cli", "cursor", "factory-droid"],
    "agents": ["claude-code", "opencode", "factory-droid"],
    "skills": ["coding-harness", "claw-harness"],
    "skillspaces": ["opencode", "claude-code", "grok"]
  }
}
```

### Preset groups

- `coding-harness` → `claude-code`, `opencode`, `codex-cli`, `antigravity-cli`, `kimi-code`, `amp-code`, `cursor`, `factory-droid`, `pi`, `grok`
- `claw-harness` → `openclaw`, `hermes`

Preset expansion is artifact-aware. For example, `coding-harness` includes Grok for rules, skills, and supported compile surfaces, but not install-phase commands because Grok commands are not managed by Prism. Claude Code, Cursor, Amp Code, Kimi Code, and Pi remain command targets, but Prism lowers those commands through each harness's generated plugin/package/API surface instead of direct command files. Factory Droid remains included for install-phase commands because Droid exposes `.factory/commands/` files.

### Rules to remember

- `plugin.json` is the only targeting source for install planning.
- There are no file-level targets for rules, commands, agents, or skills.
- Preset-expanded install targets are filtered by artifact capability; direct unsupported harness IDs still fail validation.
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

For Hermes, both the shared skill tree and any matching `harness/hermes/skills/...` replacements are materialized into the same `~/.hermes/skills/` destination. Compile-phase tools additionally materialize as generated MCP servers and `config.yaml` entries.

## Command Arguments

Custom commands support argument placeholders to accept user input:

### Placeholder Syntax

| Placeholder | Description |
|-------------|-------------|
| `$ARGUMENTS` | The entire raw argument string |

**Note:** For maximum cross-agent compatibility, it is highly recommended to design commands to take a single argument string using `$ARGUMENTS`.

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
- Use `exitWith()` for fatal CLI exits

### Sync Logic

- Build `DesiredRoot` values first
- Plan through `planSync()` and write only through `applySync()`
- Return structured refresh or compile results
- Support dry-run mode at all stages

### Adding New Harnesses

1. Add the harness ID to `HarnessId` in `types.ts`
2. Add the harness config to the `HARNESSES` registry in `harnesses.ts`
3. Add harness-specific file-router transformations in `refresh.ts` if needed
4. Update frontmatter type in `types.ts`

### Adding New Artifact Types

1. Add the artifact source model and manifest target support
2. Add support flag to `HarnessConfig` (e.g., `supportsX`)
3. Add directory field to `HarnessConfig` (e.g., `xDir`)
4. Create the corresponding desired-state planning in `refresh.ts` or a compile lowerer
5. Route writes through the sync engine
6. Update `init` command to generate examples

### Workflow Architecture Boundary

Before changing Prism workflows, read `docs/workflows/14-architecture-boundaries.md`.

- Workflows consume installed/compiled Prism truth: compile manifests, installed harness artifacts, snapshots, and generated refs.
- Compiler/install is the only layer that reads plugin source, resolves dependencies, composes traits, and lowers artifacts.
- Workflow runtime and generated refs must not import plugin source trees, scan `prism-plugins`, or expose plugin source file paths when hashes/manifests suffice.
- Prism core has no default orbit or business ontology. Forge, Tower, Glyphs, Booth, Quasar, Beacon, Scribe, Atelier, and similar concepts are userland plugin vocabulary unless they appear only as explicit fixtures/examples.
- Resource claims, file-edit semaphores, proposal-layer editing, Git/worktree policy, and domain-specific side-effect rules are plugin/service concerns, not Prism workflow core by default.

## Development Workflow

1. Make changes to `src/` files
2. Run `bun run typecheck` to verify types
3. Test with `bun run dev -- <command>`
4. Build with `bun run build`
5. Reinstall dev binary with `bun run install:dev` when dist/ layout changes

## Testing Changes

```bash
# Create test plugin
prism init test-plugin --with-agent --with-skill

# Validate
prism validate ./test-plugin

# Dry run to preview
prism plan ./test-plugin --all

# Install for real
prism refresh ./test-plugin --all
```

## Creating Skills

Skills extend agent capabilities with specialized knowledge, workflows, and tools. They transform agents from general-purpose into specialized assistants with procedural knowledge.

**Supported by:** Claude Code (native), OpenCode (native), OpenClaw (skills root with shared files plus matching `harness/openclaw` overlays), Hermes (skills root with shared files plus matching `harness/hermes` overlays)

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
3. **Initialize** - `prism init my-plugin --with-skill`
4. **Write** - Complete SKILL.md and resources
5. **Validate** - `prism validate ./my-plugin`
6. **Iterate** - Test and improve based on real usage

### Validation Rules

- `name`: kebab-case, lowercase + digits + hyphens, max 64 chars
- `description`: max 1024 chars, no angle brackets `< >`
- `compatibility`: optional string, max 500 chars
- SKILL.md body: recommended max 500 lines

See `plugins/skill-creator/` for the complete skill creation guide with design patterns.
