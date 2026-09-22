# Changelog

All notable changes to Prism will be documented in this file.

Versions are an operator decision, not a derivation — see
[`docs/release-train.md`](docs/release-train.md). Automatic conventional-commit
version bumps shipped in `0.3.0`, produced an unreleased `0.4.0` two days
later, and were deleted in `55800c8` (`refactor(release): delete automatic
version derivation`); the version was then reset to continue the `0.3.x` patch
line. `0.4.0` was committed but never tagged or published.

## Unreleased

### Removed

- Factory Droid and OpenClaw harness targets, lowerers, catalogs, fixtures, and documentation.

## 0.7.1 - 2026-09-22

### Added

- **Curated named workflow workers** — portable JSON catalogs with descriptions,
  explicit install/export, and generated literal `prism/refs/workers` types.
  The workflow skill includes installed workers and the current project's SOP
  refs. Raw harness configuration remains available; curation does not add
  unsupported effort controls or verify model entitlement.
- **Hosted Amp skills** — the explicit `amp-orb` target writes skills into an
  existing hosted Git checkout selected with `--root`, enforcing UTF-8 text and
  hosted size/count limits. It does not publish, install plugins, or become a
  workflow worker.
- **Orb workflow regression coverage** — mixed agent/Jev routing, cache replay,
  scheduler overlap, and local Amp execution checks, with recorded live smoke
  evidence and remaining limits in `docs/workflow-orbs.md`.
- **`prism workflow skill --reference <chapter>`** — read the embedded reference
  chapters directly, without installation or a source checkout.
- **`prism workflow skill --install`** — the plugin-free delivery path. A skill
  is markdown in a folder, so this writes the embedded workflow skills into each
  detected harness's skill directory (`<globalConfigPath>/<skillsDir>/<skill>/`)
  — no plugin, no harness config edit, no registration. Writes both
  `prism-workflow` and `prism-workflow-models`; `--harness <ids>` / `--all`
  select targets, `--dry-run` previews, `--json` emits the plan. Harnesses that
  share a config root (OpenCode 1.x and 2) collapse to one write. `--harness`,
  `--all`, and `--dry-run` are rejected without `--install`.
- **Workflow skill reference chapters** — the embedded authoring skill is now a
  short `SKILL.md` that routes to five reference files
  (`references/{scheduling,jev,observability,cache-and-finish,topology}.md`),
  all generated from the binary. The body drops from 500+ lines of depth to a
  routing document under the harness's recommended body length, and `--write`
  materializes every chapter next to `SKILL.md` under PRISM_HOME.

### Fixed

- Workflow cache identity separates effective worker configurations; renaming
  a curated worker or editing its description does not invalidate task results.
- The embedded workflow skill no longer silently omits shipped surfaces.
  Scheduling (0.7.0) had no agent-facing documentation anywhere; Jev was a
  paragraph; finish criteria, cache/`promptHash` discipline, run observability,
  stop/resume, and topology patterns lived only in a hand-maintained copy in the
  `prism` plugin, which had drifted two minor versions behind the CLI.
- README claimed eleven workers; there are twelve (`opencode2` was missing).

### Removed

- **`prism workflow scaffold`** and workflow source templates. Author directly
  from `prism workflow skill`; its printed DSL example is typechecked and
  exercised through both conditional branches by tests.
- **`prism workflow models prefer`** and preference-based selection. Install a
  named worker catalog instead. Existing preference files are left untouched
  but are no longer read or applied.
- `prism-plugins` no longer carries a hand-maintained `workflow-authoring.md`
  (860 lines, last touched 2026-09-11). It duplicated the CLI's skill and had
  drifted: it documented no model quiz, no Jev, and no scheduling. The `prism`
  plugin skill now points at `prism workflow skill` / `--install`, so the CLI is
  the single source of truth for the workflow surface.

## 0.7.0 - 2026-09-18

### Added

- **Jev — TypeSafe System One as a first-class citizen.** Three surfaces, one
  implementation ([docs](docs/workflows.md#jev-tasks--typesafe-system-one-decisions)):
  - Native `jev()` workflow task kind (plus `ctx.jev(...)` in SOP phases): one
    request carries a shared JSON `state` and many `choice` / `score` / `noul`
    questions and returns one typed answer per question id with confidence and
    full probability distributions. No worker, prompt, repair, or judge loop;
    answers decode strictly against a request-correlated contract (excess or
    missing answer keys and labels fail closed), results cache by endpoint +
    model + request, concurrency is capped per run (`WORKFLOW_JEV_CONCURRENCY`,
    default 32), and over-budget requests (>~28k estimated tokens) fail
    pre-flight with a shard-the-state hint. `JevClient` is an Effect service
    with live env config (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
    `TYPESAFE_DEFAULT_MODEL`), explicit-config, and eagerly validated test layers.
  - `prism jev ask --input '<json>'|@file [--timeout-ms n] [--json-errors]` —
    the one-shot CLI the compiled plugin tool shells out to. Success is one
    `{model, answers, usage}` document on stdout; failures are classified
    (`usage` / `request` / the JevError kinds / `internal`) and with
    `--json-errors` emit exactly one versioned machine record on stderr.
  - The `jev` plugin (prism-plugins repo) exposes the same call to agents as
    the `jev/systemone_ask` tool with a skill teaching the batching doctrine
    (one request, many questions; shard the state past the budget; pin each
    question's subject in `instructions`).
- Example workflow
  [`examples/prism-harness-qa/workflows/jev-routing.workflow.ts`](examples/prism-harness-qa/workflows/jev-routing.workflow.ts)
  with rehearsing `--mock-output` answers.

### Changed

- **Effect v4** — Prism migrates to `effect@4.0.0-rc.115` exactly (pinned, not
  ranged; the version guard enforces the exact version and
  `check:effect-versions` runs inside `verify`). Context.Service, Result,
  the v4 Schema surface and AST walkers, and the schema-bridge shipped into
  generated plugins all read the v4 APIs.

### Fixed

- Jev request validation accepts `null` criterion descriptions (valid
  undescribed labels) and preserves own `__proto__` question ids/labels as
  data.
- Effect Schema decoders strip excess properties by default; every Jev decode
  boundary (ask envelope, live response, test stub, cached runner result) now
  fails on them instead, so a misspelled question field can never silently
  vanish from a request.

## 0.5.1 - 2026-09-11

### Added

- **OpenCode 2** — first-class harness and workflow worker `opencode2`, detected
  by the `opencode2` binary (or `PRISM_WORKFLOW_OPENCODE2_BIN`), not by the
  shared `~/.config/opencode/` home. `coding-harness` targets `opencode2`.
  `--harness opencode` and `worker: "opencode"` remain OpenCode 1.x only and
  never fall through to the V2 binary. The V2 worker uses `opencode2 run
  --format json [--auto]` (no `--dir`).
- `prism workflow skill` now documents `wf.phase` / `prism/refs/sops` SOP
  binding and lists `opencode2` on the permission table.

### Fixed

- Generated `sops.ts` / `models.ts` can be imported by `prism workflow
  catalog`, `validate`, and `run` after a SOP compile. Those commands no
  longer die on `Cannot find package 'effect'` from `~/.prism/state/.../generated/`.
- `prism validate` loads compile sources (`sops/*.sop.ts`, agents, hooks), so
  a forbidden SOP field fails at validate instead of only at refresh.
- Multi-harness `--compile-root` is a sandbox prefix that preserves each
  harness home. Compiling `opencode` and `opencode2` into one prefix fail-closes
  (they share `~/.config/opencode`).
- Kimi Code and Factory Droid emit SOP-only plugins (the emit gates now
  include `sops`).
- Scaffold no longer advertises the removed `--max-concurrent-tasks` flag.
- Devin workflow extract reads ATIF `messages` / `turns` / `events` in
  addition to `steps[]`.

## 0.5.0 - 2026-09-11

### Added

- **Workflow model preferences** — `prism workflow models --offer` lists each
  worker, slug count, a five-slug sample, and stated prefs. Agents quiz the
  user and save pins with `prism workflow models prefer`. Unpinned workers omit
  the harness `--model` flag so the user's harness default stays. Quiz skill:
  `prism workflow skill --models`.


- **SOPs** — `sops/<name>.sop.ts` source artifacts: type-safe procedures whose
  phases declare a `purpose`, optional typed `input`/`output` contracts
  (Effect Schema), `acceptance_criteria`, an optional `escalation`, and prose
  `body`. Concrete sop instances lower into `skills/<sop-name>/SKILL.md` on
  every skill harness, and the generated `prism/refs/sops` module exposes each
  typed phase for `wf.phase(...)` workflow binding.
- **Agent-free workflow tasks** — a workflow task binds a worker, a prompt, an
  output schema, and finish criteria. There is no `agent` field on a task, no
  agent refs for workflows, and no anonymous sentinel: agents remain a
  standalone compile primitive (`agents/*.agent.ts` → harness agent files)
  that workflows simply do not reference. Workers no longer receive agent
  identity in prompts, argv, or metadata.
- **Typed phase input** — `ctx.task({ input })` decodes against the bound SOP
  phase's input contract before dispatch; a failed decode surfaces as
  `WorkflowTaskInputError` and the decoded value is rendered into the task
  prompt. Phase criteria become inherited judge criteria unless
  `finish: { inherit: false }`.

### Removed

- **The `orbit` primitive** — `orbits/*.orbit.ts` sources, orbit refs,
  parameterized orbit templates, orbit phase agent assignment/requirements,
  orbit tool permissions, orbit skill lowering, `prism/refs/orbits`,
  `--orbit` in the workflow catalog, orbit manifest projections, and
  `OrbitValidationError`. Typed procedures are sops; compile-time agent
  orchestration contracts are gone.
- **Traits, toolspaces, agent access, and tool grants** — the trait primitive,
  toolspace sources and refs, agent `access`/`traits`, and every allow/deny
  tool or skill surface Prism used to emit into harness configs. Canonical
  tools remain the business-logic surface and lower through ordinary resolved
  bindings.
- **Orbit-era side surfaces** — signal emitters, pulsar checkpoints, orbit
  `definitions`, and hook toolspace matchers (`toolspace-tool` /
  `toolspace-group`, `toolRef` bridging).
- **Workflow agent refs** — `WorkflowAgentRef`, `anonymousWorkflowAgent`,
  `isAnonymousWorkflowAgent`, generated `prism/refs/agents`, `prism/refs` for
  agents, agent namespaces in `prism workflow catalog`, agent-based default
  worker selection, agent-phase install checks, and every worker's agent
  preload/metadata path (Claude `--agent`/`--plugin-dir`, OpenCode `--agent`,
  Grok agent-file preload, Kimi role skill, OMP installed/temp system prompt).

### Changed

- **Compile manifest schema** — the manifest no longer carries `orbits`,
  `traits`, or agent/target grant fields. Manifests written by older versions
  are quarantined as `compile-manifest.json.corrupt-<timestamp>.json` and
  rebuilt on the next compile.
- Stale generated refs (`orbits.ts`, `traits.ts`) and old manifests under
  `~/.prism/state/projects/*/` are derived state: purged here and regenerated
  by the next project compile.
- **Workflow store schema v6** — `WORKFLOW_STORE_SCHEMA_VERSION` is now 6.
  Opening an older store drops the `agent_*` and `native_agent` ledger
  columns and clears `workflow_task_records`, whose pre-v6 rows were keyed on
  an agent manifest hash and identity v3 prompt hashes that can never hit
  again. CI's `check:workflow-store-schema-version` requires a `package.json`
  version move for any schema bump; `package.json` is deliberately not bumped
  here because version selection is an operator decision
  ([`docs/release-train.md`](docs/release-train.md)).

## 0.4.6 - 2026-08-17

### Added

- **`prism configure`** — OpenTUI harness control plane. Browse detected
  harnesses, Prism-owned inventory, project/profile scopes, and memory
  buckets; read and edit catalogued settings; uninstall a plugin's owned
  surface; delete owned or stray paths. Confirm-gated writes only. Ships
  after `v0.4.5` as an unreleased-main cut: keep iterating on the TUI in
  follow-up patches.

## 0.4.5 - 2026-07-27

### Removed

- **Every workflow runtime limit, and the parameters that set them.** A knob an
  agent can see is a knob an agent will set, so the knobs are gone rather than
  defaulted off: `--task-timeout-ms` / `worker.processTimeoutMs` /
  `PRISM_WORKFLOW_*_PROCESS_TIMEOUT_MS` across all ten adapters (no watchdog, no
  `timedOut`), plus `--max-wall-ms`, `--max-tasks`, `--max-cost-usd`,
  `--task-no-progress-ms`, `--max-prompt-bytes` and the run-budget machinery
  behind them. `--max-concurrent-tasks` is replaced by internal scheduler pacing
  sized to the machine (`max(4, min(16, cores - 2))`) — it queues work, never
  fails it. The agy `--print-timeout` knob is pinned at 720h. What bounds a run
  now: `prism workflow runs stop <id>`, the run ledger, and the scope you author
  into the graph. The store still decodes historical terminal-cause kinds so old
  ledgers stay readable.

### Added

- Design spec for **worker pressure** — detecting a harness worker that has
  stopped making progress while still running, from the worker's own event
  stream (taxonomy, six pathology signals, ledger emission, action policy), plus
  the absolute-threshold gate anti-pattern and the first cross-attempt signal
  (`redundant-verification`).

## 0.4.4 - 2026-07-26

### Added

- Per-task ephemeral workflow sessions for Claude Code, Codex CLI, and OMP,
  using each harness's native no-save mode. Persistent sessions remain the
  default; ephemeral repairs start fresh with the full task context, while
  completed task results remain reusable through Prism's content-addressed
  cache.

## 0.4.3 - 2026-07-24

### Added

- **`@skastr0/prism-packager`** — publishable Bun embeddable packager
  (`packagePluginForTarget` → harness-native payload + `DesiredFile[]` /
  activation regions). Built from monorepo `src/packager.ts` via
  `scripts/build-prism-packager.ts`; no `workspace:*` deps; release-train and
  `smoke:packager` wired. See `docs/sdk-contract.md` amendment 2026-07-24.

## 0.4.2 - 2026-07-22

Tools are a one-shot Prism CLI surface. Canonical tools compile to
`PRISM_HOME/runtime/tools/<plugin>/` (`catalog.json`, `SKILL.md`, `runtime.mjs`)
and run with `prism tools invoke` in-process. OpenCode, Amp, Pi, and OMP still
register the same handles through native plugin APIs where those harnesses
support them. Hooks remain native plugins or one-shot command wrappers.

### Added

- In-process CLI tool runtime (`runtime.mjs`) loaded by `prism tools invoke`.
- `tool-runtime-bundle` compile path for CLI, Amp, and Pi tool packages.

### Changed

- Agent discovery for tools is CLI skill/rules only (`PRISM_TOOLS_CLI_EMIT`,
  `PRISM_TOOLS_CLI_INJECT`).
- Lowerer capability matrix describes tools as CLI or native plugin APIs.
- Publish/verify tool suites no longer depend on a protocol server stack.

### Removed

- Generated harness MCP server config, stdio shim, UDS daemons, and
  `prism mcp` CLI.
- `@modelcontextprotocol/sdk` and `@skastr0/prism-sdk` MCP package exports.
- Doctor MCP topology / daemon health surfaces and related acceptance scripts.

### Fixed

- Tool invoke no longer depends on daemon spawn, session setup, or socket paths.

## 0.4.1 - 2026-07-22

Workflow runtime hardening and ledger lifecycle. This is a minor milestone for
durable unattended execution — not a claim that every harness canary is
perfect or that exact multi-adapter session resume is finished.

### Added

- Durable workflow execution lifecycle: process-group ownership, attempt and terminal-cause evidence, stale-run reconciliation, and hardened stop/wait/update/resume controls.
- Host-side resource ceilings on `prism workflow run`: `--task-timeout-ms`, `--max-wall-ms`, `--task-no-progress-ms`, `--max-concurrent-tasks`, `--max-tasks`, `--max-cost-usd`, `--max-prompt-bytes`.
- Live run progress and liveness on the store, CLI, and monitor TUI.
- Workflow runs observability: machine-wide / cross-store list and show, summary rollups (`--since`, cause column), events, wait, and span `trace` (optional OTLP export).
- Workflow ledger governance (schema v5): retention, `runs inspect|export|delete|prune`, redaction policy, restrictive store file modes, hashed handoff tokens, and runner-log cleanup.
- OMP workflow worker and compile lowerer target.
- Content-addressed global task-cache identity; workflow task cache is mandatory when a store is present (`--no-cache` removed from run/update/resume).
- Doctor/workflow-store registry GC, WAL checkpoint on store close, and soft schema-divergence surfacing.
- Workflow scaffolds default under Prism home (`~/.prism/workflows`), not the target repository.

### Changed

- Generated workflow refs reload on every run instead of trusting a stale in-process surface.
- Grok project agents lower as direct native files without `skills:` frontmatter preload lists.
- Repo-local production workflow scripts and delivery examples retired in favor of home-root authoring.
- Publish and verify gates fail closed (including workflow store schema version discipline when the store schema moves).

### Fixed

- Worker process trees drained before runner exit; detached runner output captured.
- Worker forensics persisted on hard task failure.
- MCP UDS path bounds for long Prism homes; one-shot MCP session close; size-capped daemon log sinks.
- Multiple harness adapter timeout and output-extraction edge cases (including Antigravity timeout wording).
- OpenCode consumers no longer re-materialize a foreign owner's bundle.
- Doctor cleanup for orphaned Prism-fingerprinted MCP entries and retired launchd-era residue.

### Not in this release (follow-ups)

- Exact multi-adapter session continuation / execution-provenance integration.
- Authoritative cumulative token and compaction ceiling enforcement on every worker.
- Remaining ledger governance edge cases under independent review (identity-column secret policy, runner-log symlink ownership, pre-start PID reservation, concurrent migration serialization).
- Generated workflow-tool parity for inspect/export/delete/prune (CLI has them; tool surface refresh pending).

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
