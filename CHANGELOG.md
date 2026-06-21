# Changelog

All notable changes to Prism will be documented in this file.

## 0.2.0 - 2026-06-21

### Added

- Added Prism workflow task-level permission modes with fail-closed worker interpreters across OpenCode, Claude Code, Codex CLI, Grok, Hermes, Kimi Code, and Amp Code.
- Added workflow modelspace resolution, raw task model overrides, and `modelResolver` support for typed model selection.
- Added deterministic workflow E2E matrix coverage, generated-tool proof checks, harness root seeding, and workflow council/review workflows.
- Added broader compile and acceptance coverage for harness lowerers, MCP ownership, native plugin loading, state snapshots, and generated canonical tool execution.

### Changed

- Inlined full managed skill content into generated rules so harnesses receive complete skill context.
- Hardened generated MCP server ownership and exposure handling for Claude Code, Factory Droid, Grok, Kimi Code, Codex CLI, Cursor, and Hermes.
- Improved workflow worker metadata, run storage, monitor behavior, and direct generated-agent invocation.

### Fixed

- Fixed Grok workflow MCP isolation, auth-prompt detection, headless invocation, and generated MCP tool names that exceeded Grok's validator.
- Fixed Claude Code generated MCP config loading and fail-closed behavior for missing plugin MCP config.
- Fixed Hermes workflow execution to use script-friendly oneshot output and seeded profile auth for live-config temp E2E runs.
- Fixed Kimi Code workflow permission mapping so prompt-mode runs no longer pass the unsupported `--yolo` flag.
- Fixed MCP HTTP client resilience, daemon dry-run port reuse, idle connection handling, schema literal lowering, and graceful server shutdown.
- Fixed Codex MCP ownership and workflow output JSON leakage.

## 0.1.3 - 2026-06-17

### Added

- Topologically sort plugins discovered by `prism refresh --plugins` based on `plugin.json` `deps`, ensuring owner plugins compile before consumers on clean harness roots.
- Filter merged owner MCP server `enabledTools` to the subset actually referenced by consumer agents (Kimi Code and future harness configs).
- Ownership parity tests for Factory Droid, Antigravity CLI, Grok, and Pi lowerers.

### Fixed

- Eliminated layer-3 ownership merge race where a consumer plugin could compile before its owner and fail closed.

## 0.1.0 - 2026-06-03

- Prepare Prism for npm CLI distribution through `@skastr0/prism`.
- Add per-platform npm packages for prebuilt Bun standalone binaries.
- Add CI-first npm publish workflow using the protected `release` environment.
