# 07 — Roadmap, Workstreams, and Glyph Seeding

## Sequencing logic

Each workstream ends in something **usable**, not just done. The first
real-use milestone is deliberately early (end of WS2): typed workflows over
claude + grok + codex with gate, durable AgentRun ledger, and replay by stable
resource key — before approvals, before the meta-plugin, before Hermes.

```
WS0 hygiene ─→ WS1 types/provenance ─→ WS2 AgentRun ledger/runtime ─→ first real use
                                            ├─→ WS3 adapters & structured output
                                            ├─→ WS4 approvals/worktrees/budget + Hermes
                                            └─→ WS5 meta-plugin + orbit compilation
                                                      └─→ WS6 hardening & projections
```

## Glyph strategy (the "50 glyphs?" answer)

No — not 50 upfront. Glyphs are work units, not documentation; 50 pre-made
glyphs would rot the moment WS1 teaches us something. The durable plan is this
document set. The flow:

- the claimed Forge signal (`sig_905c410397ec224978b18721`) is consumed into
  **one commit-phase glyph per workstream when that workstream starts**, citing
  these docs as context;
- the enumerated items below are the glyph *candidates* — sized so each is one
  build-phase glyph (a focused PR's worth);
- review lenses per the signal: contract, data-model, reliability, security,
  simplicity, verification reviewers at each workstream boundary.

~38 candidates total. Numbers are ids for cross-reference, not order within a
workstream.

## WS0 — Hygiene (precondition, small)

- 0.1 Dedupe Effect to a single version across the tree (3.21.x skew + 4-beta
  via `@opencode-ai/plugin`); add a lockfile guard script.
- 0.2 Decide POC disposition: extract learnings into
  `13-poc-disposition.md`, document the proof it provided, then delete the POC
  folder before workflow code ships; the real code starts clean in packages.

## WS1 — Types and provenance (prism repo)

Contract docs `10`, `11`, and `12` are the cold-builder inputs for this
workstream. If implementation pressure contradicts them, update the contract doc
first rather than encoding a hidden convention in source.

- 1.1 Extract `@skastr0/prism-core` workspace package (contracts, refs,
  loadPlugin/registry, snapshot codecs); CLI consumes it.
- 1.2 Compile manifest: serialize composed agents (grants, model bindings,
  hashes) from the compose phase; schema + reader in core.
- 1.3 Refs emitter as project-level emit target through the sync engine
  (`.prism/generated/workflows/`), snapshot-tracked.
- 1.4 Generated `models.ts`: modelspace profiles with per-harness resolution.
- 1.5 Emitter versioning + managed-file headers + drift test.
- 1.6 Fixture plugin for tests (small, deterministic, not forge).

Exit: external bun script verifies a ref against manifest + snapshot with no
`prism/src` imports; tsc errors demonstrate fleet-documenting messages.

## WS2 — Runtime core (`@skastr0/prism-workflow`)

Runtime code starts from the public type catalog (`10`), AgentRun ledger spec
(`08`), and fingerprint/ref contract (`12`). Fake-worker replay proves those
contracts before any real provider adapter enters the runtime.

Implementation checkpoint (2026-06-13): the repo now has a single-package
runtime wedge rather than the full `@skastr0/prism-workflow` package boundary.
It includes typed Effect-first workflow authoring primitives, module validation,
dynamic workflow bodies, SQLite task cache/run history/events, terminal statuses,
detached runs, `runs list/show/events/wait/stop`, stale-run reconciliation,
bounded task concurrency, mock-output execution, typed decoded outputs, finish
criteria with bounded repair prompts, cooperative stop plus active child-process
abort, and shared subprocess hygiene for CLI workers. Worker adapters exist for
Grok, Codex, OpenCode, Amp, Claude Code, Antigravity, and Hermes. Native agent
binding is live only where the harness has a proven selector: OpenCode, Grok,
and Claude Code. Codex, Amp, Antigravity, and Hermes remain prompt-identity or
declared-worker lanes until their selector/profile semantics are proven.

This is intentionally short of the full AgentRun ledger in `08`; treat it as the
dogfood wedge, not as the final ledger shape. Live proof exists for: a Survey
workflow using generated refs and cache replay; finish-repair on real Grok
output (`decode.failed -> repair.started -> decode.completed -> cache_write`);
Hermes live dispatch plus rerun cache hit; and a real Grok Survey `source-scout`
run with `nativeAgent: source-scout` and `model: grok-build` metadata.

- 2.1 Package scaffold; `defineWorkflow` envelope + input decode; CLI command
  namespace under `prism workflow ...`.
- 2.2 SQLite AgentRun ledger: workflow_runs, agent_runs, outputs, attempts,
  refs, session lineage, events; deterministic schema and migration/version refusal.
  Must conform to `08-agentrun-ledger-spec.md` before any real adapter is wired.
- 2.3 Semantic fingerprint algorithm for stable keys and immutable revisions;
  prove same key + same fingerprint reuses, same key + changed prompt creates a
  new revision with prior history surfaced. Includes explicit refs/world refs,
  schema hash canonicalization, and session-lineage separation.
- 2.4 `wf.agentRun`, `wf.useRun`, and `wf.forkRun` facade; `wf.task` remains only
  as a compatibility alias if useful.
- 2.5 FakeWorkerGateway and zero-provider replay tests: run workflow v1 with one
  builder, edit workflow v2 to add reviewers, prove builder is not called again;
  edit builder prompt, prove new builder revision and dependent reviewers run.
  This is the mandatory pre-adapter gate; no Claude/Grok/Codex/Agy adapter work
  starts until fake-worker replay, duplicate-key linearization, crash recovery,
  and schema-redecode-on-reuse tests are green.
- 2.6 Gate layers 3/4/8 (provenance, attestation, output decode) — port POC,
  productionize errors, store no completed AgentRun unless decode passes.
- 2.7 Gate layer 5: policy subsumption against the compile manifest.
- 2.8 `wf.parallel` + concurrency groups (SQLite locks, TTL recovery), operating
  on AgentRun resources and dependency refs.
- 2.9 Worker gateway interface + capability matrix + subprocess hygiene
  (watchdog, stderr ring, Scope-tied teardown).
- 2.10 Adapters v1: grok first as generic CLI dispatch, then native Grok,
  native OpenCode, native Claude, prompt/projected Codex, prompt Amp,
  prompt Antigravity, and declared Hermes as live verification permits. Current
  implementation has all listed adapters, with native agent selectors only for
  OpenCode/Grok/Claude.
- 2.11 CLI: `run | runs list | runs show | runs wait | runs events | runs stop`,
  JSON envelopes; mock-output lane for deterministic tests/debugging. The
  future AgentRun-resource inspection commands remain outstanding until the
  ledger converges on `08`.
- 2.12 Basic structured output lane: native schema where proven, otherwise
  prompt clause + extract JSON + `Schema.decodeUnknown`; bounded finish repair
  now exists because real dogfood proved the need.

Exit / **first real use**: forge-mission runs end-to-end on a real goal;
rerunning an edited workflow reuses completed upstream AgentRuns with zero
re-spent tokens; killing the runner mid-run loses only in-flight attempts, not
completed resources.

## WS3 — Adapter depth and structured output

- 3.1 Structured-output derivation: Effect Schema → JSON Schema (native lane)
  + prompt clause (prompted lane); client revalidation always.
- 3.2 Codex `--output-schema` wired; claude `--json-schema` live-verified and
  classified.
- 3.3 Antigravity adapter: live-verify lowered-agent addressing headless
  (`agy --print`); projection fallback if needed; capability matrix from runs.
- 3.4 Session capture + `forkRun` (claude `provider-copy` first; codex `continue` with
  parallel-fork rejection; grok investigated).
- 3.5 Error taxonomy + retry classification (provider_busy, auth short-circuit,
  timeout backoff) with live-observed fixtures.
- 3.6 `prism-workflow doctor`.
- 3.7 Detached mode: supervised runner (evaluate reusing background-tasks as
  supervisor before building bespoke), `wait`/`events --follow`.

## WS4 — Human gates, isolation, budget, Hermes

- 4.1 Approvals: gate + decision node, ledger-backed, CLI approve.
- 4.2 `wf.worktree`: isolated lanes, keep-on-failure, cleanup tied to Scope.
- 4.3 BudgetService: cost/tasks/wall ceilings, metering from adapter telemetry,
  check-inside-the-slot semantics.
- 4.4 Hermes worker (class B): descriptor, `hermes -z` dispatch with profile
  selection (verify wrapper-alias vs flag), prompted structured output.
- 4.5 Class A/B attestation levels surfaced end-to-end (ledger, status, events).
- 4.6 Demo mission: two Hermes profiles + one codex builder, typed handoffs —
  the "not possible today" capability, recorded.

## WS5 — Distribution and the meta loop

- 5.1 Workflows meta-plugin: toolspace (validate/run/status/wait/approve/list/
  events) + authoring skill; compiled to claude/grok/codex/agy/hermes.
- 5.2 Approval-notify hook.
- 5.3 Agent I/O contracts in AgentSource (`contracts.output`) + inference in
  `wf.agentRun` (prism-core change, gated on WS2 experience).
- 5.4 Orbit-compiled workflow skeletons: `orbits.forge.mission(goal)` emitter.
- 5.5 End-to-end meta demo: an agent authors, validates, runs, and reports a
  workflow entirely through prism-installed tools.

## WS6 — Hardening and projections (as pressure appears)

- 6.1 Ledger compaction/export + flexible scope query CLI (SQLite remains the
  only runtime source of truth).
- 6.2 Static analyzer over statically-shaped workflows (full preflight for the
  subset; cost estimation via modelspace pricing).
- 6.3 OS-sandbox profile for the runner (containment seam from 05).
- 6.4 Viewer (read-only, SSE over ledger events) — only if the CLI/MCP surface proves
  insufficient.
- 6.5 API-projection workers (raw SDK, no CLI) on the codex-projection template.
- 6.6 Grok lowerer identity-binding fix (observed in POC smoke test).

## Risks (top five, with mitigations already in the plan)

1. **Effect version skew** → WS0.1 before any runtime code.
2. **Compile manifest scope creep** (compose phase entanglement) → serialize
   existing results only; no compose refactor in WS1.
3. **Adapter capability drift** (harness CLIs move fast) → doctor + version
   preflight + capability matrix only from live verification.
4. **Accretion toward harness-adjacent features** → non-goals list in 00;
   review lens at every workstream boundary.
5. **Resource replay correctness under edits** → semantic fingerprint tests +
   fake-worker edit/replay tests before any real adapter work; completed
   AgentRuns are the durable boundary, in-flight attempts may rerun.
6. **Stale-world Goodhart trap** → AgentRun reuse must surface evidence/world
   refs; reused output is a durable fact of past labor, not a certificate that
   the current workspace or external world still matches it.
7. **Adapter lifecycle tar pit** → every real adapter requires a smoke-test
   fixture for headless completion, auth-prompt detection, process-group cleanup,
   timeout/cancellation, and global config lock behavior before joining the
   runtime matrix.
