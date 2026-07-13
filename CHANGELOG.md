# Changelog

All notable changes to Prism will be documented in this file.

Versions are an operator decision, not a derivation — see
[`docs/release-train.md`](docs/release-train.md). Automatic conventional-commit
version bumps shipped in `0.3.0`, produced an unreleased `0.4.0` two days
later, and were deleted in `55800c8` (`refactor(release): delete automatic
version derivation`); the version was then reset to continue the `0.3.x` patch
line. `0.4.0` was committed but never tagged or published.

## 0.3.5 - 2026-07-10

### Added

- Managed CLI tool surface: `prism tools list|show|invoke|skill` with per-plugin catalogs under `PRISM_HOME/runtime/tools/`.
- Agent discovery inject modes via `PRISM_TOOLS_CLI_INJECT=skill|rules` (skill file + pointer rules, or full always-on tool inventory).
- Feature flags `PRISM_TOOLS_CLI_EMIT` and `PRISM_TOOLS_MCP_EMIT` to control catalog/skill emit vs harness MCP stdio config.

### Changed

- Harness MCP stdio-shim emission defaults **off** so agents use the CLI path; set `PRISM_TOOLS_MCP_EMIT=1` to re-enable.
- MCP JSON Schema bridge unwraps Effect `Refinement` and maps `Schema.Record` (parity with the Zod bridge).

### Fixed

- Tool plugins that used refined or Record fields (e.g. Tower) can compile again under the MCP schema bridge.

## 0.3.4 - 2026-07-07

### Added

- Workflow catalog gradual disclosure, run resume, and an orbit JSON filter for workflow listing.

## 0.3.3 - 2026-07-07

### Added

- Per-plugin MCP server topology across all generated-MCP harnesses (Claude Code, Codex CLI, Hermes, Cursor, Antigravity CLI, Kimi Code, Factory Droid, Grok): one MCP server per owning plugin, owned-only tool exposure, no consumer facades.
- Typed per-harness MCP capability contract (`src/harness-mcp-contract.ts`) and a deterministic per-plugin MCP topology verifier wired into `prism doctor` and the acceptance gate.

### Changed

- Retired the shim-exposure union registry entirely; per-plugin server naming replaces it.
- Doctor treats a live daemon as servable, not just a bundle on disk, and resolves `PRISM_HOME` through the SDK's own daemon/registry lookups rather than `homedir()`.

### Fixed

- Sync sweeps retired Prism MCP identities and legacy sentinel-owned snapshot entries on every refresh, gated on provenance rather than name alone.
- Shim command self-stamps the compiling binary so config and shim can no longer version-skew.

## 0.3.2 - 2026-07-07

### Fixed

- Grok registers its stdio-shim MCP entry directly in `config.toml#mcp_servers`; the prior plugin-bundle `.mcp.json` path is never resolved by Grok and was silently inert.
- Shared shim config regions render as the cross-plugin union instead of last-writer-wins; the shim derives a per-owner exposure profile when `PRISM_SHIM_EXPOSURE` is unset.
- Hermes workflow worker runs chat in quiet mode so JSON output survives extraction, threads the inference provider through model resolution, and requires the `hf:` model prefix.

### Added

- Per-run HMAC-keyed challenge proof for the `prism-harness-qa` example workflows.

## 0.3.1 - 2026-07-06

### Added

- Canonical MCP wire-naming module (`@skastr0/prism-sdk/mcp/wire-naming`); the shim is harness-aware and dispatches by wire name.
- All 8 generated-MCP harness lowerers flip to unconditional stdio-shim transport.

### Changed

- Generated MCP is stdio/UDS only: deleted the TCP/SSE transport from the generated MCP bundle, the `mcpRuntimePort` pipeline threading, and the `McpHarnessTransportMode` flag surface. Manual TCP daemon commands are retired; `prism mcp status` and doctor's MCP config validation target the stdio-shim contract.
- The refresh-idempotency acceptance gate retires the mcp-lifecycle path and migrates to UDS-only.

### Fixed

- Workflow scaffold writes to `~/.prism/workflows`, picks already-installed workers, and drops the implicit `git add`; shipped skill reference files land in compiled output; the Grok default model and its timeout are repaired (PQ-176).
- Persisted workflow run status now maps to the process exit code (PQ-174).

## 0.3.0 - 2026-07-04

### Added

- UDS-based MCP shim architecture behind a rollout flag: content-addressed Unix-domain-socket paths, a UDS daemon registry, idle-reap lifecycle, singleton + stale-socket recovery, an aggregating shim with exposure filtering, and resolve-or-spawn daemon resolution. Wired for Claude Code, Codex CLI, and Hermes.
- Published `@skastr0/prism-core` (renamed `@skastr0/prism-sdk` shortly after) as a standalone package with an explicit embeddable-SDK/runtime-boundary contract.
- `prism plugins` install-inspector TUI.
- Dynamic-workflow fault isolation and a real per-task runnability gate (WDX-009).

### Changed

- Added a conventional-commit-driven release train; deleted two days later in favor of operator-decided versions (see the Changelog header).

### Fixed

- Grok MCP tool names enforce Grok's 64-char cap structurally (PQ-168); doctor stops doubling the OpenCode bundle path for file-form plugin entries (PQ-167).
- Migrated local Prism sources to a noun-first naming convention across compile, workflow, and sync modules; isolated Bun-only runtime APIs behind a shared boundary.

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
