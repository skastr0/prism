# Prism workflows — the full DSL reference

The complete authoring surface for Prism workflows: every field of `defineTask` / `defineWorkflow` / `phase`, worker and permission semantics, model resolution precedence, finish criteria, the durable ledger, and the run CLI. The engine lives in `src/workflows.ts` and `src/workflow-*.ts`; everything below is the public contract you write against.

For the product tour, start at the [root README](../README.md#workflows-typed-task-graphs-over-real-harnesses).

- [The mental model](#the-mental-model)
- [The generated environment](#the-generated-environment)
- [defineTask](#definetask)
- [Agent refs](#agent-refs)
- [Workers and permissions](#workers-and-permissions)
- [Model resolution](#model-resolution)
- [Output schemas and decode repairs](#output-schemas-and-decode-repairs)
- [Finish criteria](#finish-criteria)
- [defineWorkflow](#defineworkflow)
- [Phases](#phases)
- [Cache and ledger](#cache-and-ledger)
- [Running and operating](#running-and-operating)
- [Testing a graph without spending tokens](#testing-a-graph-without-spending-tokens)

## The mental model

A **task** binds five things: an *agent* (a compiled Prism agent ref), a *worker* (which harness CLI executes it), a *prompt*, an *output schema* (Effect Schema the worker's final answer must decode into), and *finish criteria* (checks the decoded output must pass). A **workflow** composes tasks — statically as a list, or dynamically as an Effect program with full control flow. Every run persists to a SQLite ledger; every completed task result is cached content-addressed.

The worker is a real harness process — `claude-code`, `codex-cli`, `grok`, `kimi-code`, `opencode`, … — launched with a pinned model and permission mode, using that harness's own local installation and auth. **A live run spends real tokens on your accounts.** Validate, typecheck, and mock first; pin budgets when you dispatch.

## The generated environment

Workflows import from `prism` (the DSL) and `prism/refs` (typed refs to your compiled agents, models, skills, traits, orbits, and tools):

```ts
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
```

These imports resolve through a **generated tsconfig**, not your project's own module resolution:

- `prism refresh <plugin-path>` compiles the project and writes the refs surface (`generated/{agents,models,skills,traits,orbits,tools}.ts`) plus a workflow tsconfig under `PRISM_HOME/state/` that path-maps `prism`, `prism/refs`, and `effect`.
- `prism workflow scaffold <name>` writes a validating starter into `~/.prism/workflows/` (never inside the repo it drives) already wired to a real discovered agent ref.
- `prism workflow typecheck <file>` and `prism workflow validate <file>` use that generated environment automatically.

Workflow commands are **project-scoped**: they resolve the refs surface and run store from the current working directory's project. From a directory that was never compiled, `prism workflow catalog` and `prism workflow refs` tell you to run `prism refresh <plugin-path>` first, and `prism/refs` will not resolve. Discover what is available with:

```bash
prism workflow catalog                 # compact index of agents.* / orbits.* / models.*
prism workflow catalog --orbit forge   # one namespace
prism workflow catalog --query review  # search
prism workflow refs                    # refs surface location + freshness
```

## defineTask

```ts
const task = defineTask({
  id: "adversarial-review",              // unique within the workflow
  agent: agents.forge.securityReviewer,  // WorkflowAgentRef (see below)
  prompt: "Attack the diff on this branch. Default to refuted.",
  output: Review,                        // Effect Schema — the typed contract
  phase: "forge:review",                 // optional grouping label (set for you inside phase())
  cacheKey: "release-review-v1",         // opt into durable cross-run caching
  worker: {                              // WorkflowTaskWorkerOptions (see below)
    worker: "codex-cli",
    model: "gpt-5.6-terra",
    permission: "sandbox-read-only",
    sessionPersistence: "ephemeral",
    processTimeoutMs: 900_000,
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
| `agent` | `WorkflowAgentRef` | Which compiled Prism agent persona executes the prompt |
| `prompt` | `string` | The task brief; `phase()` may prepend contract framing |
| `output` | Effect `Schema` | The worker's final answer must decode into this — validated, not hoped |
| `phase` | `string?` | Grouping label for monitor/trace; `phase()` sets `<orbit>:<name>` |
| `cacheKey` | `string?` | Stable key for the durable task cache; bump it (`-v2`) to force re-execution |
| `worker` | `WorkflowTaskWorkerOptions?` | Worker, model, permission, timeout, retry (falls back to CLI flags) |
| `finish` | `WorkflowFinishOptions?` | Acceptance criteria and repair budgets |

`defineTask` returns the definition tagged `kind: "workflow-task"`. The output type flows through: `wf.runTask(task)` yields `Schema.Schema.Type<typeof Review>` — no casting, no JSON scraping.

## Agent refs

A `WorkflowAgentRef` pins the exact compiled agent the task runs as:

```ts
interface WorkflowAgentRef {
  kind: "agent-ref";
  plugin: string;          // e.g. "scribe"
  name: string;            // e.g. "linkedin-writer"
  description: string;
  sourceHash: string;      // content hash of the agent source
  manifestHash: string;    // hash of the compiled manifest it came from
  installs: readonly string[];  // harnesses this agent is installed for
  model?: WorkflowModelRef;     // optional agent-level modelspace ref (see Model resolution)
}
```

You almost never write one by hand — import it from `prism/refs` (`agents.<plugin>.<agentName>`, camel-cased), or copy the literal that `prism workflow catalog --ref <ref>` prints. The hashes make provenance checkable: a workflow run records exactly which compiled agent version produced each output.

Agents may also carry an agent-level modelspace ref (`agent.model`), which participates in model resolution below.

## Workers and permissions

```ts
type WorkflowWorkerId =
  | "amp-code" | "antigravity-cli" | "claude-code" | "codex-cli" | "devin"
  | "grok" | "hermes" | "kimi-code" | "opencode" | "omp";
```

```ts
worker: {
  worker?: WorkflowWorkerId;         // which harness CLI executes this task
  model?: string | WorkflowModelProfileRef;
  modelResolver?: (models: WorkflowResolvedModelTarget) => string;
  profile?: string;
  permission?: WorkflowPermissionMode;
  sessionPersistence?: "persistent" | "ephemeral"; // codex-cli only
  restrictedTools?: readonly string[];   // tool restriction list passed to the worker
  processTimeoutMs?: number;             // hard per-attempt process timeout
  retry?: { maxAttempts?: number; backoffMs?: number };
}
```

**Permission modes** (7): `legacy` · `permissive` · `restricted` · `interactive` · `sandbox-read-only` · `sandbox-workspace-write` · `full-access`. Each worker adapter maps the mode onto that harness's own sandbox/approval flags. `antigravity-cli` accepts only `legacy` / `permissive` / `full-access` — the type system enforces it.

**Retry** (executor-level, WFE-009): only *classified-transient* executor failures retry — process/idle timeout, unclassified non-zero exit. Config/load errors and cancellation-barrier outcomes never retry. `maxAttempts` counts total attempts (default 2, i.e. one retry); `backoffMs` spaces them.

**Codex session persistence.** A task pinned to `worker: "codex-cli"` may set `sessionPersistence: "ephemeral"`, which passes `codex exec --ephemeral` and prevents Codex from writing a resumable session to disk. The default is `"persistent"`. Ephemeral tasks use a fresh Codex invocation with the full original task context when Prism requests an output or finish-criterion repair; they never advertise native continuation metadata. The field is rejected for other workers.

Tasks without a `worker` fall back to the CLI: `prism workflow run --worker <id> --model <m> --permission <mode>` supplies defaults for any task that didn't pin its own.

## Model resolution

`model` resolves through an exact precedence chain (`resolveWorkflowTaskModelResolution`):

1. **Task literal** — `worker.model: "gpt-5.6-terra"` wins outright. Source: `task`.
2. **Task modelspace profile ref** — `worker.model: { kind: "model-profile-ref", plugin, modelspace, profile }` resolves the profile's target for the task's worker; the first concrete `{ model, provider?, variant? }` entry wins. No entry for that worker → `WorkflowModelResolutionError`.
3. **`modelResolver`** — a function receiving the agent's resolved model target for this worker (keyed by camel-cased model identity, e.g. `{ gpt56Terra: { model: "gpt-5.6-terra" } }`) and returning the chosen model string. The agent must have a model target for the worker.
4. **Agent modelspace profile** — the agent's own `model` ref, resolved for this worker. Source: `profile`. If the ref exists but has no entry for this worker, Prism falls back to the CLI `--model` (source: `cli-fallback`) or the harness registry's cheap-fast default (source: `default`) instead of crashing.
5. **Nothing anywhere** — resolves to the CLI `--model` if given; otherwise `undefined`, so workers that tolerate an omitted model flag (e.g. `opencode`) keep working.

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

Judge verdicts: `pass` (accept) · `continue` (not done — consumes one repair from `maxRepairs`, and its `feedback` becomes the next prompt) · `fail` (**terminal reject — no repair attempt, even with budget remaining**) · `escalate` (stop and surface). Deterministic check failures route through the repair path like `continue`: they consume budget and their `repairPrompt` drives the next round. The practical rule for judge authors: return `continue` when you want the worker to try again, `fail` when the output is unsalvageable. `goal` may be a string or a function of the evidence-selection context; `selectEvidence` narrows what the judge sees; `task` metadata (id, agent, cacheKey, worker) is available for context.

## defineWorkflow

Two shapes:

**Static** — a named list of tasks:

```ts
export default defineWorkflow({
  name: "kimi-code-smoke",
  tasks: [verifyChallenge],
});
```

**Dynamic** — a `run` function receiving the runtime, returning an Effect. This is where the full toolkit opens up:

```ts
export const workflow = defineWorkflow({
  name: "voice-council",
  run: (wf) =>
    Effect.gen(function* () {
      const settled = yield* Effect.all(
        seats.map((seat) => Effect.either(wf.runTask(councilTask(seat)))),
        { concurrency: "unbounded" },
      ).pipe(Effect.withSpan("council.fanout"));

      const reports = settled.flatMap((r) => (r._tag === "Right" ? [r.right] : []));
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
- `Effect.either(wf.runTask(t))` — isolate one arm's failure so a council survives a dead seat
- `Effect.withSpan("name")` — author-level spans that land in the recorded trace next to the engine's own
- Loops, conditionals, retries, races — ordinary Effect control flow around `runTask`

## Phases

`wf.phase(contract, fn)` scopes a stretch of a dynamic workflow under a named phase of an orbit:

```ts
const report = yield* wf.phase(
  {
    name: "review",
    orbit: "forge",
    plugin: "forge",
    agents: { builder, reviewer },       // the cast available inside this phase
    output: BuildReport,                 // default output schema for phase tasks
    criteria: [                          // phase-level finish criteria (judged)
      "Diff compiles",
      "No scope creep beyond the glyph",
    ],
    framing: {                           // composed into every task prompt
      telos: "Ship the committed glyph",
      when: "After build completes",
      coordination: "Reviewer never edits; builder never approves",
      escalation: "Stop on contract drift",
    },
  },
  (ctx) =>
    Effect.gen(function* () {
      const built = yield* ctx.task({ id: "build", agent: ctx.agents.builder, prompt: "..." });
      return yield* ctx.task({ id: "review", agent: ctx.agents.reviewer, prompt: "..." });
    }),
);
```

What the phase machinery does:

- **Framing preamble** — each `ctx.task` prompt is prefixed with `## Phase forge:review` plus the `telos` / `when` / `coordination` / `escalation` lines. Opt out per task with `brief: false`.
- **Criteria inheritance** — the phase's `criteria` become an inherited judge criterion on every task (rejecting empty/trivial output against the phase goals). Task-level `finish.criteria` are appended after it; set `finish: { inherit: false }` to drop the inherited one.
- **Defaults with overrides** — tasks default to the phase's `output` schema and `<orbit>:<name>` phase label; both can be overridden per task (`output`, `phase`).
- **Tracing** — the whole phase runs inside a span named `workflow.phase.<orbit>:<name>` with orbit/phase attributes.

`phase(runtime, contract, fn)` is also exported standalone; `wf.phase(contract, fn)` is the bound form.

## Cache and ledger

Every run persists to a per-project SQLite store (`workflows.sqlite` under `PRISM_HOME`); the store schema is versioned with in-place migrations, and a store newer than your binary refuses to open (upgrade Prism rather than corrupt it).

**Task cache.** Completed task results are stored **content-addressed**: the identity folds the scope, the `(taskId, cacheKey)` pair, and a semantic hash of what actually ran. Consequences:

- Re-running a workflow replays completed tasks from cache instantly — resume after a crash costs nothing for finished work.
- Changing a task's semantics changes its address — only that task re-executes.
- Codex `sessionPersistence` does not change the address: it controls harness-side session retention, while the completed task result remains reusable across persistent and ephemeral runs.
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
  --max-concurrent-tasks <n> \
  --task-timeout-ms <ms> --task-no-progress-ms <ms> \
  --max-wall-ms <ms> --max-tasks <n> --max-cost-usd <usd> \
  --max-prompt-bytes <bytes> \
  --store <path> \
  --detach
```

| Guard | Meaning |
|---|---|
| `--max-cost-usd` | Ceiling on observed provider cost |
| `--max-wall-ms` | Whole-workflow wall-clock ceiling |
| `--max-tasks` | Ceiling on live cache-miss dispatches |
| `--task-timeout-ms` | Default per-task process timeout |
| `--task-no-progress-ms` | Per-attempt inactivity cutoff |
| `--max-prompt-bytes` | Prompt-context size ceiling (default 262144) |
| `--max-concurrent-tasks` | Concurrency cap |

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
prism workflow typecheck <file>     # generated tsconfig + shipped declarations
prism workflow validate <file>      # loads the module, resolves each task's (worker, model)
prism workflow run <file> --mock-output mocks.json
```

`--mock-output` takes a JSON object keyed by task id; each entry stands in for that task's worker output and still flows through schema decoding and finish criteria — the full control flow of the graph, executed for free. Between `typecheck`, `validate`'s resolved-model table, and mocks, a workflow can be fully rehearsed before the first real dispatch.
