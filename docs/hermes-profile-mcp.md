# Hermes Profile-Local MCP Compilation

Checked: 2026-05-31

This note closes the design question for profile-local Hermes MCP compilation.
It is intentionally narrower than a general Hermes profile compiler.

## Product Facts

Hermes profiles are separate Hermes homes. Each profile has its own
`config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron jobs, and
state database. Hermes also exposes `hermes --profile <name>` / `hermes -p
<name>` as the way to run a command under a selected profile.

Hermes MCP is config-driven. A profile's `config.yaml` owns `mcp_servers`, where
each server can be stdio (`command`, `args`, `env`) or HTTP (`url`, `headers`).
Hermes supports server-local `tools.include` / `tools.exclude` filtering, and
registers MCP tools under sanitized `mcp_<server>_<tool>` names.

Hermes skills are profile-local through the selected home. Hermes can also load
external skill directories and plugin-provided namespaced skills, but Prism's
current Hermes support writes ordinary managed skills into the selected profile
home's `skills/` tree.

Hermes native Python plugins are a different surface. They live under
`~/.hermes/plugins/<plugin>/`, use `plugin.yaml` plus Python `register(ctx)`
code, are opt-in through `plugins.enabled`, and can register tools, hooks,
slash commands, CLI commands, and bundled skills.

Profile distributions can package a whole Hermes profile, including SOUL,
config, skills, cron jobs, and MCP connections. The docs mention distribution
ownership for `mcp.json`, while the live MCP runtime docs emphasize
`config.yaml -> mcp_servers`; Prism should therefore keep patching
`config.yaml#mcp_servers` until Hermes documents a distribution-local MCP merge
contract that is better for generated Prism outputs.

## Decision

Prism does not need a first-class `profile` target concept yet.

A Hermes profile is a root. Prism should express profile-local MCP by refreshing
the normal `hermes` target against the selected profile root:

```bash
prism refresh --plugin ./my-plugin \
  --harness hermes \
  --compile-only \
  --compile-root ~/.hermes/profiles/coder
```

This keeps Prism's model unified:

- target remains `hermes`
- scope remains `global` unless Prism is intentionally writing a project-local
  harness root
- the selected profile home is just the harness root override
- `PRISM_HOME` remains the explicit runtime root for generated MCP bundles

No new install/sync fork, source-language target family, or profile-only
artifact namespace is introduced.

## Current Lowering Shape

For a selected profile root `<profile-root>`, Hermes lowering writes:

- targeted skills to `<profile-root>/skills/`
- generated orbit skills to `<profile-root>/skills/<orbit>/SKILL.md`
- generated MCP bundles to `<PRISM_HOME>/runtime/mcp/<plugin>/server.mjs`
- profile-local MCP config into `<profile-root>/config.yaml#mcp_servers`,
  pointing at the canonical bundle

When `plugin.json -> runtime.mcp.hermes.transport` is Streamable HTTP, Prism can
write the config entry into the profile root while serving the generated HTTP
runtime from the Prism-managed runtime root:

```bash
prism refresh --plugin ./my-plugin \
  --harness hermes \
  --compile-only \
  --compile-root ~/.hermes/profiles/coder
```

That split lets multiple Hermes profiles point at the same Prism-managed
runtime when the generated tool surface is identical.

The CLI root flags are intentionally not interchangeable. In `prism refresh`,
`--compile-root` means the Hermes profile/config root. In
`prism mcp serve/status/stop/restart`, lifecycle flags manage only the
Prism-generated daemon, not the Hermes profile config.

## Ownership, Pruning, and Idempotency

Prism ownership is root-sensitive. The managed ledger records the harness,
scope, root, plugin name, and target path, so profile-local writes are owned
under the profile root that Prism was asked to mutate.

The Hermes config patch owns only one `mcp_servers.<server>` child entry. It
must preserve unrelated Hermes config and unrelated MCP servers. Re-running the
same compile is the sync operation: unchanged files skip, the owned MCP entry is
replaced idempotently, and stale Prism-owned generated server output is pruned
when a plugin no longer exposes canonical tools for Hermes.

If the generated server has no tool names, Prism removes the generated MCP
server bundle and removes the owned server entry from `config.yaml`.

Shared runtime roots have a stricter pruning rule. If `--mcp-root` differs from
the profile root, Prism may only prune a generated runtime bundle after proving
no other Prism-owned Hermes profile/root ledger entry still references that
same runtime identity. If that cross-root proof is unavailable, pruning must be
skipped or fail closed. A profile-local sync must never delete a shared runtime
that another profile's `config.yaml#mcp_servers` entry still uses.

## Collision Rule

Today, generated Hermes MCP server names are source-plugin scoped:
`prism-generated-<source-plugin>`.

That is correct for profile-local runtimes and for shared runtimes where every
profile receives the same generated tool surface.

If Prism later supports genuinely profile-different tool surfaces for the same
source plugin while sharing one `--mcp-root`, the server identity must gain an
explicit profile discriminator or fail closed before writing. Otherwise the last
profile compiled would overwrite the runtime bundle for every profile using the
same generated server name.

This is not needed for the current root-override model, but it is the boundary
for any future first-class profile feature.

## Composition With Prism Source Concepts

Profile-local MCP does not change the meaning of Prism source artifacts.

- Canonical tools still compile to generated MCP servers.
- Toolspace bindings still resolve for the `hermes` target.
- Skill visibility remains Hermes-wide within the selected profile root.
- Managed skills and generated orbit skills remain file-based Hermes skills.
- Trait-level `access.skills` / `inject.skills` do not become a narrower
  per-agent Hermes permission layer. Hermes has no documented profile-local
  per-agent skill allowlist in Prism's supported surface, so those intents only
  validate that referenced skills can resolve for the `hermes` target and be
  present in the selected profile's skill tree.
- Modelspace/profile-like authoring concepts must not be conflated with Hermes
  profiles; modelspaces choose model config, while Hermes profiles choose a
  whole Hermes home.
- SOUL/personality/identity remain separate. Prism may document how authored
  identities relate to a Hermes `SOUL.md`, but Prism should not lower identities
  into `SOUL.md` until that becomes an explicit, reviewed product contract.
- Hermes native plugins can register namespaced bundled skills, but Prism's
  generated Hermes skills remain ordinary profile-local skill folders until a
  separate native Python plugin authoring contract exists.

Claude Code and other generated native-plugin lowerers are unaffected. They may
use plugin-local MCP config or native plugin APIs, while Hermes continues to use
the product's profile-local `config.yaml#mcp_servers` surface.

## Non-Goals

- Do not generate Hermes native Python plugins from portable Prism canonical
  tools. That surface is powerful, opt-in executable Python code and should be a
  separate native plugin authoring story if Prism supports it later.
- Do not lower Prism identities, personalities, traits, or agent definitions
  into Hermes `SOUL.md`.
- Do not invent runtime delegation between Hermes profiles or subagents.
- Do not patch profile distribution manifests yet.
- Do not add a `hermes-profile` harness ID or a separate install/sync mode.

## Future Hardening

- Add clearer CLI aliases or help text for harness-root versus runtime-root
  flags if profile-local Hermes use becomes common.
- Add a fail-closed guard before sharing one runtime root across
  profile-different generated tool surfaces for the same source plugin.
- Prefer a structured YAML patcher if Hermes config formatting edge cases become
  common enough to justify a dependency.

## Source Pointers

- Hermes profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles/
- Hermes profile commands: https://hermes-agent.nousresearch.com/docs/reference/profile-commands/
- Hermes MCP config reference: https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference/
- Hermes plugins: https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
