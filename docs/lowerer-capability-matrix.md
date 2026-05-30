# Lowerer Capability Matrix

Checked: 2026-05-30

Prism keeps two related contracts separate:

- `src/harnesses.ts` describes where each harness stores files.
- `src/lowerer-capabilities.ts` describes what kind of harness surface Prism uses.

This matters because "plugin" means different things per product. A generated Claude,
Grok, Factory, or Antigravity plugin bundle is not the same thing as an Amp or
OpenCode TypeScript plugin API, and neither is the same thing as an MCP server
patched into a config file.

## Surface Kinds

| Kind | Meaning |
| --- | --- |
| `native-plugin-api` | Prism emits code for a harness runtime plugin API, such as OpenCode or Amp TypeScript plugins. |
| `native-plugin-bundle` | Prism emits the product's plugin package layout, such as Claude Code, Antigravity, Grok, or Factory plugin bundles. |
| `generated-mcp` | Prism emits a generated MCP server for canonical tools. |
| `markdown-file` | Prism emits generated markdown files consumed directly by the harness. |
| `direct-file` | Prism copies or appends install-phase files directly into harness roots. |
| `config-patch` | Prism patches a harness config file and owns only the generated block/table/section. |
| `unsupported` | Prism intentionally does not manage the surface. |

## Matrix

| Harness | Plugin surface | Agents | Skills | Tools | Hooks | Config patches |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `native-plugin-bundle` | plugin markdown | plugin skills | `generated-mcp` via `.mcp.json` | plugin hooks | none for generated bundle |
| OpenCode | `native-plugin-api` | root markdown | root skills | native plugin tools | native plugin hooks | `opencode.json` agent/plugin entries |
| OpenClaw | unsupported | unsupported | direct skills | unsupported | unsupported | none |
| Hermes Agent | unsupported | unsupported | root skills | `generated-mcp` | unsupported | `config.yaml#mcp_servers` |
| Codex CLI | unsupported | root TOML files | root skills | `generated-mcp` | `config.toml` hooks | `config.toml#mcp_servers` |
| Antigravity CLI | `native-plugin-bundle` | plugin agents | plugin skills | `generated-mcp` via plugin config | plugin hooks | plugin-local `mcp_config.json` |
| Kimi Code | `native-plugin-bundle` + installed record | role-skill fallback | plugin skills | `generated-mcp` via plugin manifest | `config.toml` hooks | `plugins/installed.json`, `config.toml#hooks` |
| Amp Code | `native-plugin-api` | generated role-skill fallback | root skills | native `registerTool` plugin tools | unsupported | none |
| Cursor | unsupported | unsupported | direct skills | unsupported | unsupported | none |
| Factory Droid | `native-plugin-bundle` | plugin droids | plugin skills when compiled, direct skills when skills-only | `generated-mcp` via plugin `mcp.json` | plugin hooks | none for generated bundle |
| Pi | `native-plugin-bundle` | root agent markdown | package skills | native `registerTool` extension tools | extension events + hook wrappers | `settings.json#packages` |
| Grok Build | `native-plugin-bundle` | plugin agents | plugin skills | `generated-mcp` via plugin `.mcp.json` | plugin hooks | none for generated bundle |

Gemini CLI is not a supported target. Antigravity CLI is the replacement target.
Active Antigravity outputs still live under Antigravity's official
`~/.gemini/antigravity-cli` home path, and Prism may prune legacy
`~/.gemini/extensions` outputs during Antigravity lowering so old Gemini
extension bundles do not linger.
Official Antigravity CLI plugins are staged under
`~/.gemini/antigravity-cli/plugins/<plugin_name>/` with root `plugin.json`,
optional `mcp_config.json`, optional `hooks.json`, and optional `skills/`,
`agents/`, and `rules/` directories. Prism follows that native bundle shape for
compiled rules, agents, targeted skills, concrete orbit skills, canonical-tool
MCP servers, and hooks. Antigravity skills surface as slash commands, so Prism
does not write a separate direct command-file surface; unsupported direct
`targets.commands: ["antigravity-cli"]` declarations fail manifest validation
instead of being silently dropped. Remote MCP entries use Antigravity's
documented `serverUrl` field, and hook wrappers emit Antigravity `PreToolUse`,
`PostToolUse`, and `Stop` output shapes. Hook lowering is Prism-hook-DSL
lowering, not a generic Antigravity hook authoring API: Prism currently maps
`tool.before`, `tool.after`, `session.start`, and `session.end` to
`PreToolUse`, `PostToolUse`, `PreInvocation`, and `Stop`, preserves the full
native Antigravity stdin payload at `event.native`, and intentionally does not
model Antigravity-only `PostInvocation` outputs such as `injectSteps` or
`terminationBehavior`.

Amp is product-native for generated tools through its TypeScript plugin API. Prism
does not yet lower compiled agents through a native Amp custom-agent surface; it
uses generated role skills for that part of the compile output.

Kimi Code's current home is `~/.kimi-code`; Prism does not preserve legacy
`~/.kimi` as a compatibility target. Compile-phase Kimi output is a generated
user-scoped plugin bundle under
`<kimi-root>/plugins/managed/prism-generated-<plugin>/` with `kimi.plugin.json`,
plus a managed `<kimi-root>/plugins/installed.json` record so Kimi loads the
plugin as an enabled user-scoped plugin.
Targeted skills, concrete orbit skills, command workflows, and compiled agents
lower as Kimi skills; compiled agents are role/workflow skills because official
Kimi subagents are runtime dispatches rather than persistent custom-agent files.
Canonical tools lower through plugin-declared MCP servers using Kimi's
plugin MCP runtime names and `mcp__<server>__<tool>` qualification. Hooks are not plugin manifest fields; Prism
patches managed `[[hooks]]` entries in `<kimi-root>/config.toml` and stores hook
wrappers in the generated plugin bundle.

Pi uses generated local packages under `<pi-root>/packages/prism-generated-<plugin>/`
and a managed `settings.json#packages` entry. Prism bundles targeted skills,
orbit skills, prompt-template commands, context injection, hooks, and canonical
tools into that package. Compiled agents lower to Pi's native
`<pi-root>/agents/<name>.md` markdown surface.

Factory Droid compile output follows the documented plugin layout: only
`.factory-plugin/plugin.json` lives under `.factory-plugin/`, while generated
droids, skills, hooks, and MCP config live at the plugin root. Factory rules and
commands remain install-phase direct-file artifacts, because Droid's native
plugin command surface is still a slash-command file surface rather than a
compile-owned canonical command model. When a generated Factory bundle contains
agents, tools, or hooks, Prism bundles targeted managed skills into that plugin
to avoid double-loading the same Prism-owned skill from `.factory/skills/`.
Permission-only skill visibility still fails closed because the official Droid
frontmatter documents `tools` but not a per-droid skill allowlist.

## Source Pointers

- OpenCode plugins: https://opencode.ai/docs/plugins/
- Claude Code plugins and reference: https://code.claude.com/docs/en/plugins and https://code.claude.com/docs/en/plugins-reference
- Antigravity plugins, migration, and hooks: https://antigravity.google/docs/cli-plugins, https://antigravity.google/docs/gcli-migration, and https://www.antigravity.google/docs/hooks
- Kimi Code config, skills, plugins, MCP, agents/subagents, and hooks: https://moonshotai.github.io/kimi-code/en/configuration/config-files.html, https://moonshotai.github.io/kimi-code/en/customization/skills.html, https://moonshotai.github.io/kimi-code/en/customization/plugins.html, https://moonshotai.github.io/kimi-code/en/customization/mcp.html, https://moonshotai.github.io/kimi-code/en/customization/agents, and https://moonshotai.github.io/kimi-code/en/customization/hooks
- Factory Droid plugins, custom droids, skills, hooks, and MCP: https://docs.factory.ai/cli/configuration/plugins, https://docs.factory.ai/cli/configuration/custom-droids, https://docs.factory.ai/cli/configuration/skills, https://docs.factory.ai/reference/hooks-reference, and https://docs.factory.ai/cli/configuration/mcp
- Amp plugin API: https://ampcode.com/manual/plugin-api
- Pi agents, extensions, SDK, skills, prompts, packages, and settings: https://pi.dev/packages/pi-agents, https://pi.dev/docs/latest/extensions, https://pi.dev/docs/latest/sdk, https://pi.dev/docs/latest/skills, https://pi.dev/docs/latest/prompt-templates, https://pi.dev/docs/latest/packages, and https://pi.dev/docs/latest/settings
- Hermes MCP and plugin surfaces: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp and https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- OpenClaw skills: https://docs.openclaw.ai/tools/skills
- Factory plugin/settings hierarchy: https://docs.factory.ai/guides/building/building-plugins and https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control
- Grok Build skills/plugins: https://docs.x.ai/build/features/skills-plugins-marketplaces
- Cursor rules and commands: https://docs.cursor.com/en/context and https://docs.cursor.com/en/agent/chat/commands
- Codex public use cases mention skills and plugins, but Prism's Codex CLI contract is primarily tracked from the local Codex configuration surface and current repo tests until fuller public CLI extension docs exist: https://developers.openai.com/codex/use-cases
