# Prism

Prism is an experimental plugin distribution system for AI coding harnesses.

## Status

Experimental. The package format, generated outputs, and harness adapters may change.

## Development

```bash
bun install
bun run verify
bun run typecheck
bun run build
```

## Managed State

Prism uses `~/.prism` for durable install and compile state. Set `PRISM_HOME` to override it.

- `config.json` controls managed backups, currently `backup.mode` (`always` or `never`) and `backup.retentionPerTarget`.
- `backups/` stores backups outside harness config directories and does not create sibling `.bak` files.
- `state/<harness>.ledger.json` tracks Prism-owned outputs so repeated installs can skip unchanged files, fail closed on drift, and prune stale managed files.

`prism install` is the unified refresh path. It compiles first when a plugin has compile targets for the selected harnesses, then reconciles install-phase artifacts; there is no separate sync command.

## Lowerer Capabilities

Prism tracks where a harness stores files separately from what kind of lowerer
surface Prism uses for that harness. The typed contract lives in
`src/lowerer-capabilities.ts` and the human-readable matrix lives in
[`docs/lowerer-capability-matrix.md`](docs/lowerer-capability-matrix.md).
Keep the matrix synced to official harness docs when changing generated bundle
targets such as Antigravity CLI, Kimi Code, Factory Droid, and Pi.

## Release Readiness

Prism's npm CLI distribution uses a private root workspace plus a public npm runner package and per-platform binary packages under `packages/npm/`.

```bash
bun run verify
bun run pack:npm-cli:dry-run
bun run smoke:npm-cli
```

Public release actions still require maintainer approval for repository visibility, tag pushes, npm trusted publishing or token setup, protected environment approval, and the real registry publish.

## Security

Please report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Contributing

Focused issues and small pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
