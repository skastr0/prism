# Prism workflows — the full DSL reference

The complete authoring surface for Prism workflows: every field of `defineTask` / `defineWorkflow` / `phase`, worker and permission semantics, model resolution precedence, finish criteria, the durable ledger, and the run CLI. The engine lives in `src/workflows.ts` and `src/workflow-*.ts`; everything below is the public contract you write against.

For the product tour, start at the [root README](../README.md#workflows-typed-task-graphs-over-real-harnesses).

- [The mental model](#the-mental-model)
- [The generated environment](#the-generated-environment)
- [defineTask](#definetask)
- [Workers and permissions](#workers-and-permissions)
- [Model resolution](#model-resolution)
- [Output schemas and decode repairs](#output-schemas-and-decode-repairs)
- [Finish criteria](#finish-criteria)
- [defineWorkflow](#defineworkflow)
- [Phases](#phases)
- [Jev tasks — TypeSafe System One decisions](#jev-tasks--typesafe-system-one-decisions)
- [Cache and ledger](#cache-and-ledger)
- [Running and operating](#running-and-operating)
- [Testing a graph without spending tokens](#testing-a-graph-without-spending-tokens)

Scheduling is a separate document: [workflow-scheduling.md](./workflow-scheduling.md).

## The mental model

A **task** binds four things: a *worker* (which harness CLI executes it), a *prompt*, an *output schema* (Effect Schema the worker's final answer must decode into), and *finish criteria* (checks the decoded output must pass). There is no agent field — agents are a standalone compile primitive (`agents/*.agent.ts` → harness agent files) that workflows do not reference. A **workflow** composes tasks — statically as a list, or dynamically as an Effect program with full control flow. Every run persists to a SQLite ledger; every completed task result is cached content-addressed.

The worker is a real harness process — `claude-code`, `codex-cli`, `grok`, `kimi-code`, `opencode`, … — launched with a pinned model and permission mode, using that harness's own local installation and auth. **A live run spends real tokens on your accounts.** Validate, typecheck, and mock first; pin budgets when you dispatch.

## The generated environment

Workflows import from `prism` (the DSL). Compiled plugins add `prism/refs` (typed sops and modelspaces). Installed harnesses add `prism/harnesses` (live model slugs):

```ts
import { defineTask, defineWorkflow } from "prism";
import { ampCodeModelSlugs } from "prism/harnesses";
```

These imports resolve through a **generated tsconfig**, not your project's own module resolution:

- `prism workflow refresh-harness-types` discovers models from local harness caches/CLIs and writes a **global** cache at `~/.prism/state/harness-types/` (not project-keyed). That file path-maps `prism/harnesses` and augments `worker.model` so plugin-free workflows typecheck against what is actually installed.
- `prism refresh <plugin-path>` is optional. When you have a plugin it writes the refs surface (`generated/{models,sops}.ts`) and path-maps `prism/refs`.
- `prism workflow scaffold <name>` writes a validating starter into `~/.prism/workflows/` (never inside the repo it drives): harness workers with a prompt and typed IO.
- `prism workflow typecheck <file>` and `prism workflow validate <file>` use that generated environment automatically.

Workflow **store and refs** are project-scoped. Harness model types are not — they follow the machine. From a directory that was never compiled, `prism/refs` will not resolve. That is fine — workflows are the flagship and plugins are optional. Discover what is available with:

```bash
prism workflow refresh-harness-types   # global live model unions (no plugin)
prism workflow models --offer          # workers, samples, stated prefs — quiz the user
# Save only the user's answer: prism workflow models prefer <worker> --model <slug>
prism workflow skill                   # embedded authoring guide (also written on scaffold)
prism workflow skill --models          # quiz skill for model preferences
prism workflow catalog                 # workers + live slug counts; plugin refs if compiled
prism workflow catalog --query opus    # searches harness models when no plugin
prism workflow refs                    # optional plugin refs location + freshness
```

## defineTask

```ts
const task = defineTask({
  id: "adversarial-review",              // unique within the workflow
  prompt: "Attack the diff on this branch. Default to refuted.",
  output: Review,                        // Effect Schema — the typed contract
  phase: "forge:review",                 // optional grouping label (set for you inside phase())
  cacheKey: "release-review-v1",         // opt into durable cross-run caching
  worker: {                              // WorkflowTaskWorkerOptions (see below)
    worker: "codex-cli",
    model: "gpt-5.6-terra",
    permission: "sandbox-read-only",
    sessionPersistence: "ephemeral",
  },
  finish: {                              // WorkflowFinishOptions (see below)
    maxRepairs: 1,
    criteria: [ /* deterministic and judge criteria */ ],
  },
});
```

Every field:

| Field | Type | Semantics |
|---|---|---|
| `id` | `string` | Task identity inside the workflow; part of the cache key fold |
| `prompt` | `string` | The task brief; `phase()` may prepend contract framing |
| `output` | Effect `Schema` | The worker's final answer must decode into this — validated, not hoped |
| `phase` | `string?` | Grouping label for monitor/trace; `phase()` sets `<sop>:<name>` |
| `cacheKey` | `string?` | Stable key for the durable task cache; bump it (`-v2`) to force re-execution |
| `worker` | `WorkflowTaskWorkerOptions?` | Worker, model, permission, timeout, retry (falls back to CLI flags) |
| `finish` | `WorkflowFinishOptions?` | Acceptance criteria and repair budgets |

`defineTask` returns the definition tagged `kind: "workflow-task"`. The output type flows through: `wf.runTask(task)` yields `Schema.Schema.Type<typeof Review>` — no casting, no JSON scraping.

## Workers and permissions

```ts
type WorkflowWorkerId =
  | "amp-code" | "antigravity-cli" | "claude-code" | "codex-cli" | "cursor"
  | "devin" | "grok" | "hermes" | "kimi-code" | "opencode" | "omp";
```

```ts
worker: {
  worker?: WorkflowWorkerId;         // which harness CLI executes this task
  model?: string | live harness slug | WorkflowModelProfileRef;
  profile?: string;
  permission?: WorkflowPermissionMode;
  sessionPersistence?: "persistent" | "ephemeral"; // claude-code | codex-cli | omp
  restrictedTools?: readonly string[];   // tool restriction list passed to the worker
  retry?: { maxAttempts?: number; backoffMs?: number };
}
```

**Permission modes** (7): `legacy` · `permissive` · `restricted` · `interactive` · `sandbox-read-only` · `sandbox-workspace-write` · `full-access`. Each worker adapter maps the mode onto that harness's own flags. The type is per-worker: Codex may use `sandbox-read-only`; Claude, Grok, Amp, and OMP may not. `prism workflow validate` fails closed with the same remediation as run. Do not copy a Codex sandbox pin onto another harness.

**Retry** (executor-level, WFE-009): only *classified-transient* executor failures retry — an unclassified non-zero worker exit. Config/load errors and cancellation-barrier outcomes never retry. `maxAttempts` counts total attempts (default 2, i.e. one retry); `backoffMs` spaces them.

**Session persistence.** A task pinned to a worker with a native no-save mode may set `sessionPersistence: "ephemeral"`. The default is `"persistent"`.

| Worker | Native ephemeral flag |
|---|---|
| `claude-code` | `--no-session-persistence` |
| `codex-cli` | `codex exec --ephemeral` |
| `omp` | `--no-session` |

Ephemeral tasks use a fresh invocation with the full original task context when Prism requests an output or finish-criterion repair; they never advertise native continuation metadata. The field is rejected for workers without a native no-save mode.

Tasks without a `worker` fall back to the CLI: `prism workflow run --worker <id> --model <m> --permission <mode>` supplies defaults for any task that didn't pin its own.

## Model resolution

`model` resolves through an exact precedence chain (`resolveWorkflowTaskModelResolution`):

1. **Task literal** — `worker.model: "gpt-5.6-terra"` wins outright. Source: `task`. After `prism workflow refresh-harness-types`, that string is checked against the installed harness's discovered slugs. OMP pins are `provider/id` selectors from `omp models --json` (example: `ollama-cloud/glm-5.3-flash`); unpinned OMP tasks prefer `~/.omp/agent/config.yml` `modelRoles.default` with the `:thinking` suffix stripped. `opencode-go/*` is Console Go and 400s in workflow `--print` (`MissingSessionID`). Amp inventories three surfaces: the `--mode` dial (`low | medium | high | ultra`), plugin mode keys (both valid `worker.model` / `--mode` values), and the curated `provider/model` catalog from `amp plugins show-agent-options --json`. Catalog slugs are `worker.catalogModel` (`AmpCodeCatalogSlug`); reasoning effort is `worker.effort` (`AmpCodeEffort`). Amp has no `--model` flag, so Prism pins catalog/effort through a one-shot project plugin mode when no existing plugin mode already binds that slug. Run metadata reports `model` as the catalog slug (or dial), plus `ampMode`, `catalogModel`, and `effort` — never the transport key `prism-pin`. A dial in `worker.model` can `extends` that pin; a plugin mode key cannot combine with `catalogModel` / `effort`. `prism workflow validate` fail-closes when the snapshot lists the catalog row and `worker.effort` is not on that row. Modelspaces stay optional policy, not the inventory.
2. **Task modelspace profile ref** — `worker.model: { kind: "model-profile-ref", plugin, modelspace, profile }` resolves the profile's target for the task's worker; the first concrete `{ model, provider?, variant? }` entry wins. No entry for that worker → `WorkflowModelResolutionError`.
3. **Nothing anywhere** — resolves to the CLI `--model` if given; otherwise `undefined`. Spawn omits the harness model flag so the user's harness default stays. Do not invent a Prism default. Stated preferences live in `~/.prism/state/workflow-model-preferences.json` (`prism workflow models --offer` / `prefer`) and are copied into `worker.model` by the authoring agent — they are not applied at run time.

Resolution can carry a **provider** (harness-side inference provider, e.g. hermes `--provider xai-oauth`) and a **variant** (harness-bound model variant such as Codex reasoning effort). `prism workflow validate <file>` prints each task's resolved `(worker, model)` before anything dispatches — read it.

## Output schemas and decode repairs

`output` is any Effect Schema (`Schema.Struct`, unions, literals, refinements — the full language). The worker's final message must parse as JSON and decode through the schema.

When it doesn't: the runner sends a **decode repair** prompt describing the failure and asks the worker to re-emit. Decode repairs are budgeted by `finish.maxDecodeRepairs` (default **2**), independently from criteria repairs. A task that exhausts its decode budget fails typed — malformed output never reaches your workflow logic.

## Finish criteria

```ts
finish: {
  maxRepairs?: number;         // criteria-repair budget, default 0
  maxDecodeRepairs?: number;   // decode-repair budget, default 2
  criteria?: WorkflowFinishCriterion<Output>[];
}
```

Two criterion kinds:

**Deterministic** — code decides:

```ts
{
  kind: "deterministic",             // optional; deterministic is the default kind
  name: "non-ship verdicts need findings",
  check: ({ output, rawOutput, metadata }) =>
    output.verdict !== "ship" && output.findings.length === 0
      ? Effect.fail(new Error("A non-ship verdict needs findings"))
      : Effect.void,
  repairPrompt: (error, { output }) =>
    "Name the findings that justify your verdict.",
}
```

**Judge** — a structured verdict decides:

```ts
{
  kind: "judge",
  name: "claims are grounded",
  goal: "Every public claim traces to a receipt in the claim ledger.",
  selectEvidence: ({ output }) => ({ claims: output.claimLedger }),
  evaluate: ({ goal, evidence, output, task }) =>
    Effect.succeed(
      evidence.claims.every((c) => c.receipt !== "")
        ? { verdict: "pass" }
        : { verdict: "fail", feedback: "Unreceipted claims present." },
    ),
}
```

Judge verdicts: `pass` (accept) · `continue` (not done — consumes one repair from `maxRepairs`, and its `feedback` becomes the next prompt) · `fail` (**terminal reject — no repair attempt, even with budget remaining**) · `escalate` (stop and surface). Deterministic check failures route through the repair path like `continue`: they consume budget and their `repairPrompt` drives the next round. The practical rule for judge authors: return `continue` when you want the worker to try again, `fail` when the output is unsalvageable. `goal` may be a string or a function of the evidence-selection context; `selectEvidence` narrows what the judge sees; `task` metadata (id, cacheKey, worker) is available for context.

## defineWorkflow

Two shapes:

**Static** — a named list of tasks:

```ts
export default defineWorkflow({
  name: "kimi-code-smoke",
  tasks: [verifyChallenge],
});
```

Either shape may also declare an inert `schedule` policy. Declaring it registers nothing;
`prism workflow schedule install <file>` is the only thing that activates a schedule. See
[workflow-scheduling.md](./workflow-scheduling.md).

```ts
export default defineWorkflow({
  name: "inbox-router",
  schedule: { cron: "*/10 * * * *", timezone: "America/Sao_Paulo", overlap: "skip", missedRuns: "skip" },
  run: (wf) => /* Effect program */,
});
```

**Dynamic** — a `run` function receiving the runtime, returning an Effect. This is where the full toolkit opens up:

```ts
export const workflow = defineWorkflow({
  name: "voice-council",
  run: (wf) =>
    Effect.gen(function* () {
      const settled = yield* Effect.all(
        seats.map((seat) => Effect.result(wf.runTask(councilTask(seat)))),
        { concurrency: "unbounded" },
      ).pipe(Effect.withSpan("council.fanout"));

      const reports = settled.flatMap((r) => (r._tag === "Success" ? [r.success] : []));
      return yield* wf.runTask(synthesisTask(reports));
    }),
});
```

The runtime surface:

```ts
interface WorkflowRuntime {
  runTask: (task) => Effect<TaskOutput, WorkflowRuntimeError>;
  phase:   (contract, fn) => Effect<Result, Err | WorkflowRuntimeError>;
}
```

Composition is plain Effect — everything composes the way Effect always does:

- `Effect.all([...], { concurrency })` — bounded or unbounded fan-out
- `Effect.result(wf.runTask(t))` — isolate one arm's failure so a council survives a dead seat
- `Effect.withSpan("name")` — author-level spans that land in the recorded trace next to the engine's own
- Loops, conditionals, retries, races — ordinary Effect control flow around `runTask`

## Phases

`wf.phase(contract, fn)` scopes a stretch of a dynamic workflow under a named phase of a SOP. The generated `sops.<plugin>.<sop>.phases.<phase>` value from `prism/refs/sops` satisfies the contract directly:

```ts
import { sops } from "prism/refs/sops";

const report = yield* wf.phase(
  sops.beacon.beacon.phases.review,
  (ctx) =>
    Effect.gen(function* () {
      const built = yield* ctx.task({ id: "build", prompt: "..." });
      return yield* ctx.task({ id: "review", prompt: "..." });
    }),
);
```

An inline contract may override the phase's typed `input`/`output`, add `criteria`, and set `framing` (`purpose`, `when`, `escalation`).

What the phase machinery does:

- **Framing preamble** — each `ctx.task` prompt is prefixed with `## Phase beacon:review` plus the phase's `purpose` / `when` / `escalation` lines. Opt out per task with `brief: false`.
- **Criteria inheritance** — the phase's `criteria` become an inherited judge criterion on every task (rejecting empty/trivial output against the phase goals). Task-level `finish.criteria` are appended after it; set `finish: { inherit: false }` to drop the inherited one.
- **Defaults with overrides** — tasks default to the phase's `output` schema and `<sop>:<name>` phase label; both can be overridden per task (`output`, `phase`).
- **Tracing** — the whole phase runs inside a span named `workflow.phase.<sop>:<name>` with sop/phase attributes.

`phase(runtime, contract, fn)` is also exported standalone; `wf.phase(contract, fn)` is the bound form.

## Jev tasks — TypeSafe System One decisions

A `jev()` task is a decision, not a worker dispatch: no prompt, no worker, no repair loop. It issues **one** [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one) request — a shared `state` plus many `questions` — and returns one typed answer per question id, with confidence and full probability distributions. The batching doctrine is the point: bundle every item into the state and every question into the same request instead of fanning out per item or per question.

```ts
import { jev } from "prism";

const triage = jev({
  id: "triage-tabs",
  cacheKey: "tab-triage-v1",
  state: {
    tabs: [
      { id: "t1", title: "Effect Schema v4 — README", note: "docs tab, referenced twice today" },
      { id: "t2", title: "github.com/skastr0/prism/pull/41", note: "open PR awaiting my review" },
    ],
  },
  questions: {
    // The question id does NOT bind the question to a state item — pin the
    // subject in instructions (observed: unbound questions return flat
    // guesses; bound questions answer at confidence 1.0).
    t1_route: {
      type: "choice",
      instructions: "About state item t1 ('Effect Schema v4 — README')",
      criteria: { keep: "actively needed this week", park: "reference for later", close: null },
    },
    t2_route: {
      type: "choice",
      instructions: "About state item t2 ('…prism/pull/41')",
      criteria: { keep: "actively needed this week", park: "reference for later", close: null },
    },
    actionable_count: {
      type: "score",
      instructions: "Across ALL tabs in state, how many need concrete action this week?",
      criteria: ["none", "one or two", "three or more"],
    },
    any_credential_risk: {
      type: "noul",
      instructions: "Is any tab an authenticated console that should not linger open?",
      criteria: { true: "at least one authenticated console", false: "none" },
    },
  },
});
```

A complete, rehearsed example (with `--mock-output` answers) ships at
[`examples/prism-harness-qa/workflows/jev-routing.workflow.ts`](../examples/prism-harness-qa/workflows/jev-routing.workflow.ts).

The contract:

- **State** is a single *entry*: a string, a JSON object/array, or `null`. A bare number/boolean entry is rejected at validation (serialize it: `"3"`), while numbers and booleans nested inside an object/array entry are fine. The same entry rule applies to question `instructions` and `criteria` descriptions.
- **Questions** — `choice` (`criteria`: label → description, `null` allowed), `score` (ordered rubric array, 2+ levels), `noul` (yes/no presence; needs `criteria` `{true?, false?}` or `instructions`). Optional per-question `instructions` and a per-task `model` / `timeoutMs`.
- **Answers** are keyed by your question ids. `choice` → `{choice, confidence, probabilities}` with probabilities covering exactly your labels; `score` → `{score, confidence, legend, probabilities}` where `score` is an EXPECTED score between 0 and (levels − 1) that may fall between integer levels (threshold `probabilities` for a discrete verdict) and `legend` echoes your criteria verbatim; `noul` → `{noul}` (0–1, read as P(true)).
- **Budget** — a request targets ~28k estimated tokens (state + questions, ~4 chars/token); over-budget requests fail pre-flight with a "split into chunks" hint. Shard the **state** into sequential jev tasks with the same questions and merge answers — never split one logical question across requests. `WORKFLOW_JEV_CONCURRENCY` (default 32) caps concurrent Jev calls per run.
- **Caching** — a jev task's identity hash covers the endpoint, model, state, questions, and result-contract version, so cache hits and resume replay are exact; change anything and only that task re-executes.
- **Failures** — surfaced as typed `JevError` kinds: `configuration` (missing/invalid `TYPESAFE_API_KEY`), `request` (validation or API 400/422), `authentication` / `permission` (API 401/403 — check or rotate the key), `rate-limit` (API 429, carries `retryAfterMs` when sent), `timeout` / `connection` (transport, after SDK retries), `http` (any other non-2xx, including exhausted 5xx), `protocol` (the response violated the result contract — extra/missing answer keys or labels fail strict decode, nothing is silently stripped). Error messages are scrubbed of the configured API key even when an upstream diagnostic echoes it back. Jev tasks have no judge criteria and no decode-repair loop: a contract mismatch is terminal for that task.
- **Phases** — inside `wf.phase`, use `ctx.jev({ id, questions, state, ... })`; the phase's typed `input` decodes the state once before the task is built.

Requires `TYPESAFE_API_KEY` in the environment (`TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL` override the endpoint and default model). The same execution path is available ad hoc — `prism jev ask --input '{"state": …, "questions": …}' [--timeout-ms n] [--json-errors]` (structured one-line error records on stderr for programmatic callers) — and to agents via the `jev/systemone_ask` tool in the `jev` plugin; all three share the one implementation.

## Cache and ledger

Every run persists to a per-project SQLite store (`workflows.sqlite` under `PRISM_HOME`); the store schema is versioned with in-place migrations, and a store newer than your binary refuses to open (upgrade Prism rather than corrupt it).

**Task cache.** Completed task results are stored **content-addressed**: the identity folds the scope, the `(taskId, cacheKey)` pair, and a semantic hash of what actually ran. Consequences:

- Re-running a workflow replays completed tasks from cache instantly — resume after a crash costs nothing for finished work.
- Changing a task's semantics changes its address — only that task re-executes.
- `sessionPersistence` does not change the address: it controls harness-side session retention, while the completed task result remains reusable across persistent and ephemeral runs.
- The cache is durable across runs. To force a fresh result, bump the `cacheKey` (`"…-v2"`); for full isolation, use a fresh store (`--store <path>`) — there is deliberately no cache-bypass flag.

Inspect it:

```bash
prism workflow cache list
prism workflow cache show
```

## Running and operating

```bash
prism workflow run <file> \
  --worker <id> --model <m> --permission <mode> \   # fallbacks for tasks that didn't pin
  --store <path> \
  --detach
```

**There are no runtime limits, and no flags to set them.** A task is a long-running
agent: Prism does not cap its runtime, its output size, its prompt size, the
run's wall clock, its task count, or its cost — and there is no environment
variable that reintroduces a cap. Scope belongs in the prompt, the model, and
the graph; not in a number the runner guessed.

Live-run control is behavioural, not numeric:

| Want to | Do |
|---|---|
| stop a run now | `prism workflow runs stop <id>` (terminates the runner's whole process group) |
| see what it's doing | `prism workflow runs events\|show\|trace <id>`, or `prism workflow monitor` |
| bound the spend | choose the model and the number of tasks when you author the graph |

Task concurrency is internal scheduler pacing sized to the machine
(`max(4, min(16, cores - 2))`): excess live tasks queue and run as slots free, so
it delays work and never fails it.

`--detach` starts a detached background runner and prints a run id once the run is durably registered. Recover and operate through the ledger:

```bash
prism workflow runs list                          # newest first (this project's store)
prism workflow runs list --all [--hours n]        # every registered store on the machine
prism workflow runs show <runId>                  # task history for one run
prism workflow runs summary <runId>               # compact execution evidence
prism workflow runs summary --all                 # machine-wide workflow x status x cause rollup
prism workflow runs events <runId>                # append-only event stream
prism workflow runs trace <runId> [--otlp <url>]  # span tree; optionally export OTLP to a collector
prism workflow runs wait <runId>                  # block until terminal
prism workflow runs stop <runId>                  # stop before more tasks start
prism workflow runs update <runId> <file>         # stop + start an updated detached run, same store/cache
prism workflow runs resume <runId> <file>         # stop if running, re-run — completed tasks replay from cache
prism workflow runs inspect <runId>               # ledger row counts, sidecar, schema, permissions
prism workflow runs export <runId>                # redacted JSON evidence bundle
prism workflow runs delete <runId> / prune        # lifecycle hygiene
prism workflow monitor                            # live run monitor TUI
```

Traces interleave engine spans (task attempts, repairs, cache hits) with your own `Effect.withSpan` spans and phase spans — one tree, exportable to any OTLP collector.

## Testing a graph without spending tokens

```bash
prism workflow refresh-harness-types   # optional: live worker.model unions, no plugin
prism workflow models --worker cursor --query opus
prism workflow typecheck <file>        # generated tsconfig + shipped declarations
prism workflow validate <file>         # loads the module, resolves each task's (worker, model)
prism workflow run <file> --mock-output mocks.json
```

`--mock-output` takes a JSON object keyed by task id; each entry stands in for that task's worker output and still flows through schema decoding and finish criteria — the full control flow of the graph, executed for free. Between `typecheck`, `validate`'s resolved-model table, and mocks, a workflow can be fully rehearsed before the first real dispatch.
