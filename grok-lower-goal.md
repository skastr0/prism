# Goal: Add a First-Class Grok Lowerer to Prism

Date: 2026-05-15
Status: approved for implementation
Target harness id: `grok`

## Receipt

No blocking questions remain before implementation.

This plan replaces the initial "copy Claude lowerer and patch config.toml" approach with a safer MVP:

- Treat Grok as a peer target, not an alias for `claude-code`.
- Emit a native Grok plugin bundle under `.grok/plugins/prism-generated-*`.
- Reuse Claude-compatible plugin layout where Grok explicitly supports it.
- Do not patch `config.toml` in PR1 unless a smoke test proves plugin `.mcp.json` is insufficient.
- PR1 did not add Grok to the `coding-harness` preset because Grok's native user command directory was not documented yet; PR2 adds it with artifact-aware preset filtering.
- Use Effect where Prism already uses it: compile validation, hook matching, generated wrapper decoding, and runtime boundaries. Do not refactor lowerers into full Effect services as part of this change.

## Forge Glyphs

These glyphs track the implementation slices for this goal. Glyph IDs are routing labels only and must not appear in production source, tests, fixture data, generated contracts, or public runtime surfaces.

### GLYPH-GROK-01: Goal and Work Tracking

Status: done

Intent:

- Preserve the reviewed implementation plan as a durable goal artifact.
- Record Forge glyph boundaries before code changes begin.
- Establish commit and review cadence.

Scope:

- `grok-lower-goal.md`

Acceptance:

- Goal file exists at repo root.
- Decisions from the Grok plan review are captured.
- Glyph sequence is explicit enough to drive implementation.
- No code behavior changes.

Validation:

- Manual readback of `grok-lower-goal.md`.
- Git diff is docs-only.

Review dispatch:

- `grok --agent reviewer` reviewed commit `fe05b40`.
- Finding: low duplicate `Claude.md` entry in the Grok `alternativeRulesFiles` example.
- Resolution: duplicate removed from this file and from the actual harness registration during GLYPH-GROK-02.

### GLYPH-GROK-02: Core Grok Compile Target

Status: done

Intent:

- Add `grok` as a first-class Prism compile target with native `.grok` output.
- Implement the Grok lowerer, using Grok-safe plugin, MCP, hook, skill, and agent rendering.
- Preserve Prism lowerer conventions and Effect boundary usage.

Scope:

- `src/types.ts`
- `src/harnesses.ts`
- `src/manifest.ts`
- `src/compile/target-capabilities.ts`
- `src/compile/pipeline.ts`
- `src/compile/lowerers/grok.ts`
- `src/compile/grok-lowerer.test.ts`
- targeted pipeline tests if required

Acceptance:

- `grok` is a valid harness id.
- `grok` is compile-supported.
- `prism compile <plugin> --harness grok --dry-run` reaches the Grok lowerer.
- Generated output is rooted under `.grok/plugins/prism-generated-*`.
- Generated plugin emits agents, skills, orbit skills, hooks, and MCP bundle files.
- Hook wrappers normalize Grok payloads and emit Grok-native deny JSON for blocking decisions.
- Claude-specific MCP permission names are not blindly used in Grok agent frontmatter.
- Commands remain out of scope until Grok command discovery is verified.
- `config.toml` is not patched in PR1.
- `coding-harness` preset was not expanded to include Grok in PR1; PR2 adds it with artifact-aware filtering.
- Typecheck and relevant tests pass.

Validation:

- `bun test src/compile/grok-lowerer.test.ts` passed.
- `bun test src/compile/pipeline.test.ts -t "Grok plugin-bundle"` passed.
- `bun run typecheck` passed.
- `bun run build` passed.
- `quartz diagnostics '{"root":"/Users/guilhermecastro/Projects/prism","explain":true}' --format pretty` reported zero TypeScript diagnostics.
- `quartz file '{"file":"src/compile/lowerers/grok.ts"}' --format pretty` resolved the exported lowerer contract as `planLowering(input) => Promise<LowerOperation[]>` and `executeLowering(...) => Promise<{ backups: string[] }>`.
- `pulsar score --category generated-slop .` reported existing/new lowerer duplication pressure; accepted for PR1 because the Grok lowerer intentionally mirrors Claude-compatible bundle behavior and shared extraction is tracked as Phase 4.
- `pulsar score --category legibility-decay .` reported pre-existing large-function outliers outside this Grok slice.
- Full `bun test src/compile/pipeline.test.ts` currently has one unrelated OpenCode session-hook expectation failure on `"session.created"` versus the existing `session.status` event mapping; the Grok pipeline test passes.

Review dispatch:

- `grok --agent requirements-tracer` reviewed commit `5c02014` and returned verdict `pass`.
- `grok --agent contract-reviewer` reviewed commit `5c02014` and returned verdict `pass`.
- Requirements-tracer low findings:
  - Compile CLI `--harness` help text did not list `grok`; fixed during GLYPH-GROK-03.
  - Live generated-plugin runtime smoke with `grok inspect --json` remains optional/future because PR1 already validates emitted operations and `grok inspect --json` was only required as a smoke path when practical.
  - Install-phase Grok rules/skills are enabled by harness registration; documented during GLYPH-GROK-03.
- Contract-reviewer noted lowerer input looseness matching the existing Claude lowerer pattern; accepted as pre-existing/tolerated interface shape.

### GLYPH-GROK-03: Documentation and Final Audit

Status: done

Intent:

- Update user-facing Prism docs to describe Grok support accurately.
- Complete the objective audit against code, tests, docs, commits, and reviewer output.

Scope:

- `AGENTS.md`
- `README.md` if it duplicates the supported harness table or compile target docs
- `docs/skillspaces.md`
- final validation notes in `grok-lower-goal.md` if needed

Acceptance:

- Supported harness documentation includes Grok.
- Docs state that PR2 adds Grok to `coding-harness` with artifact-aware preset filtering.
- Docs state install-phase commands are deferred until native command roots are verified.
- Docs state generated Grok compile output is plugin-bundled under `.grok/plugins/prism-generated-*`.
- Completion audit maps each explicit requirement to evidence.

Validation:

- Documentation readback via `rg -n "Grok Build|grok" AGENTS.md docs/skillspaces.md grok-lower-goal.md`.
- `git diff --check` passed.
- Public CLI smoke `bun run dev -- compile <temp-plugin> --harness grok --scope project --project <temp-project> --dry-run` passed and emitted operations under `<temp-project>/.grok/plugins/prism-generated-grok-cli-smoke/`.
- `bun test src/compile/grok-lowerer.test.ts src/compile/pipeline.test.ts -t "grok|Grok"` passed after the CLI help fix.
- `bun run typecheck` passed after docs edits.
- `bun run build` passed after the CLI help fix.
- `quartz diagnostics '{"root":"/Users/guilhermecastro/Projects/prism","explain":true}' --format pretty` reported zero TypeScript diagnostics after docs edits.
- `grok inspect --json` ran successfully in the Prism repo and confirmed local Grok `0.1.210` inspection works; it was not run against a generated Prism fixture because the dry-run smoke intentionally performs no writes.
- `pulsar score --category generated-slop .` hard-failed on existing generated-slop debt:
  - `src/compile/lowerers/amp-code.ts:350` existing Amp hook `throw-not-implemented`.
  - repo-wide lowerer duplication, including intentionally mirrored Claude/Grok helpers tracked for Phase 4 extraction.
- `pulsar score --signal TS-SL-04-unfinished-implementations .` isolated the hard gate to the existing Amp hook stub.
- `pulsar score --signal TS-SL-01-duplication .` confirmed the Grok-specific duplication is helper-level mirroring with Claude (`renderOrbitSkill`, `planPruning`, `matcherForHook`), accepted for PR1.
- Final objective checklist completed.

Completion audit:

- First-class harness id: satisfied by `src/types.ts`, `src/harnesses.ts`, `src/manifest.ts`, `src/compile/target-capabilities.ts`, and `src/compile/pipeline.ts`.
- Dedicated Grok lowerer: satisfied by `src/compile/lowerers/grok.ts`.
- Native `.grok` output: satisfied by generated plugin root `<grok-root>/plugins/prism-generated-<source-plugin>/`.
- Agents/skills/orbits/hooks/MCP bundle: satisfied by lowerer planning and `src/compile/grok-lowerer.test.ts`.
- Pipeline integration: satisfied by `src/compile/pipeline.test.ts` `compilePluginForTarget lowers Grok plugin-bundle surfaces`.
- Command/config restraint: PR1 was satisfied by `supportsCommands: false` and no `coding-harness` expansion; PR2 keeps `supportsCommands: false` and filters unsupported command preset members.
- Code quality gates: TypeScript and Quartz clean; Pulsar residual debt documented above.

Review dispatch:

- `grok --agent requirements-tracer` reviewed commit `85727bc` and returned verdict `pass`.
- `grok --agent reviewer` reviewed commit `85727bc` and returned `request_changes` for two stale Claude capability claims in docs touched by this glyph.
- Resolution: corrected `AGENTS.md` to state Claude Code emits generated plugin bundles with bundled MCP servers, and corrected `docs/skillspaces.md` to state Claude Code and Grok emit resolved skill names into generated agent frontmatter.

## Verified Grok Facts

Sources checked:

- `grok --help`
- `grok agent --help`
- `grok mcp add --help`
- `grok inspect --json`
- Official docs:
  - https://x.ai/news/grok-build-cli
  - https://docs.x.ai/build/overview
  - https://docs.x.ai/build/cli/headless-scripting
  - https://docs.x.ai/build/modes-and-commands
  - https://docs.x.ai/build/features/skills-plugins-marketplaces
- Local installed Grok docs under `~/.grok/docs/user-guide/`

Observed local CLI version:

- `grokVersion`: `0.1.210`

Grok supports:

- Interactive TUI.
- Headless mode through `grok -p`.
- ACP through `grok agent stdio`.
- Agent profiles through markdown files with YAML frontmatter.
- User and project skills.
- User and project plugins.
- Plugin-bundled skills, agents, hooks, MCP servers, and LSP servers.
- Hooks with Claude-compatible event names such as `PreToolUse`, `PostToolUse`, `SessionStart`, and `SessionEnd`.
- Native MCP config through `[mcp_servers.<name>]` in `~/.grok/config.toml` or project `.grok/config.toml`.
- Claude Code compatibility for `.claude/plugins`, plugin components, `.mcp.json`, hooks, agents, skills, and project instruction files.
- AGENTS.md compatibility for `Agents.md`, `Claude.md`, `AGENT.md`, and `AGENTS.md`.

Important details:

- `grok mcp add prism-test --command bun --args /tmp/server.mjs` writes:

  ```toml
  [mcp_servers.prism-test]
  command = "bun"
  args = ["/tmp/server.mjs"]
  enabled = true
  ```

- Grok plugin docs say a plugin directory can contain:
  - `skills/`
  - `agents/`
  - `hooks/hooks.json`
  - `.mcp.json`
  - `.lsp.json`

- Grok hook docs say hook commands can be absolute or relative to the hook JSON file.

- Grok MCP docs say MCP tools are namespaced as `<server>__<tool>`, for example `filesystem__read_file`.

## Strategic Decision

Add `grok` as a first-class compile target with a dedicated lowerer.

Do not implement Grok as an alias or automatic delegation to the Claude lowerer. Grok can consume Claude-compatible artifacts, but Prism needs a dedicated target because:

- Native output root is `.grok/`, not `.claude/`.
- Hook payload/output semantics differ enough to deserve a Grok wrapper.
- Grok frontmatter supports native fields such as `prompt_mode`, `permission_mode`, `agents_md`, `tools`, and `disallowedTools`.
- Grok MCP tool naming differs from Claude's `mcp__...` permission naming.
- Future Grok behavior can evolve without coupling to Claude Code output.

## PR1 Scope

Deliver a minimal, working Grok compile target.

Included:

- Add `grok` to core harness types and registry.
- Add `grok` to compile-supported targets.
- Add `grok` target capabilities.
- Add pipeline import and lowerer dispatch.
- Add `src/compile/lowerers/grok.ts`.
- Add `src/compile/grok-lowerer.test.ts`.
- Update `AGENTS.md` and user-facing docs.
- Emit plugin bundle under `<grok-root>/plugins/prism-generated-<source-plugin>/`.
- Emit agents as Grok-compatible markdown under the generated plugin.
- Emit managed skills and derived orbit skills under the generated plugin.
- Emit plugin `.mcp.json`.
- Emit plugin `hooks/hooks.json` and bundled hook wrappers.
- Add a smoke test path using `grok inspect --json` when the `grok` binary is present.

Excluded from PR1:

- Install-phase or plugin-bundled Grok commands.
- Managed `~/.grok/config.toml` patching.
- Marketplace source injection.
- Native Grok marketplace publishing.
- A dedicated `prism grok` CLI command.
- Install-phase Grok command support.
- Refactoring Claude and Grok shared lowerer helpers.

## Why `coding-harness` Was Deferred In PR1

The initial plan proposed adding `grok` to the `coding-harness` preset immediately.

PR2 now does this with artifact-aware preset filtering.

Reason:

- `coding-harness` is used for install-phase artifacts as well as compile-phase artifacts.
- Grok supports project/user rules through `AGENTS.md`, so rules can be represented.
- Grok native user commands are not documented as `~/.grok/commands/`.
- Existing manifests using `targets.commands: ["coding-harness"]` would either become invalid if Grok commands are unsupported or start writing to an unverified path if `commandsDir: "commands/"` is guessed.

PR1 required explicit Grok targeting:

```json
{
  "targets": {
    "agents": ["grok"],
    "tools": ["grok"],
    "toolspaces": ["grok"],
    "modelspaces": ["grok"],
    "skills": ["grok"],
    "hooks": ["grok"]
  }
}
```

The follow-up adds `grok` to `coding-harness` while keeping install-phase Grok commands unsupported. `targets.commands: ["coding-harness"]` remains valid because preset-expanded unsupported command targets are filtered out; direct `targets.commands: ["grok"]` remains invalid.

## Harness Registration

### `src/types.ts`

Add `grok` to `HarnessId`:

```ts
export type HarnessId =
  | "claude-code"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "codex-cli"
  | "gemini-cli"
  | "amp-code"
  | "cursor"
  | "factory-droid"
  | "grok";
```

Add a loose Grok frontmatter override type to `UnifiedFrontmatter`:

```ts
grok?: Record<string, unknown>;
```

Do not over-model Grok frontmatter in PR1. We only need to prevent `grok:` override blocks from leaking into base frontmatter and reserve space for future typed keys.

### `src/harnesses.ts`

Add:

```ts
grok: {
  id: "grok",
  name: "Grok Build",
  globalConfigPath: "~/.grok/",
  projectConfigPath: ".grok/",
  rulesFile: "AGENTS.md",
  rulesDir: null,
  commandsDir: null,
  agentsDir: "agents/",
  toolsDir: null,
  skillsDir: "skills/",
  configFile: "config.toml",
  configFormat: "toml",
  supportsTools: true,
  supportsCommands: false,
  supportsAgents: true,
  supportsSkills: true,
  supportsMCP: true,
  alternativeRulesFiles: [
    "Agents.md",
    "Claude.md",
    "AGENT.md",
    "CLAUDE.md",
    "CLAUDE.local.md"
  ],
},
```

Notes:

- `rulesFile` must be `AGENTS.md`, not `null`, because Grok has a real rules surface.
- `supportsCommands` stays `false` for install-phase commands until the native command directory is documented or verified.
- Compile lowerer can still bundle command files inside generated plugins if confirmed by `grok inspect` or a direct TUI check.
- `agentsDir` is set for registry completeness even though install-phase source markdown agents are currently a no-op in Prism.

### `src/manifest.ts`

Add `grok` to `COMPILE_SUPPORTED_HARNESSES`.

Add `grok` to `TARGET_PRESETS["coding-harness"]` in PR2, paired with artifact-aware preset filtering so unsupported install-phase command targets do not poison the preset.

Add `grok` to the `harnessKeys` list in `getHarnessFrontmatter` so harness-specific `grok:` blocks are removed from the base frontmatter before reconstruction.

### `src/compile/target-capabilities.ts`

Add:

```ts
grok: {
  generatedCanonicalTools: "executable",
  skillPermissions: "supported",
},
```

This is valid only if PR1 smoke validation proves plugin `.mcp.json` is discovered and executable. If that fails, downgrade `generatedCanonicalTools` to `unsupported` until the MCP path is fixed.

### `src/compile/pipeline.ts`

Import Grok lowerer functions:

```ts
import {
  executeLowering as executeGrokLowering,
  planLowering as planGrokLowering,
} from "./lowerers/grok.js";
```

Add `grok` to `SUPPORTED_TARGETS`.

Add `getLowerer` case:

```ts
case "grok":
  return {
    planLowering: planGrokLowering,
    executeLowering: executeGrokLowering,
  };
```

## Grok Lowerer Design

File:

- `src/compile/lowerers/grok.ts`

Start from `src/compile/lowerers/claude-code.ts`, but do not make a blind copy.

### Target Constants

```ts
const TARGET_ID = "grok" as const;
const GENERATED_PLUGIN_PREFIX = "prism-generated";
```

Generated root:

```ts
const generatedPluginRoot = (target: GrokLowerTarget): string =>
  join(target.root, "plugins", generatedPluginId(target));
```

### Plugin Manifest

Emit Claude-compatible plugin metadata:

```text
.claude-plugin/plugin.json
```

Reason:

- Grok local docs state Claude Code plugins are discovered and used at runtime.
- Existing Claude-compatible plugin manifests are recognized by `grok inspect --json`.

Do not invent a Grok-specific plugin manifest in PR1.

### Agent Markdown

Emit:

```text
agents/<agent-name>.md
```

Use YAML frontmatter plus body.

Grok frontmatter should be based on Claude's renderer but adjusted:

- Use `agent.targetOverride.grok` first.
- Fall back to `agent.model`.
- Include `name`.
- Include `description`.
- Include `model` if available.
- Include `effort` or `reasoning_effort` only after confirming which key Grok reads for agent markdown. Built-in Grok agents use `permission_mode`, `prompt_mode`, and `agents_md`.
- Include `tools` and `disallowedTools` only when we have a defensible mapping.
- Include `skills` if existing plugin skills are rendered as recommended skills.

Important:

- Do not reuse Claude's `mcp__${pluginId}__${tool}` permission names for Grok without validation.
- Grok docs say MCP tools are named `<server>__<tool>`.
- If tool filtering is uncertain, omit generated MCP tool names from `tools` in PR1 and rely on the plugin MCP server being available through Grok's tool discovery.
- Native built-in tool mappings should use Grok's tool IDs, not Claude display names. Examples from local docs include `read_file`, `grep_search`, `list_dir`, and `run_terminal_cmd`.

### Skills and Orbits

Emit managed skills:

```text
skills/<skill-name>/SKILL.md
```

Emit concrete orbit instances as derived skills:

```text
skills/<orbit-name>/SKILL.md
skills/<orbit-name>/references/*.md
```

Keep the same owner marker pattern as other lowerers:

```html
<!-- prism:orbit-skill owner="source-plugin" -->
```

### MCP Bundle

Emit:

```text
mcp/prism_generated_<source-plugin>/server.mjs
.mcp.json
```

Use `generateMcpServerBundle`.

The `.mcp.json` should reference the generated server in a way Grok can resolve from inside the plugin bundle.

Preferred PR1 options, in order:

1. Relative path if Grok plugin `.mcp.json` resolves paths relative to plugin root.
2. Absolute path to generated `server.mjs`.
3. Grok-supported plugin-root environment variable, if documented or verified.

Do not assume `${CLAUDE_PLUGIN_ROOT}` works inside native `.grok/plugins`.

If absolute paths are used, they are acceptable for PR1 because Prism-generated local plugin bundles are machine-local outputs. The generated files are not intended to be portable source artifacts.

### Hooks

Emit:

```text
hooks/hooks.json
hooks/<hook-name>.mjs
```

Use Grok-compatible event names:

- `tool.before` -> `PreToolUse`
- `tool.after` -> `PostToolUse`
- `session.start` -> `SessionStart`
- `session.end` -> `SessionEnd`

Implement a Grok wrapper instead of reusing the Claude wrapper verbatim.

Wrapper requirements:

- Use `Effect` for runtime decode/encode through existing hook runtime helpers.
- Normalize native Grok payload fields:
  - `hookEventName`
  - `sessionId`
  - `cwd`
  - `workspaceRoot`
  - `toolName`
  - `toolInput`
  - `timestamp`
- Set normalized target:

  ```ts
  { harness: "grok", nativeEvent: "PreToolUse" }
  ```

- For `tool.before` block results, emit Grok-native denial JSON to stdout:

  ```json
  { "decision": "deny", "reason": "message" }
  ```

- Exit with code `2` for explicit denial.
- For allow/continue, emit either nothing or:

  ```json
  { "decision": "allow" }
  ```

  Use whichever behavior local Grok hook docs and smoke testing show is most stable.

Do not write block messages only to stderr. Grok docs say explicit deny JSON is the reliable blocking contract.

### Commands

Install-phase commands are not in PR1.

Plugin-bundled commands are a follow-up. Grok local README says Claude Code plugins can provide `commands/`, but the concise user-guide page does not document native command roots, and Prism's harness registry keeps `supportsCommands: false` for Grok in PR1. Do not copy `commands/*.md` in the Grok lowerer until discovery is verified by `grok inspect --json` or a direct TUI command-palette check.

### Pruning

Reuse the Claude lowerer pruning model:

- Track desired plugin-relative paths.
- List existing files in generated plugin root.
- Emit `prune-plugin-path` for stale files.

Only prune inside:

```text
<grok-root>/plugins/prism-generated-<source-plugin>/
```

Never prune user-authored `.grok` files.

### Execution

Reuse the existing lowerer execution pattern:

- `write-md`
- `write-plugin-file`
- `prune-plugin-path`
- `backupFile` only for `write-md` when `--backup` is set
- skip writes with reason `unchanged`

Use `fs.ts` helpers:

- `exists`
- `readFile`
- `writeFile`
- `backupFile`
- `listDirRecursive`
- `removeDir`
- `removeFile`

Do not use raw Node file operations except the same temporary build pattern already used by Claude/Codex hook wrapper bundling.

## Effect Usage

The implementation should use Effect in the way Prism already does.

Do:

- Continue using `Effect.runPromise(resolveHookMatchForTarget(...))` inside lowerer planning.
- Use `Effect` in generated hook wrappers for:
  - decoding native hook payloads
  - invoking effectful hook handlers
  - decoding hook results
- Keep generated wrappers compatible with `effectBundleImportPath()`.
- Use typed recoverable validation errors where the surrounding compile pipeline already models them.

Do not:

- Convert the entire lowerer to `Effect.gen` just for style.
- Add a new `Layer` or `ManagedRuntime` for a stateless lowerer.
- Call `Effect.provide(AppLayer)` repeatedly.
- Use `Effect.die` for recoverable lowerer or config issues.

Rule:

- The lowerer contract remains Promise-based because `pipeline.ts` expects `planLowering(...): Promise<LowerOperation[]>`.
- Effect belongs at the compile/runtime boundaries and inside generated adapters, not as a cross-cutting rewrite.

## Testing Plan

### Unit Test

Add:

```text
src/compile/grok-lowerer.test.ts
```

Mirror `src/compile/claude-code-lowerer.test.ts`, with Grok-specific assertions.

Test fixture should include:

- `plugin.json`
- one command file if command copying is implemented
- one skill
- one toolspace with a Grok native tool mapping
- one canonical tool
- hooks:
  - native tool matcher
  - canonical tool matcher
  - session end hook

Assertions:

- Plugin manifest target contains `.grok/plugins/prism-generated-<plugin>/.claude-plugin/plugin.json`.
- Agent markdown is emitted under `.grok/plugins/.../agents/<name>.md`.
- Agent markdown uses `targetOverride.grok`.
- Agent markdown does not contain Claude-specific diagnostics labels.
- Agent markdown does not blindly include `mcp__...` names unless validated.
- Skill is emitted under plugin `skills/`.
- Orbit skills and references are emitted when included.
- `.mcp.json` is emitted.
- MCP bundle is emitted and contains generated tool names.
- `hooks/hooks.json` contains `PreToolUse` and `SessionEnd`.
- Hook command paths are Grok-safe.
- Hook wrapper contains Grok target normalization.
- Hook wrapper emits or can emit deny JSON.
- Missing Grok target binding in hook matcher fails closed with a useful message.

### Optional CLI Smoke Test

Add a test or script that runs only when `grok` is available:

1. Create temp `HOME`.
2. Create temp project.
3. Compile a fixture plugin to Grok with `scope: "global"` using temp home.
4. Run:

   ```bash
   HOME=<temp-home> grok --cwd <temp-project> inspect --json
   ```

5. Assert generated plugin appears in `plugins`.
6. Assert `provides.agents`, `provides.skills`, `provides.hooks`, and `provides.mcpServers` match expected nonzero counts.

Do not make this required in the normal unit suite unless the test environment guarantees `grok` is installed and authenticated is not required for inspect.

### Pipeline Test

Extend `src/compile/pipeline.test.ts` with a basic `target: "grok"` compile scenario.

Assertions:

- Output root resolves to `.grok` for project scope.
- Unsupported target errors include `grok` in supported target lists.
- Managed skill refs can target Grok.
- Canonical tool compile path reaches the Grok lowerer.

### Verification Commands

Run:

```bash
bun test src/compile/grok-lowerer.test.ts
bun test src/compile/pipeline.test.ts -t "Grok plugin-bundle"
bun run typecheck
bun run build
quartz diagnostics '{"root":"/Users/guilhermecastro/Projects/prism","explain":true}' --format pretty
quartz file '{"file":"src/compile/lowerers/grok.ts"}' --format pretty
pulsar score --category generated-slop .
pulsar score --category legibility-decay .
```

If the full suite is cheap enough:

```bash
bun test
bun run verify
```

## Manual Validation

After implementation:

1. Create a temp plugin or use an existing fixture.
2. Add Grok targets explicitly.
3. Run:

   ```bash
   bun run dev -- compile <plugin-path> --harness grok --dry-run
   ```

4. Run without `--dry-run` against a temporary home if possible.
5. Run:

   ```bash
   HOME=<temp-home> grok --cwd <temp-project> inspect --json
   ```

6. Confirm:
   - generated plugin appears
   - agents are discovered
   - skills are discovered
   - hooks are discovered
   - MCP server is discovered
   - no duplicate MCP server appears from both `.mcp.json` and config.toml

## Documentation Updates

Update `AGENTS.md`:

- Supported harnesses table.
- Grok description in compile/lowerer sections.
- Explain that Grok compile output is plugin-bundled under `.grok/plugins/prism-generated-*`.
- Explain that Grok supports rules through `AGENTS.md`.
- Explain that install-phase commands are deferred until native command roots are verified.
- Explain that Grok is included in `coding-harness` through artifact-aware preset expansion.

Update `README.md` if it has the same supported harness table.

## Follow-Ups

### Phase 2: Preset and Commands

Grok is added to `coding-harness` with this outcome:

- Existing plugins using `targets.commands: ["coding-harness"]` remain valid.
- `supportsCommands` remains false until native command installation is documented or verified.

Possible outcomes:

- If `~/.grok/commands/` works, set `commandsDir: "commands/"` so Grok also receives install-phase command artifacts through the existing preset.
- If only `~/.agents/commands/` works, add a harness capability or installer special case instead of pretending it is under `.grok`.
- If only plugin-bundled commands work, keep install-phase commands unsupported but document compile/plugin command support.

### Phase 3: Native Grok Config

Add managed `config.toml` patching only for features not representable in plugin bundles.

If implemented, follow the Codex managed-block pattern:

```text
# --- prism grok begin: <plugin> ---
...
# --- prism grok end: <plugin> ---
```

But avoid duplicate MCP registration if plugin `.mcp.json` is already loaded.

### Phase 4: Shared Lowerer Helpers

After Grok and Claude behavior stabilizes, extract common helpers only where duplication is proven:

- plugin id normalization
- YAML frontmatter serialization
- derived orbit skill rendering
- plugin pruning
- MCP bundle planning with target-specific path rendering

Do not extract before Grok behavior is validated. The target-specific details are the risky part.

## Acceptance Criteria

- `prism compile <plugin> --harness grok --dry-run` succeeds for a plugin with agents, tools, hooks, skills, and orbits.
- Generated operations point only under the resolved Grok root.
- Generated plugin bundle is idempotent.
- Re-running compile with unchanged source produces `unchanged` write reasons where appropriate.
- Stale generated plugin files are pruned inside the generated plugin root only.
- Grok hook wrappers use Grok payload/output semantics.
- Generated canonical tools are executable through Grok plugin MCP or the capability is marked unsupported until fixed.
- No user-authored Grok config is overwritten outside planned generated files.
- Typecheck and build pass.
- Unit tests cover success and fail-closed hook target binding behavior.
- Documentation accurately states what is supported and what is deferred.
