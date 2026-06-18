# prism-harness-qa

Reference QA plugin for Prism's Kimi Code harness.

This plugin exercises every Prism compile surface that Kimi Code supports:

- **Rules** → `prism-context` session-start skill
- **Commands** → `prism-command-*` flow skills
- **Skills** → bundled as-is under `skills/`
- **Agents** → `prism-agent-*` role skills
- **Orbits** → orbit skills with phase references
- **Tools** → generated MCP server in `kimi.plugin.json`
- **Traits** → compile-time capability conformance for agents
- **Hooks** → `config.toml` hook entries

It is used by `src/compile/kimi-code-lowerer.test.ts` to assert exact lowerer output, by the Kimi smoke workflow task once live execution is safe, and by `scripts/acceptance/matrix-codex-opencode.ts` as the TS-007 cross-harness acceptance fixture.
