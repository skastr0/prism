/**
 * Reference body: reading and operating a workflow run.
 * Product documentation, not plugin data. No frontmatter — the loader owns the
 * skill file; this module contributes one chapter of its body.
 */

export const OBSERVABILITY_REFERENCE_MARKDOWN = `# Reading a run

Everything below reads the run ledger. None of it needs the process that ran the workflow to still be alive.

The ledger is a per-project SQLite store (\`workflows.sqlite\` under \`PRISM_HOME\`), selected with \`--store <path>\`. The store schema is versioned with in-place migrations, and a store newer than your binary refuses to open — upgrade Prism rather than corrupt it.

\`\`\`bash
prism workflow runs list                          # newest first, this project's store
prism workflow runs list --all [--hours n | --since <when>]   # every registered store on the machine
prism workflow runs show <runId>                  # task history for one run
prism workflow runs summary <runId>               # compact execution evidence
prism workflow runs summary --all [--hours n | --since <when>]  # machine-wide workflow x status x cause rollup
prism workflow runs events <runId>                # append-only event stream
prism workflow runs trace <runId> [--otlp <url>]  # span tree; optionally export OTLP
prism workflow runs wait <runId>                  # block until terminal
prism workflow runs stop <runId>                  # stop before more tasks start
prism workflow runs resume <runId> <file>         # stop if running, re-run — completed tasks replay from cache
prism workflow monitor                            # live run monitor TUI
\`\`\`

Also on \`runs\`: \`inspect <runId>\` (ledger row counts, sidecar, schema, store file permissions), \`export <runId>\` (centrally redacted JSON evidence bundle), \`delete <runId>\`, and \`prune\` (terminal runs and cache entries older than the bounded 30-day default).

Output shapes: \`list\`, \`show\`, and \`events\` print JSON; \`summary\` prints a compact human block or \`--json\`; \`trace\` prints the human span tree, with \`--json\` for raw span records and \`--min-ms <n>\` to hide short finished spans. \`events\` supports \`--follow\` (NDJSON until terminal), \`--after-sequence\`, \`--limit\`, \`--timeout-ms\`, and \`--interval-ms\`. Most read commands accept \`--fail-stale-after-ms <ms>\` to mark running runs older than that as failed before reading.

\`show\` and \`resume\` resolve a run across every registered store when \`--store\` is omitted, so a run started from another cwd or another store still resolves.

## The machine-wide view

Every store a workflow command touches registers itself in a machine-global registry under \`~/.prism/state/\`. \`--all\` ignores \`--store\` and reads every registered store; \`--hours <n>\` and \`--since <when>\` bound the window, where \`--since\` takes an ISO date/time or a relative duration (\`24h\`, \`7d\`, \`30m\`).

\`prism workflow runs summary --all\` is the standing daily-review surface: a workflow × status × cause rollup across every registered store, in one command, without picking a store or a run id first. Make it the first move of a review, then drill into a single run's \`summary\`, \`events\`, or \`trace\`.

## \`wait\` is the scriptable gate

\`prism workflow runs wait <runId>\` blocks until the run reaches a terminal status and exits non-zero unless the run status is \`completed\` **and** every task status is \`completed\`. Script around \`wait\`'s exit code instead of polling \`show\`.

**A run's top-level \`completed\` status is not proof every task inside succeeded.** Fault isolation lets the author's \`Effect\` program recover from a failed task — retry it, branch around it, degrade gracefully — so a run can finish \`completed\` while carrying one or more failed tasks. Per-task status in \`summary\`/\`show\` is the ground truth for any task-level claim; the run's top-level status alone is not. \`wait\`'s exit code already applies this rule.

## Traces

Every persisted run records an OpenTelemetry-shaped span tree into its own store, with no external infrastructure:

\`\`\`
workflow.program
└─ <author spans>                     Effect.withSpan / Effect.fn
   └─ workflow.phase.<sop>:<name>     phase-bound tasks
      └─ workflow.task                one per task (attribute task.cached when replayed)
         ├─ task.executor             one per attempt, annotated with adapter/model/session
         └─ task.judge                one per judge evaluation, annotated with the verdict
\`\`\`

A cached task shows \`cached\` and has no executor span. A running run is traceable live; a killed run keeps its partial trace.

Author-side spans are native Effect tracing. In a dynamic workflow, \`Effect.withSpan("phase.research")\` (or any \`Effect.fn\`) lands in the same tree and parents the tasks started inside it:

\`\`\`ts
run: (wf) =>
  Effect.gen(function* () {
    const plan = yield* wf.runTask(planTask).pipe(Effect.withSpan("phase.plan"));
    return yield* Effect.all(
      arms.map((arm) => wf.runTask(arm)),
      { concurrency: 4 },
    ).pipe(Effect.withSpan("phase.fanout"));
  }),
\`\`\`

\`prism workflow runs trace <runId> --otlp http://localhost:4318/v1/traces\` POSTs the trace as OTLP/HTTP JSON to any collector (Jaeger, Grafana Tempo, Honeycomb, …) after the fact. The SQLite store stays the source of truth.

## Stop, edit, resume

\`\`\`bash
prism workflow runs stop <runId> --store <path>          # cooperative stop before more tasks start
# edit the workflow file — fix the task(s) that needed correcting
prism workflow run <file> --store <path>                 # foreground: cached tasks replay, the rest run
# or detached:
prism workflow runs resume <runId> <file> --store <path> # stop-if-running, then a new detached run, same store
\`\`\`

\`resume\` takes the same options as \`runs update\` (\`--worker\`, \`--model\`, \`--permission\`, \`--mock-output\`). Only tasks whose inputs changed re-execute; the content-addressed cache replays the rest. Edit only the tasks you intend to re-run: changing a task's \`cacheKey\`, prompt, worker, or model invalidates that task's cache entry too, while untouched tasks replay for free.
`;
