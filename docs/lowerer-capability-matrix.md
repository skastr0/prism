# Lowerer Capability Matrix

Checked: 2026-05-29

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
| Amp Code | `native-plugin-api` | generated role-skill fallback | root skills | native `registerTool` plugin tools | unsupported | none |
| Cursor | unsupported | unsupported | direct skills | unsupported | unsupported | none |
| Factory Droid | `native-plugin-bundle` | plugin droids | plugin skills when compiled, direct skills when skills-only | `generated-mcp` via plugin `mcp.json` | plugin hooks | none for generated bundle |
| Grok Build | `native-plugin-bundle` | plugin agents | plugin skills | `generated-mcp` via plugin `.mcp.json` | plugin hooks | none for generated bundle |

Gemini CLI is not a supported target. Antigravity CLI is the replacement target.
Active Antigravity outputs still live under Antigravity's official
`~/.gemini/antigravity-cli` home path, and Prism may prune legacy
`~/.gemini/extensions` outputs during Antigravity lowering so old Gemini
extension bundles do not linger.

Amp is product-native for generated tools through its TypeScript plugin API. Prism
does not yet lower compiled agents through a native Amp custom-agent surface; it
uses generated role skills for that part of the compile output.

## Source Pointers

- OpenCode plugins: https://opencode.ai/docs/plugins/
- Claude Code plugins and reference: https://code.claude.com/docs/en/plugins and https://code.claude.com/docs/en/plugins-reference
- Antigravity plugins and migration: https://antigravity.google/docs/cli-plugins and https://antigravity.google/docs/gcli-migration
- Amp plugin API: https://ampcode.com/manual/plugin-api
- Hermes MCP and plugin surfaces: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp and https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- OpenClaw skills: https://docs.openclaw.ai/tools/skills
- Factory plugin/settings hierarchy: https://docs.factory.ai/guides/building/building-plugins and https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control
- Grok Build skills/plugins: https://docs.x.ai/build/features/skills-plugins-marketplaces
- Cursor rules and commands: https://docs.cursor.com/en/context and https://docs.cursor.com/en/agent/chat/commands
- Codex public use cases mention skills and plugins, but Prism's Codex CLI contract is primarily tracked from the local Codex configuration surface and current repo tests until fuller public CLI extension docs exist: https://developers.openai.com/codex/use-cases
