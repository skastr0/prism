# Prism

Prism is an experimental plugin distribution system for AI coding harnesses.

## Status

Experimental. The package format, generated outputs, and harness adapters may change.

## Tool Surface

Agents reach compiled tools through a managed CLI surface by default: `prism
tools list|show|invoke|skill`, with per-plugin catalogs under
`PRISM_HOME/runtime/tools/` and either an injected skill (default) or
always-on rules for discovery. Set `PRISM_TOOLS_MCP_EMIT=1` to also emit a
harness MCP config entry. Harnesses that reach Prism tools through a generated
MCP server (see
[`docs/lowerer-capability-matrix.md`](docs/lowerer-capability-matrix.md)) do
so over the stdio-shim transport: the harness spawns `prism mcp shim`, which
resolves or spawns a content-addressed Unix-domain-socket daemon at
`PRISM_HOME/runtime/mcp/<plugin>/<hash-prefix>.sock` when that path fits the
platform limit. Long Prism homes use the fixed-width, private fallback
`/tmp/prism-mcp-<uid>/<identity>.sock`; durable bundles, registry records, and
logs remain under `PRISM_HOME`. Prism no longer emits the retired Streamable
HTTP MCP transport.

## Development

```bash
bun install
bun run verify
bun run typecheck
bun run build
bun run check:refresh-idempotency
```

## Managed State

Prism uses `~/.prism` for durable install and compile state. Set `PRISM_HOME` to override it.

- `config.json` controls managed backups, currently `backup.mode` (`always` or `never`) and `backup.retentionPerTarget`.
- `backups/` stores backups outside harness config directories and does not create sibling `.bak` files.
- `state/roots/*.json` tracks Prism-owned outputs per harness root so repeated refreshes can skip unchanged files, fail closed on drift, and prune stale managed files.

`prism refresh` is the unified convergence path. It compiles first when a plugin has compile targets for the selected harnesses, then reconciles file-router artifacts through the same sync engine. `prism plan` previews the same work without writing, and `prism doctor` reports config and refresh-plan problems.

For corpus-level Codex CLI idempotency, run:

```bash
bun run check:refresh-idempotency
```

The gate runs `refresh --plugins ../prism-plugins --harness codex-cli` twice in
isolated `HOME`, `PRISM_HOME`, and MCP runtime roots. Codex CLI reaches
generated tools over the stdio-shim transport (a content-addressed UDS daemon
whose durable state remains under `PRISM_HOME`); the gate additionally stops any corpus plugin still
configured for the retired Streamable HTTP transport before cleanup. The gate
fails on warm-run stale prunes, config churn, duplicate MCP tables, orphan
hook blocks, snapshot churn, or backup churn.

## Lowerer Capabilities

Prism tracks where a harness stores files separately from what kind of lowerer
surface Prism uses for that harness. The typed contract lives in
`src/lowerer-capabilities.ts` and the human-readable matrix lives in
[`docs/lowerer-capability-matrix.md`](docs/lowerer-capability-matrix.md).
Keep the matrix synced to official harness docs when changing generated bundle
targets such as Antigravity CLI, Kimi Code, Factory Droid, Pi, and Oh My Pi.

## Source Contracts

The canonical public TypeScript source names are `AgentSource`, `TraitSource`,
`OrbitSource`, `ToolSource`, `ToolspaceSource`, `ModelspaceSource`,
`SkillspaceSource`, and `HookSource`. The older `define*` helpers remain
transitional identity wrappers for authoring ergonomics; new contract checks
should target the `*Source` names and matching loader schemas.

`OrbitSource.signal_emitter` is accepted and preserved as source metadata. It
documents outbound signal/delegation destinations; lowerers do not grant runtime
signal tools from that field by itself. `tool_permissions.bind` is intentionally
unsupported for now and rejected by the strict loader schemas; orbit tool grants
currently accept `ref` and optional `as` only.

## Release Readiness

Prism's npm CLI distribution uses a private root workspace plus a public npm runner package and per-platform binary packages under `packages/npm/`.

```bash
bun run verify
bun run build:npm-cli
bun run pack:npm-cli:dry-run
bun scripts/smoke-npm-cli.ts --skip-build
```

The smoke script installs packed tarballs into a clean temporary project,
compiles a canonical-tool fixture, and checks generated runtime output for
build-machine `node_modules` paths. `bun run smoke:npm-cli` runs the same
sequence with the build and pack dry-run included.

Public release actions still require maintainer approval for repository visibility, tag pushes, npm trusted publishing or token setup, protected environment approval, and the real registry publish.

## Security

Please report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Contributing

Focused issues and small pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
