# prism — brief

updated: 2026-09-24 · version: 0.8.0 · maturity: usable-with-gaps

Maturity: 22 npm releases, green CI, and my own setup runs on it (85 plugins, 21 generated Claude Code plugins); but I'm the only user I can show, and Cursor and Pi are compile-checked only.

## One line

prism compiles one agent source into every coding harness's native config.

## The pain

You fix a skill once. Days later a Codex session trips on the old copy in `~/.codex/skills`, and the agent burns its turn diffing source against installed files before it can start your task. Every harness keeps its own copy of your rules, skills, agents, and hooks, in its own format, so a fix lands in one and rots in the rest.

(Receipt: Codex session `codex:0108d5e9…`, 2026-05-15, "installed `.codex/skills` copy is stale and still invalid".)

## What changes

One plugin directory, one command: `prism refresh`. Each harness gets its own native shape:

| harness | what prism writes |
|---|---|
| Claude Code | a plugin under `~/.claude/skills/prism-generated-<plugin>/` |
| Codex | `agents/<name>.toml` plus a fenced region in `AGENTS.md` |
| OpenCode | `agents/<name>.md` plus keys in `opencode.json` |
| Antigravity, Kimi, Pi | a generated plugin or package (Kimi and Pi also get a config entry) |
| Grok, Cursor, Amp, Devin | skills plus a fenced region in their rules file |
| Hermes, OMP | skills |

(Receipt: See it run, runs 1 and 3.)

Run it again and nothing is written. A managed file you edited is repaired, with a backup. A file prism never wrote is refused. A tool you write once runs from any harness through `prism tools invoke`, and `prism workflow run` sends typed tasks to installed harness CLIs, rejecting any answer that fails its schema.

## Where it fits

prism is the shared capability source for agents working together: agents in different harnesses load the same skills, rules, and tools from one plugin. quasar's 17 tools reach every agent this way (`prism tools invoke quasar <tool>`).

## See it run

All runs below: published `prism` 0.8.0, 2026-09-24. Runs 1–3 used a scratch `HOME` and `PRISM_HOME`, so nothing touched my own config; run 4 used my Codex login with its run store in a scratch directory. Paths trimmed to `~`.

**1. One source, every harness, then nothing to do.** Does one refresh reach every harness, and is it safe to run again?

```text
$ prism init my-standards --with-agent --with-skill
$ prism refresh ./my-standards --all
   Matching requested harnesses: claude-code, opencode, hermes, codex-cli, antigravity-cli, kimi-code, amp-code, cursor, pi, omp, grok, devin
create    ~/.claude/skills/prism-generated-my-standards/agents/reviewer.md (new)
create    ~/.config/opencode/agents/reviewer.md (new)
patch     ~/.config/opencode/opencode.json [agent.reviewer.mode, agent.reviewer.model, agent.reviewer.temperature, agent.reviewer.tools]
create    ~/.kimi-code/plugins/managed/prism-generated-my-standards/kimi.plugin.json (new)
patch     ~/.pi/agent/settings.json [packages.prism-generated-my-standards]
   codex-cli ~/.codex: create=2, patch-regions=1
   cursor ~/.cursor: create=3, patch-regions=1
   grok ~/.grok: create=1, patch-regions=1
   ...
✅ Done.

$ prism refresh ./my-standards --all
   codex-cli ~/.codex: skip=2, skip-regions=1
   ...
✅ Already converged — nothing written.
```

**2. Drift is repaired; foreign files are refused.** What happens to a file I edited by hand, or one prism never wrote?

```text
$ echo "hand edit" >> ~/.codex/prompts/test.md
$ prism refresh ./my-standards --harness codex-cli
   codex-cli ~/.codex: repair=1, skip=1, skip-regions=1
     repair        ~/.codex/prompts/test.md (drifted)
💾 Backups created:
   ~/.prism/backups/20260924T072528-90hq2s/6b735ac615030cb6/prompts/test.md

# fresh HOME where ~/.codex/prompts/test.md already holds "my own prompt"
$ prism refresh ./my-standards --harness codex-cli
⛔ Refusing to overwrite a file Prism does not manage: ~/.codex/prompts/test.md
  hint: a file Prism has never managed already exists here with different content — delete or move it, then refresh
❌ Refresh finished with unapplied targets.          (exit 1; file unchanged)
```

**3. One tool, one implementation, callable from any harness.** Does a tool written once run without a daemon?

```text
$ prism refresh ./prism-harness-qa --harness claude-code,codex-cli
$ prism tools invoke prism-harness-qa challenge_echo --input '{"challenge":"brief-2026-09-24"}'
{
  "challenge": "brief-2026-09-24",
  "proof": "prism-tool-proof:brief-2026-09-24",
  "source": "prism-generated-tool"
}
$ prism tools invoke prism-harness-qa challenge_echo --input '{"nope":1}'
{ "error": "Expected no excess property\n  at [\"nope\"]" }      (exit 1)
```

**4. A typed task on an installed harness.** Is what comes back checked before I use it?

```text
$ prism workflow run review.workflow.ts --mock-output bad.json     # count: "one"
❌ Workflow run failed: workflow task count-harnesses returned output that failed schema decode

$ prism workflow run review.workflow.ts                            # live, codex-cli
{
  "runId": "e4d99d3a-ba34-48fc-b8ed-01a9e2a30526",
  "tasks": [{
    "id": "count-harnesses",
    "output": { "harnessIds": ["claude-code", "opencode", "hermes", "codex-cli", "antigravity-cli",
                "kimi-code", "amp-orb", "amp-runner", "amp-code", "cursor", "pi", "omp", "grok", "devin"],
                "count": 14 },
    "status": "completed",
    "metadata": { "adapter": "codex-cli", "durationMs": 22057, "codexNativeOutputSchema": true, ... }
  }]
}
```

The answer is correct: `src/lowerer-capabilities.ts` enumerates those 14 ids, matching `HarnessId` at `src/types.ts:6-20`. The run cost 23,506 Codex tokens.

## How it works

`plugin.json` says which harnesses get each artifact kind. `prism refresh` compiles TypeScript sources (`*.agent.ts`, `*.tool.ts`, `*.hook.ts`, `*.sop.ts`) through one lowerer per harness (`src/compile/pipeline.ts`, `src/compile/lowerers/`) and routes markdown rules, commands, and skills as files. Every write goes through `planSync` (`src/sync/plan.ts:577`), which diffs against the ledger in `~/.prism/state/roots/`, and `applySync` (`src/sync/apply.ts:120`), which writes, backs up to `~/.prism/backups/`, and prunes what prism no longer emits. What each harness supports is declared once in `src/lowerer-capabilities.ts`; an unsupported target fails validation. Workflows are Effect programs (`defineTask`, `defineWorkflow`): `src/workflow-runtime.ts` spawns the harness CLI, decodes its answer against the task's `Schema` (`src/workflow-errors.ts:8` on failure), and stores runs and events in SQLite.

Diagram spec:

- nodes: `plugin.json` · sources (`agents/`, `skills/`, `tools/`, `hooks/`, `rules/`, `commands/`) · compile pipeline (load → resolve → compose) · lowerer × harness (claude-code, codex-cli, opencode, … 12 on `--all`) · file router · `planSync` · ledger (`~/.prism/state/roots`) · `applySync` · harness roots (`~/.claude`, `~/.codex`, `~/.config/opencode`, …) · backups (`~/.prism/backups`) · tool runtime (`~/.prism/runtime/tools/<plugin>/runtime.mjs`) · workflow runtime · harness adapter · harness CLI · `Schema` decode · SQLite store
- edges: `plugin.json` → sources; sources → compile pipeline → lowerer (one per harness); sources → file router; lowerer + file router → `planSync`; ledger → `planSync`; `planSync` → `applySync` → harness roots; `applySync` → backups; `applySync` → ledger; lowerer → tool runtime; workflow runtime → harness adapter → harness CLI → `Schema` decode → SQLite store

## Who it is for / not for

For:
- someone who runs two or more coding harnesses and keeps the same rules, skills, agents, or hooks in each
- someone who wants that setup in Git, reviewed, and reproducible on a second machine
- someone who wants to dispatch tasks to several harness CLIs and get typed JSON back

Not for:
- a single-harness user; that harness's own config is simpler
- anyone who wants a hosted service or a model API SDK: prism drives CLIs you have installed and authenticated
- Windows users (no Windows binary)
- a team that needs a stable format today; the README says outputs and adapters may still change

## Install

```bash
npm install -g @skastr0/prism
```

Prebuilt binaries for darwin-arm64, darwin-x64, linux-arm64, linux-x64 (`packages/npm/prism-*/package.json`). No Windows build. Workflows need the target harness CLIs installed and logged in; live runs spend that harness's tokens.

## Proof

- Released: `0.8.0` on 2026-09-23 (`CHANGELOG.md:16`); 22 versions on npm (`npm view @skastr0/prism versions`: 0.1.0 … 0.8.0). `@skastr0/prism-sdk` and `@skastr0/prism-packager` also at 0.8.0.
- CI: latest `main` run succeeded (`gh run list`: run 35966566681, 2026-09-24); the v0.8.0 publish workflow succeeded (run 35906498676).
- Tests: `bun test --timeout 30000` on `main` at `ebd785b`, 2026-09-24: 1,623 pass, 2 skip, 0 fail, 1,625 tests across 157 files, 545 s.
- Idempotency: second `prism refresh --all` in run 1 wrote nothing; `bun run check:refresh-idempotency` exists as a script gate (`package.json`). I did not run that script today.
- Harness reach: 14 harness ids (`src/types.ts:6-20`); `--all` targets 12 of them (run 1). The capability matrix marks 10 targets `live-proven`, Cursor and Pi `compile-verified` (`docs/lowerer-capability-matrix.md`, checked 2026-07-22).
- Daily use: on my machine, 85 plugin sources in `~/Projects/prism-plugins`, 44 ledger files in `~/.prism/state/roots`, 21 `prism-generated-*` plugins in `~/.claude/skills`.
- GitHub: `skastr0/prism`, public, 2 stars (`gh repo view`).

## Gaps

- **Codex tasks fail outside a Git repo.** Running run 4 from a plain directory: `❌ Workflow run failed: codex exited with 1: Reading additional input from stdin... Not inside a trusted directory and --skip-git-repo-check was not specified.` It passed after `git init`.
- **Example README is stale.** `examples/prism-harness-qa/README.md` still says tools ship as a generated MCP server and lists orbits and traits; tools are CLI-only and those contracts are gone. (The main README was rebuilt from this brief on 2026-09-24.)
- **Two targets are compile-checked only.** Cursor and Pi output is pinned by golden tests, never dispatched live. Antigravity and OMP are live-dispatched but their smoke fixtures are pending. The matrix predates `amp-runner` (added in 0.8.0).
- **Per-harness holes, by design:** Kimi has no project scope; Amp has no `session.end` hook; Hermes gets skills and tools but no agents or hooks; Devin gets no tools yet (`docs/lowerer-capability-matrix.md`).
- **First refresh churns a little.** On an empty `HOME`, one refresh backed up `CLAUDE.md` and `AGENTS.md` it had created moments earlier, and rewrote `generated/models.ts` once per harness (`repair … (source-changed)`). The second run was clean.
- **Workflow durability is local.** Runs live in a local SQLite store; the README says this is not `@effect/workflow`-style durable execution. `docs/workflow-production-readiness-audit-2026-07-21.md` still lists open rows (e.g. row 46, store data governance).
- **Live runs cost tokens with no ceiling.** prism sets no timeout or cost cap by design (`README.md`, "No runtime limits"); a trivial task used 23,506 tokens.
- **One user.** No evidence of anyone else running it.

## Demo moments

1. **One source into twelve harnesses** (terminal cast, ~20 s). `prism init`, `prism refresh --all` on an empty `HOME`, `tree -L 3 ~` showing `.claude`, `.codex`, `.config/opencode`, `.grok`, `.kimi-code`, `.pi` filled; run refresh again and hold on `✅ Already converged — nothing written.` Proves reach and idempotency.
2. **Drift and ownership** (terminal cast, ~15 s). Append to a managed Codex prompt, refresh, show `repair … (drifted)` and the backup path; then a pre-existing user file and the `⛔ Refusing to overwrite` line with the file still intact. Proves prism never clobbers what it does not own.
3. **Typed answer from Codex** (terminal cast, ~30 s, sped up). Mock run with a wrong type fails schema decode; live run on Codex returns `count: 14`; `grep` the source to show 14 ids. Proves the output is checked before use.

## Copy bank

- tagline: One agent source, native in every harness.
- short description: prism compiles one source of agents, skills, tools, and hooks into native config for 12 AI agent harnesses, and runs typed tasks across them.
- page lede: prism compiles one plugin of agents, skills, tools, and hooks into the native config of every coding harness I use: Claude Code, Codex, OpenCode, Grok, Kimi, Amp, Cursor, Pi, and more. It also sends tasks to those harnesses and checks every answer against a schema before anything downstream reads it.
- X post: Twelve agent CLIs are installed on my machine. Each kept its own copy of my skills, and a fix in one rotted in the rest. prism compiles one plugin into each harness's native format, repairs drift, refuses files it never wrote, and a second run writes nothing.
