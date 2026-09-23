# Prism workflow stabilization on Amp orbs

The target is reliable agent-only, pure Jev, and mixed agent/Jev automation. This matrix separates
deterministic regression coverage, authenticated integration checks, and actual orb lifecycle tests.
Passing one layer does not establish the others. Observations below are from September 21, 2026.

## An awaited command keeps the orb awake; an unattended service does not

[Amp's pause contract](https://ampcode.com/docs/orbs/sizes-and-costs) says an orb pauses when the agent
has done no work for five minutes **and** the user has not interacted for twenty minutes. Running a
command or waiting for a test suite is agent work. The agent does not need to send progress messages
to keep a long-running command alive.

| Execution posture | Documented behavior |
|---|---|
| Amp runs `prism workflow run <file>` and awaits completion | Active agent work keeps the orb awake |
| Amp detaches a run, then awaits `prism workflow runs wait <id>` | The foreground wait is agent work; its default timeout is 60 seconds, so size or renew the wait |
| Amp detaches a run and ends its turn | The background process alone does not prevent idle pause |
| Prism scheduler runs as an `amp orb service` | Supervision survives CLI updates; the service still pauses with an idle orb |
| Cron runs inside the orb | Cron cannot execute while the machine is paused or independently wake it |

For intermittent automation, prefer an [Amp automation](https://ampcode.com/docs/orbs/automations)
that wakes the thread and awaits Prism. Either run a workflow directly, or invoke
`prism workflow scheduler serve --once` to service Prism's installed due schedules. In the latter
case, the external wake cadence bounds launch latency; it does not replace Prism's due cursor.

A plugin may instead hold `amp.system.executor.keepAlive()`. This deliberately consumes orb runtime
credits and is best-effort, not immunity to manual pause, exhausted credits, or provider limits.
[Webhooks](https://ampcode.com/docs/orbs/event-driven) are another wake source; duplicate delivery
needs application-level deduplication. None of these mechanisms is configured by this guide.

An orb is not a shared scheduler host: each orb has its own filesystem, `PRISM_HOME`, stores, and
cache unless an external sharing mechanism is explicitly provided. Local process tests cannot prove
actual pause/resume behavior.

## Layer A: deterministic regression matrix

These cases must run without paid inference. The named suites are the owning verification surfaces,
not a claim that every relevant edge case is exhausted. Use asymmetric inputs, exact call counts,
and durable ledger assertions rather than merely checking exit zero.

| Area | Required assertion | Verification surface |
|---|---|---|
| Dispatch | Worker tasks reach only the worker executor; Jev reaches only its service | `src/workflow-jev.test.ts` |
| Mixed routing | Agent output becomes Jev state; the decision selects exactly one downstream branch | `src/workflow-jev.test.ts` |
| Dependency failure | Failed extraction or Jev evaluation prevents downstream agent calls | `src/workflow-jev.test.ts` |
| Replay | Identical graph/input produces a new run with identical cached outputs and zero model calls | `src/workflow-jev.test.ts`, orb smoke below |
| Invalidation | Changed upstream content invalidates dependent decisions; original-input cache identities remain reusable | `src/workflow-jev.test.ts` |
| Jev identity | Endpoint, model, state, questions, and result-contract version affect identity; timeout does not | `src/workflow-jev.test.ts` |
| Jev codecs | Missing/excess answer keys, wrong labels, malformed probabilities, and mismatched score legends fail closed | `src/jev.test.ts`, `src/services/jev.test.ts` |
| Jev failures | Configuration, authentication, rate limit, timeout, transport, and protocol failures remain distinguishable | `src/services/jev.test.ts`, `src/jev-ask.test.ts` |
| Batching | Multiple subject-bound questions share one request; over-budget state fails before transport | `src/services/jev.test.ts` |
| Repair | Decode and finish budgets stay separate; Jev protocol errors never enter an agent repair loop | `src/workflow-runner.test.ts`, `src/workflow-jev.test.ts` |
| Model selection | Unpinned means harness default; explicit pins and Amp catalog pins retain harness-specific shapes | `src/workflow-models.test.ts`, `src/workflow-worker-args.test.ts` |
| Permissions | Unsupported modes fail before spawn; supported modes produce exact native flags | `src/workflow-worker-args.test.ts` |
| Local Amp execution | Exact argv uses local `--execute`, never nested-orb flags, with and without orb environment markers | `src/workflow-worker-args.test.ts` |
| Scheduling gates | Declaring installs nothing; installing imports the module but does not execute `run`; serving launches only due work | `src/workflow-scheduler/install.test.ts`, `serve.test.ts` |
| Reinstall | Unchanged policy is a no-op; changed policy updates revision and cursor atomically | `src/workflow-scheduler/store.test.ts` |
| Overlap | Running/reserved/uncertain executions occupy the schedule; due overlap is skipped, never duplicated | `src/workflow-scheduler/store.test.ts`, `serve.test.ts` |
| Missed runs | Overdue occurrences coalesce into one opportunity, not a burst | `src/workflow-scheduler/serve.test.ts` |
| Recovery | Alive processes are adopted; proven death without result is interrupted; uncertainty never expires by timer | `src/workflow-scheduler/reconcile.test.ts`, `process-identity.test.ts` |
| Foreground serving | `--once` awaits completion; real runner children with mocked pure-Jev/mixed task outputs persist success/failure before it returns | `src/workflow-scheduler/serve.test.ts`, `serve-runner.test.ts` |
| Cancellation | Stop drains the runner/worker tree; interrupted work is not marked completed | `src/workflow-controls.test.ts`, `workflow-worker-process.test.ts` |
| Time | Five-field cron, named timezones, and both DST boundaries follow the documented policy | `src/workflow-scheduler/cron.test.ts` |
| Secrets | Error output, stored rows, and exports apply redaction; unsafe cache writes are not persisted | `src/workflow-data-policy.test.ts`, `workflow-data-governance.test.ts`, `workflow-store-governance.test.ts` |
| Evidence | Runs/tasks have matching statuses, cache flags, ordered task IDs, and scheduling provenance | Orb smoke; `src/workflow-store-scheduling.test.ts` |

The token-free orb smoke exercises the actual source CLI and generated workflow loader, not just
in-process executor functions. It isolates cwd, `PRISM_HOME`, and SQLite stores, disables worker
binaries and inference credentials, and runs pure Jev plus both mixed worker shapes with mocks.
Live cache replay likewise clears credentials and makes both worker executables unavailable.

```bash
bun run build:core
bun scripts/build-dts.ts
bun scripts/acceptance/workflow-orb-smoke.ts
bun test scripts/acceptance/workflow-orb-smoke.test.ts

# Full deterministic suite; the bun test preload rebuilds stale prerequisites.
bun run test:ci
```

## Layer B: authenticated live matrix

Live checks use synthetic data and real credentials supplied through the environment. They do not
install plugins, pin models, edit project code, or perform business side effects. A smoke pass proves
the specified sample, not reliability across every model or every future CLI release.

| Case | Required evidence | Current status |
|---|---|---|
| Claude authentication | Native CLI version and OAuth status, then successful real dispatch | Passed: Claude Code 2.1.267 and one exact arithmetic task |
| Pure Jev | One request with opposite `choice` answers plus independently checked `score` and `noul` | Passed in the repeatable smoke |
| Claude → Jev → Claude | Exact extraction, decision-based downstream task, checked report, completed ledger | Passed in the repeatable smoke |
| Amp → Jev → Amp | Same assertions through the actual Amp CLI | Passed in the repeatable smoke |
| Credential-free replay | New run ID, all tasks cached, identical outputs, no usable worker binary/Jev key | Passed for all three shapes |
| Scheduled pure Jev | Real due boundary; `--once` awaits one uncached live result; no occupant afterwards | Passed once in an isolated store |
| Scheduled Claude → Jev → Claude | Real due boundary, correct task outputs, provenance, completion and no leftover runner | Passed once in an isolated store |
| Scheduled agent-only and Amp mixed | Same scheduling assertions through the remaining worker shapes | Still required |
| Model pins | Chosen native model/mode and Amp catalog/effort reach the worker; temporary pins are cleaned up | Still required; no preferences chosen |
| Live repair | A real schema/finish failure repairs within its budget and records the correct continuation | Still required |
| Live cancellation | Stop an active harness/API request and verify terminal ledger plus process absence | Still required |
| Expired auth / rate limiting | Actionable typed failure, bounded retry behavior, no secret in diagnostics | Deterministic coverage exists; controlled live checks still required |
| Side-effect replay | Domain idempotency key prevents duplicate external writes across interrupted attempts | Requires a disposable domain fixture; not guaranteed by Prism cache |

```bash
# These commands spend tokens. No model preference is inferred or saved.
bun scripts/acceptance/workflow-orb-smoke.ts --live --worker none
bun scripts/acceptance/workflow-orb-smoke.ts --live --worker claude-code
bun scripts/acceptance/workflow-orb-smoke.ts --live --worker amp-code
```

The pure-Jev scheduled smoke used `* * * * *` in `America/Sao_Paulo`, installed into temporary stores,
and waited until the real next due time. `scheduler serve --once --json` reported `launched: 1`,
`failed: 0`, and `leftRunningOnShutdown: 0`. The scheduler execution was completed with no occupant;
the workflow ledger contained exactly one completed run and the expected uncached Jev answer.

A second isolated schedule crossed the real `2026-09-21T09:29:00Z` due boundary in UTC. Claude
computed `17 + 26 = 43`, Jev classified that upstream result as `odd`, and Claude produced
`{sum: 43, parity: "odd"}`. The ledger recorded exactly `sum`, `classify`, and `report-odd`, all
completed and uncached; scheduling provenance matched the due time. `serve --once` reported one
launch, zero failures, and zero runners left on shutdown, with no occupying execution. Both fixtures
and their temporary schedules were removed. These were one-off live checks, not part of the
repeatable smoke script, and neither tested sleeping or waking an orb.

## Layer C: actual orb lifecycle matrix — not yet run

These tests need a dedicated orb and explicit lifecycle actions. Record platform state, wall-clock
timestamps, and ledger/process observations before and after. Do not infer a pause from a quiet
terminal, or treat process restart as a substitute for platform suspension.

| Case | Test and acceptance condition |
|---|---|
| Foreground liveness | Await a workload beyond both idle thresholds without user interaction; it finishes without orb pause or progress speech |
| Unattended service | Leave a supervised scheduler, end the turn, observe actual idle pause; verify service availability after wake |
| Detached execution | Pause during an active detached workload, wake, classify whether its process survived; no false completed status or duplicate launch |
| Automation wake | A due Amp automation wakes the orb, awaits Prism, records completion, then allows normal idle pause |
| Missed occurrences | Keep the orb paused across multiple Prism due times; wake/serve produces at most one opportunity and advances the cursor |
| Persistent evidence | Stores, registry, and task cache remain usable after wake; completed tasks replay exactly |
| Changed credentials | Refresh orb secrets/processes, then run with new credentials without exposing them in snapshots or logs |
| CLI update | Update/restart the executor during managed operation; verify which owned processes restart and that reconciliation cannot duplicate work |
| Keep-alive alternative | If deliberately selected, hold/release a lease and observe both liveness and billed runtime; test loss of the lease |

Do not enable recurrent automation until its chosen wake/await path has passed. A service declaration
alone is not evidence that scheduled work will run while the orb is idle.

## Curate named workers; use the model inventory for raw choices

```bash
prism workflow workers install ./workers.json
prism workflow workers
prism workflow skill
prism workflow workers export

# Optional raw harness/model discovery:
bun run dev -- workflow refresh-harness-types
bun run dev -- workflow models --offer
bun run dev -- workflow skill --models
```

This orb's discovery returned 4 Amp dials, 27 plugin modes, and 49 catalog entries; Claude returned
9 aliases: `default`, `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `opus[1m]`, `sonnet[1m]`,
`fable[1m]`. Catalog presence and aliases are **not** verified entitlement or successful execution.

The operator curates portable named workers with descriptions and concrete configurations;
workflow authors select `workers.<name>` from `prism/refs/workers`. The normal skill embeds the
installed catalog and project SOP refs. See the [catalog format and installation contract](./workflows.md#curated-named-workers).
`models prefer` is replaced, not applied behind the catalog. Amp `worker.model` still means a
dial/plugin mode; `catalogModel` and `effort` remain separate. Curation does not change harness
capabilities or verify entitlement. All live checks above used harness defaults, not this catalog path.

Jev is a task kind, not a named harness worker. Its endpoint/model configuration uses
`TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL`; live calls need `TYPESAFE_API_KEY`. The checked live
requests returned model `jev-1.13.0`. Bind each question's subject through `instructions`; a question
ID alone is not a subject binding. High confidence is not proof of semantic correctness.

## Orchestrating orbs from workflows

Workflow tasks can dispatch to Amp's hosted orbs and to operator-declared runners directly — the
`amp-orb` and `amp-runner` workflow workers (see [workflows.md](./workflows.md#workers-and-permissions)):

```ts
worker: { worker: "amp-orb", project: "owner/repo", size: "a1.tiny", model: "low" }
worker: { worker: "amp-runner", runnerId: "macbook", runnerDir: "/Users/x/Projects/prism" }
```

One orb thread per task: repairs inside a task continue that thread; a
finished task's orb idle-pauses at $0. `threadCleanup` is not in v1 — decode
and criteria repairs need the thread after the worker returns. Catalog pins
fail closed for these workers (the pin plugin lives
in the local checkout, not the orb's) — commit a plugin mode and set `model` to its key, or use a
dial. `amp-runner` accepts catalog pins only when `runnerDir` equals the workflow's working directory.

## Operation and failure boundaries

See [workflow scheduling](./workflow-scheduling.md), [workflow semantics](./workflows.md), and
[data governance](./workflow-data-governance.md) for the contracts rather than duplicating them here.

- `.agents/setup` installs clients without authenticating them. Credentials belong in orb secrets,
  never fixture files, committed configuration, or reusable setup snapshots.
- For source-checkout tests, use `bun run dev --` in place of `prism`. Keep `HOME` for harness auth,
  but isolate `PRISM_HOME`, cwd, and `--store` with temporary directories.
- `--mock-output` replaces task dispatch, not arbitrary TypeScript side effects in the workflow.
  Only rehearse trusted, side-effect-free synthetic workflows this way.
- Resume is **restart with task-cache reuse**, not program-counter recovery or exactly-once effects.
  A cache hit does not establish that an external artifact still exists. Effects outside cached tasks
  can run again; domain idempotency remains the author's responsibility.
- The default inherited phase criterion rejects empty/trivial output; semantic evaluation requires an
  explicit evaluator. Strict schema decoding establishes shape, not truth.
- Linux has no Prism `install-service` backend; it is launchd-only. Use foreground `serve --once`, or
  supervised `serve` with an independently chosen wake/liveness mechanism.
- `workflow runs list --store <path>` already prints JSON and has no `--json` flag. `schedule list`,
  `schedule show`, and `scheduler serve` accept `--json`. Check run/task results and scheduler
  occupancy, not only launcher exit status.
- Installing a schedule is not authorization to publish, deploy, or mutate a shared service. Keep
  external side effects out of the test matrix unless a disposable target is explicitly provided.
