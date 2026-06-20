# prism-harness-qa

Reference QA plugin for Prism harness E2E checks.

This plugin exercises every Prism compile surface that Kimi Code supports:

- **Rules** → `prism-context` session-start skill
- **Commands** → `prism-command-*` flow skills
- **Skills** → bundled as-is under `skills/`
- **Agents** → `prism-agent-*` role skills
- **Orbits** → orbit skills with phase references
- **Tools** → generated MCP server exposing the deterministic `challenge_echo` proof tool
- **Traits** → compile-time capability conformance for agents
- **Hooks** → `config.toml` hook entries

It is used by lowerer tests, by the smoke workflow tasks once live execution is safe, and by acceptance scripts as the cross-harness fixture.
