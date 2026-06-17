# Changelog

All notable changes to Prism will be documented in this file.

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
