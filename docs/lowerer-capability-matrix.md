# Lowerer Capability Matrix

Checked: 2026-07-22

Prism keeps two related contracts separate:

- `src/harnesses.ts` describes where each harness stores files.
- `src/lowerer-capabilities.ts` describes what kind of harness surface Prism uses.

This matters because "plugin" means different things per product. A generated Claude,
Grok, Factory, or Antigravity plugin bundle is not the same thing as an Amp or
OpenCode TypeScript plugin API, and neither is the same thing as the CLI tool
runtime under `PRISM_HOME/runtime/tools/`.

## Surface Kinds

| Kind | Meaning |
| --- | --- |
| `native-plugin-api` | Prism emits code for a harness runtime plugin API, such as OpenCode, Amp, or OMP TypeScript plugins. |
| `native-plugin-bundle` | Prism emits the product's plugin package layout, such as Claude Code, Antigravity, Grok, or Factory plugin bundles. |
| `markdown-file` | Prism emits generated markdown files consumed directly by the harness. |
| `direct-file` | Prism copies or appends install-phase files directly into harness roots (also used for the shared CLI tool runtime under `PRISM_HOME`). |
| `config-patch` | Prism patches a harness config file and owns only the generated block/table/section. |
| `unsupported` | Prism intentionally does not manage the surface. |

## Verification Tiers

| Tier | Meaning |
| --- | --- |
| `live-proven` | A registered worker adapter dispatched the harness live and a smoke fixture passed end to end. |
| `compile-verified` | The lowerer compiles and is maintained, but no live worker dispatch has been run against the harness. |
| `unsupported` | Prism intentionally does not manage the surface (reuses the Surface Kind of the same name). |

## Tools surface (CLI-only)

Prism no longer emits harness MCP config (`.mcp.json`, `mcp_config.json`,
`config.toml#mcp_servers`, `config.yaml#mcp_servers`, Cursor `mcp.json`, Kimi
`mcpServers`, etc.) and no longer registers generated MCP servers for harnesses.

Canonical tools lower to:

```text
<PRISM_HOME>/runtime/tools/<plugin>/runtime.mjs
<PRISM_HOME>/runtime/tools/<plugin>/catalog.json
```

Agents invoke them with:

```bash
prism tools invoke <plugin> <tool-name> --input '<json-object>'
```

Compile still marks `generatedCanonicalTools: "executable"` for harnesses that
own tools; the surface kind is `direct-file` (CLI runtime), not a harness MCP
wire. Harnesses with native plugin tool APIs (OpenCode, Amp, Pi, OMP) keep
`native-plugin-api` for in-process tools and still get CLI catalogs for
cross-plugin invoke.

The `mcpConfig` surface is `unsupported` on every harness.

## Matrix

| Harness | Plugin surface | Agents | Skills | Tools | Hooks | Config patches | Verification tier |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `native-plugin-bundle` via skills-dir plugin | plugin markdown | plugin skills | CLI runtime + skill inject | plugin hooks | none for generated bundle | `live-proven` |
| OpenCode | `native-plugin-api` | root markdown | root skills | native plugin tools | native plugin hooks | `opencode.json` agent/plugin entries | `live-proven` |
| OpenClaw | unsupported | unsupported | direct skills | unsupported | unsupported | none | `unsupported` |
| Hermes Agent | unsupported | unsupported | root/profile skills | CLI runtime | config hooks | none for tools | `live-proven` |
| Codex CLI | unsupported | root TOML files | root skills | CLI runtime + skill inject | `config.toml` hooks | none for tools | `live-proven` |
| Antigravity CLI | `native-plugin-bundle` | plugin agents | plugin skills | CLI runtime + skill inject | plugin hooks | none for tools | `live-proven` (live dispatch verified, smoke fixture pending) |
| Kimi Code | `native-plugin-bundle` + installed record | role-skill fallback | plugin skills | CLI runtime + skill inject | `config.toml` hooks | `plugins/installed.json`, `config.toml#hooks` | `live-proven` |
| Amp Code | `native-plugin-api` | generated role-skill fallback | root skills | native `registerTool` plugin tools and `registerCommand` commands | native `amp.on(...)` plugin events | none | `live-proven` |
| Cursor | `native-plugin-bundle` for commands | unsupported | direct skills | CLI runtime | unsupported | none for tools | `compile-verified` |
| Factory Droid | `native-plugin-bundle` | plugin droids | plugin skills when compiled, direct skills when skills-only | CLI runtime | plugin hooks | none for generated bundle | `compile-verified` |
| Pi | `native-plugin-bundle` | pi-agents markdown discovery | package skills | native `registerTool` extension tools | extension events + hook wrappers | `settings.json#packages` | `compile-verified` |
| Oh My Pi | `native-plugin-api` | native agent markdown | root skills | native `registerTool` extension tools | extension events + hook wrappers | none | `live-proven` (live dispatch verified, smoke fixture pending) |
| Grok Build | `native-plugin-bundle` | plugin agents | plugin skills | CLI runtime + skill inject | plugin hooks | none for tools | `live-proven` |
| Devin CLI | unsupported (plugins beta deferred) | unsupported (subagent AGENT.md later) | direct skills | unsupported (PR1) | project `hooks.v1.json` / global `config.json#hooks` members | none (never whole-file `config.json`) | `live-proven` |

Cursor and Factory Droid are closed at `compile-verified` outright, not pending a
future live worker: both lowerers are finished and maintained, no
`workflow-cursor-worker.ts` or `workflow-factory-droid-worker.ts` was ever
attempted in git history, and the workflow roadmap's ten named dispatch
targets do not include them. Building live workers for either would be an
unrequested detour, not a gap to close.

Gemini CLI is not a supported target. Antigravity CLI is the replacement target.
Active Antigravity outputs still live under Antigravity's official
`~/.gemini/antigravity-cli` home path.

Claude Code's documented local plugin autoload surface is a skills-directory
plugin: `~/.claude/skills/<plugin>/.claude-plugin/plugin.json` for personal
scope or `<cwd>/.claude/skills/<plugin>/.claude-plugin/plugin.json` for project
scope. Prism treats that as the canonical generated-local Claude surface and
does not write marketplace cache internals. Generated Claude bundles put
root-level `commands/`, `agents/`, `skills/`, and `hooks/` components under
`<claude-root>/skills/prism-generated-<plugin>/`. Claude plugins namespace skills
and flat Markdown commands as `/plugin-name:name`, so Prism treats
`targets.commands: ["claude-code"]` as compile-managed and does not write direct
`~/.claude/commands/` files. Canonical tools are not registered as Claude MCP
servers; they are CLI-invoked.

Official Antigravity CLI plugins are staged under
`~/.gemini/antigravity-cli/plugins/<plugin_name>/` with root `plugin.json`,
optional `hooks.json`, and optional `skills/`, `agents/`, and `rules/`
directories. Prism follows that native bundle shape for compiled rules, agents,
targeted skills, concrete orbit skills, and hooks. Antigravity skills surface as
slash commands, so Prism does not write a separate direct command-file surface;
unsupported direct `targets.commands: ["antigravity-cli"]` declarations fail
manifest validation instead of being silently dropped. Hook lowering is
Prism-hook-DSL lowering: Prism currently maps `tool.before`, `tool.after`,
`session.start`, and `session.end` to `PreToolUse`, `PostToolUse`,
`PreInvocation`, and `Stop`, preserves the full native Antigravity stdin payload
at `event.native`, and intentionally does not model Antigravity-only
`PostInvocation` outputs such as `injectSteps` or `terminationBehavior`.

Amp is product-native for generated commands, tools, and supported hooks through its
TypeScript plugin API. Prism emits generated plugins under Amp's documented
project/system plugin locations, uses `amp.registerCommand(...)` for Prism
markdown commands, `amp.registerTool(...)` for canonical tools, and
`amp.on(...)` for portable hooks. Generated commands append the Prism command
prompt to the active Amp thread through `ctx.thread?.append(...)`. Prism maps
`tool.before` to `tool.call`, `tool.after` to `tool.result`, and `session.start` to
`session.start`. It deliberately fails closed for `session.end` because Amp's
official plugin lifecycle has no session-end event; Prism does not map that to
turn-level `agent.end`. Prism does not yet lower compiled agents through a
native Amp custom-agent surface; it uses generated role skills for that part of
the compile output.

Kimi Code's current home is `~/.kimi-code`, and Prism targets that home
exclusively. Compile-phase Kimi output is a generated user-scoped plugin bundle under
`<kimi-root>/plugins/managed/prism-generated-<plugin>/` with `kimi.plugin.json`,
plus a managed `<kimi-root>/plugins/installed.json` record so Kimi loads the
plugin as an enabled user-scoped plugin.
Targeted skills, concrete orbit skills, command workflows, and compiled agents
lower as Kimi skills; compiled agents are role/workflow skills because official
Kimi has no headless agent/sub-agent file surface. The Prism workflow worker loads
the generated plugin's `skills/` directory via `--skills-dir` and runs the role
skill with `--prompt --output-format stream-json`. Kimi's prompt mode does not
allow `--yolo` or `--auto`, so tool-use automation is limited to what the model
can emit in a single prompt response; full headless tool execution requires Kimi
ACP server mode, which Prism does not yet implement.
Canonical tools lower through the CLI runtime (`prism tools invoke`), not
plugin-declared MCP servers. Hooks are not plugin manifest fields; Prism
patches managed `[[hooks]]` entries in `<kimi-root>/config.toml` and stores hook
wrappers in the generated plugin bundle. The current Moonshot-hosted Kimi Code
CLI docs also support project-local `.kimi-code/skills/` and
`.kimi-code/mcp.json`, but Prism's generated Kimi plugin lowerer keeps project
scope unsupported because Kimi plugin installs are user-scoped.

Pi uses generated local packages under `<pi-settings-root>/packages/prism-generated-<plugin>/`
and a managed `settings.json#packages` entry. Prism bundles targeted skills,
orbit skills, prompt-template commands, context injection, hooks, and canonical
tools into that package. Compiled agents lower to the pi-agents markdown discovery
surface: `~/.pi/agents/<name>.md` globally and `.pi/agents/<name>.md` for project
scope.

Oh My Pi is a separate target from Pi. Prism uses `~/.omp/agent/` globally and
`<project>/.omp/` for project scope, writes rules, commands, agents, and skills
to OMP's native discovery directories, and emits one generated TypeScript
extension per source plugin under `extensions/prism-generated-<plugin>/`.
Canonical tools call OMP's native `registerTool` API; supported hooks run through
the same extension and generated wrappers. No MCP config or Pi package/settings
surface is shared between the two targets.

Factory Droid compile output follows the documented plugin layout: only
`.factory-plugin/plugin.json` lives under `.factory-plugin/`, while generated
droids, skills, and hooks live at the plugin root. Factory rules and
commands remain install-phase direct-file artifacts, because Droid's native
plugin command surface is still a slash-command file surface rather than a
compile-owned canonical command model. When a generated Factory bundle contains
agents, tools, or hooks, Prism bundles targeted managed skills into that plugin
to avoid double-loading the same Prism-owned skill from `.factory/skills/`.
Permission-only skill visibility still fails closed because the official Droid
frontmatter documents `tools` but not a per-droid skill allowlist. Canonical
tools are CLI-invoked; Prism does not write plugin-local `mcp.json`.

Hermes profile-local tools use the existing root override rather than a new
target. Hermes profiles are separate Hermes homes, so
`prism refresh --plugin ./plugin --harness hermes --compile-only --compile-root ~/.hermes/profiles/<name>`
writes skills into that profile root. Tools are CLI-only under shared
`PRISM_HOME` (no per-profile MCP runtime). See historical Hermes profile docs for
collision/non-goal notes: Prism does not lower SOUL/personality files, runtime
delegation, or native Hermes Python plugins.

Cursor compile support is tools-only for catalog/runtime emission. Prism does
not patch Cursor `mcp.json`. Cursor documents local plugins under
`~/.cursor/plugins/local/<plugin>` with `.cursor-plugin/plugin.json` and default
`commands/` component discovery, so Prism installs Cursor command artifacts into
a generated local plugin bundle instead of direct `~/.cursor/commands/` files.
Cursor documents Agent Skills under `.cursor/skills/` and `~/.cursor/skills/`,
so Prism keeps Cursor skills as install-phase direct-file artifacts. Prism does
not compile Cursor agents, hooks, or per-agent skill permissions yet, and it
leaves Cursor's native approval flow intact.

## Source Pointers

- OpenCode plugins: https://opencode.ai/docs/plugins/
- Claude Code plugins and reference: https://code.claude.com/docs/en/plugins and https://code.claude.com/docs/en/plugins-reference
- Antigravity plugins, migration, and hooks: https://antigravity.google/docs/cli-plugins, https://antigravity.google/docs/gcli-migration, and https://www.antigravity.google/docs/hooks
- Kimi Code config, skills, plugins, MCP, agents/subagents, and hooks: https://moonshotai.github.io/kimi-code/en/configuration/config-files.html, https://moonshotai.github.io/kimi-code/en/customization/skills.html, https://moonshotai.github.io/kimi-code/en/customization/plugins.html, https://moonshotai.github.io/kimi-code/en/customization/mcp.html, https://moonshotai.github.io/kimi-code/en/customization/agents, and https://moonshotai.github.io/kimi-code/en/customization/hooks. Current Kimi Code CLI details live in the Moonshot-hosted docs rather than the older `www.kimi.com/code/docs/...` pages.
- Factory Droid plugins, custom droids, skills, hooks, and MCP: https://docs.factory.ai/cli/configuration/plugins, https://docs.factory.ai/cli/configuration/custom-droids, https://docs.factory.ai/cli/configuration/skills, https://docs.factory.ai/reference/hooks-reference, and https://docs.factory.ai/cli/configuration/mcp
- Amp plugins and plugin API: https://ampcode.com/manual and https://ampcode.com/manual/plugin-api
- Pi agents, extensions, SDK, skills, prompts, packages, and settings: https://pi.dev/packages/pi-agents, https://pi.dev/docs/latest/extensions, https://pi.dev/docs/latest/sdk, https://pi.dev/docs/latest/skills, https://pi.dev/docs/latest/prompt-templates, https://pi.dev/docs/latest/packages, and https://pi.dev/docs/latest/settings
- Hermes profiles, profile commands, MCP, and plugin surfaces: https://hermes-agent.nousresearch.com/docs/user-guide/profiles/, https://hermes-agent.nousresearch.com/docs/reference/profile-commands/, https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference/, and https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- OpenClaw skills: https://docs.openclaw.ai/tools/skills
- Factory plugin/settings hierarchy: https://docs.factory.ai/guides/building/building-plugins and https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control
- Grok Build skills/plugins: https://docs.x.ai/build/features/skills-plugins-marketplaces
- Cursor rules, skills, commands, plugins, and MCP: https://cursor.com/docs/rules, https://cursor.com/docs/skills, https://cursor.com/docs/cli/reference/slash-commands, https://cursor.com/docs/reference/plugins, and https://cursor.com/docs/mcp
- Codex public docs describe skills and plugins as reusable workflow/package surfaces, while Prism's Codex CLI config contract remains tracked from the local Codex configuration surface and current repo tests: https://developers.openai.com/codex/skills and https://developers.openai.com/codex/plugins
