# SDK MCP Live Activation

Date: 2026-05-29

Scope: PQ-040 activated the SDK-backed generated MCP runtime for the live `tower` and `grok-agent` plugins across Hermes, Codex CLI, Claude Code, and Antigravity CLI. The original glyph text mentioned Gemini CLI; that scope is intentionally treated as Antigravity CLI because Gemini CLI support has been removed.

## Live Results

- `tower` and `grok-agent` were refreshed with `prism refresh` for `hermes,codex-cli,claude-code,antigravity-cli`.
- The second run settled idempotently for both plugins across all four harnesses.
- `tower` has exactly one shared HTTP daemon: `prism_generated_tower/server.mjs`, pid `35641`, `http://127.0.0.1:38463/mcp`.
- `grok-agent` has exactly one shared HTTP daemon: `prism_generated_grok_agent/server.mjs`, pid `38271`, `http://127.0.0.1:38473/mcp`.
- No harness-local stale stdio Tower or Grok Agent generated MCP server processes were running.
- No sibling `.bak` files were produced; managed backups stayed under `~/.prism/backups/`.

## Config Proof

- Hermes `~/.hermes/config.yaml` points both generated servers at local HTTP URLs with bearer authorization headers.
- Codex CLI `~/.codex/config.toml` parses successfully with `Bun.TOML.parse` and contains HTTP `mcp_servers` entries for both generated servers with bearer authorization headers.
- Claude Code generated plugin `.mcp.json` files point both generated servers at local HTTP URLs with bearer authorization headers.
- Antigravity CLI generated plugin `mcp_config.json` files point both generated servers at local HTTP URLs with bearer authorization headers.
- Raw bearer token values are intentionally not recorded in this document.

## Smoke Proof

- Tower HTTP MCP smoke: SDK client initialized, `tools/list` returned 21 tools, and `tower_list_glyphs` completed successfully against project `prism`, orbit `forge`.
- Grok Agent HTTP MCP smoke: SDK client initialized, `tools/list` returned 1 tool, and a safe `grok_agent_grok_invoke` call with a nonexistent cwd returned the expected structured failed status before spawning external work.

## Robustness Fixes Found During Activation

- Codex MCP TOML table removal now removes the whole table body until the next TOML table header. The previous implementation could remove only the table header and leave orphan `url`, `http_headers`, and `enabled_tools` keys behind.
- Codex MCP patching now removes orphaned generated MCP body fragments left by the older bug only when the intermediate TOML is not parse-valid, keeping valid neighboring MCP tables intact.
- Empty Codex managed hook marker blocks are no longer emitted. This prevents different no-hook plugins from deleting and re-adding each other's empty marker blocks on alternating runs.
- Refresh now skips file-router skill copies when a compile-active lowerer already owns targeted plugin skills. This removes false drift between compile-owned direct/plugin-bundle skills and direct skill normalization.
- Direct-skill compile lowerers now prune stale compile-owned targeted skill files when a source skill or skill support file is removed.

## Follow-up Pressure

- OpenCode still uses direct file-router plugin skill installation while compiled orbit skills are lowerer-owned. That remains intentional for now because the OpenCode lowerer does not copy targeted plugin skills.
- Factory Droid keeps direct plugin skills for source-only and orbit-only compile targets; generated plugin skill ownership only applies when agents, tools, or hooks cause the Factory plugin bundle to own targeted skills.
