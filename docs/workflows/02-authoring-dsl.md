# 02 — Authoring DSL

The workflow is an **arbitrary Effect TypeScript program** over a small set of
typed runtime primitives. Full language freedom where it matters (control flow,
data shaping, composition), bounded by the type system at every effectful edge.

## The facade

The facade covers the expressiveness envelope of every reference system
studied. Authors who know Effect can drop below the facade freely; authors who
don't never need to.

```typescript
import { wf } from "@skastr0/prism-workflow";
import { agents } from "../.prism/generated/workflows/agents.js";

// 1. agentRun — materialize or reuse a durable AgentRun resource
const exploration = yield* wf.agentRun("explore", agents.explorer, {
  harness: "grok",
  prompt: `...`,
  output: Exploration,            // until agent I/O contracts make this inferable
  retries: 2,                     // task retries; schema-decode retries are separate
  timeoutMs: 15 * 60_000,
});

// exploration.output is the Schema-decoded value; exploration.ref is durable.

// 2. useRun — load a previously materialized AgentRun by stable key or revision
const priorBuild = yield* wf.useRun("ws1-build", PatchReport);

// 3. evidence refs — fresh session, explicit dependency on prior labor/world refs
const review = yield* wf.agentRun("ws1-review-simplicity", agents.simplicityReviewer, {
  evidenceRefs: [priorBuild.outputRef, wf.gitRange({ repo: "prism", base, head })],
  prompt: "Review this build output and Git range through the simplicity lens.",
  output: ReviewVerdict,
});

// 4. parallel — bounded concurrent execution (Effect.all with policy)
const reviews = yield* wf.parallel([taskA, taskB, taskC], { concurrency: 2 });

// 5. approve — typed human decision node (not just a gate)
const decision = yield* wf.approve("ship-decision", {
  title: "Ship release?",
  payload: { summary: patch.summary },
});
if (decision.approved) { ... }    // ApprovalDecision is a typed ledger row

// 6. fanout — dynamic N-way expansion, budget-bounded
const verdicts = yield* wf.fanout("verify", findings, (f, i) =>
  wf.agentRun(`verify-${i}`, agents.contractReviewer, { ... }),
  { maxConcurrency: 4, maxItems: 50 },
);

// 7. worktree — isolated mutation lane for write-access agent runs
const patch = yield* wf.worktree("impl", (cwd) =>
  wf.agentRun("build", agents.builder, { harness: "claude-code", cwd, ... }),
  { keep: "on-failure" },
);
```

`wf.task` may remain as a short alias for `wf.agentRun`, but the canonical name
is intentionally resource-shaped: the call returns an `AgentRun<A>`, not just
`A`. The workflow can use `run.output` as ordinary typed data while carrying
`run.ref` forward as a durable resource address.

## Rules that make replay boring

1. **Explicit resource keys, always.** Every `agentRun` / `forkRun` has a stable
   scope-local key. The key is human meaningful (`"ws1-build"`) and the
   runtime pairs it with an immutable semantic fingerprint. Duplicate keys with
   identical fingerprints return the same resource; duplicate keys with new
   fingerprints create new revisions and surface the prior revision history.
2. **Semantic fingerprints, not call-stack guesses.** The fingerprint includes
   agent ref/manifest hash, harness, model/effort, prompt hash, output schema
   hash, cwd/worktree identity, permission needs, evidence refs, and key
   version. It excludes display-only labels, phase labels, and downstream code.
3. **No ambient nondeterminism.** The program's `R` channel is
   `WorkflowRuntime | Clock | Random` and nothing else. `Clock`/`Random` are
   real Effect services for workflow code that needs reproducibility, but the
   primary replay guarantee lives at the AgentRun resource boundary.
4. **Effects only through primitives.** The runtime cannot prevent arbitrary
   `fs` access from raw TS in the dev phase (see 05 — containment posture), but
   every *agentic* effect flows through `wf.*`, which is where the gate lives.

## Typed handoffs

Phase contracts are Effect Schema structs. The decoded output of one task is an
ordinary typed value — handoff is just data flow, checked by tsc:

```typescript
const chosen = exploration.output.options.find(o => o.name === exploration.output.recommended);
//    ^ readonly { name: string; approach: string; timeToLearning: "fast"|"medium"|"slow"; ... }

const patch = yield* wf.agentRun("build", agents.builder, {
  prompt: `Approach: ${chosen.name} — ${chosen.approach}
           Assumption: ${exploration.output.assumption}`,   // tsc-checked field access
  output: PatchReport,
});
```

POC proof: mistyping `exploration.assumption` → `assumptions` produced
`TS2551 ... Did you mean 'assumption'?`; mistyping an agent key produced the
same with the fleet's real names and descriptions in the error.

## Control flow is the language

No `<Branch>`/`<Loop>` primitives. `if`, `for`, `while`, `Effect.retry`,
`Effect.repeat`, early return — all valid, all ledgered at the primitive
boundary:

```typescript
let patch = yield* build(plan);
for (let round = 1; round <= 3; round++) {
  const reviews = yield* wf.parallel(reviewers.map(reviewLens(patch)), { concurrency: 3 });
  const blockers = reviews.flatMap(r => r.output.findings.filter(f => f.severity === "blocker"));
  if (blockers.length === 0) break;
  patch = yield* wf.agentRun(`fix-${round}`, agents.builder, { prompt: fixPrompt(blockers), output: PatchReport });
}
```

## Resource reuse and cross-workflow references

`useRun` is the explicit "adopt an existing resource" primitive. It lets a new
workflow pick up durable agent work created by a prior workflow without copying
text through a prompt or depending on the prior conversation context.

```typescript
const originalBuild = yield* wf.useRun("ws1-build", PatchReport);
const exactBuild = yield* wf.useRun("ws1-build", PatchReport, { revision: "sha256:abc123..." });
```

The schema argument is not documentation. It re-decodes the stored output before
the value can enter the current workflow. A stale or incompatible resource fails
at the boundary with a typed decode error.

`agentRun` can also take evidence refs without using provider-native session
forking. This is the right shape for reviewers: fresh identity, fresh session,
explicit evidence.

```typescript
const synthesis = yield* wf.agentRun("ws1-review-synthesis", agents.orchestratorEngineer, {
  evidenceRefs: [simplicity.outputRef, reliability.outputRef],
  prompt: "Synthesize these review outputs into one action plan.",
  output: Synthesis,
});
```

Evidence refs become dependency edges in the ledger and participate in the
downstream semantic fingerprint. A changed evidence ref breaks downstream reuse.
Session lineage is separate and only applies when `forkRun` intentionally seeds,
copies, or continues provider session context.

## Session continuity (`forkRun`)

Completed AgentRuns are immutable. Forking creates a new run, never mutates the
source by default:

```typescript
const plan = yield* wf.agentRun("plan", agents.builder, { harness: "claude-code", ... });
const impl = yield* wf.forkRun("implement", plan, agents.builder, {
  forkMode: "seed",          // portable default: source output/transcript as context
  prompt: "Continue from the source plan and implement it.",
  output: PatchReport,
});
```

Per-harness mechanics live in the worker gateway capability matrix (04):
`fork: "seed" | "provider-copy" | "continue" | "none"`. `seed` is portable and
always immutable. `provider-copy` uses native fork/session-copy when a harness
has it. `continue` is mutating and requires an exclusive lock; parallel fanout
from the same source is rejected fail-closed with the remedy named.

When `forkRun` seeds or copies context from a source AgentRun, the runtime also
records pinned refs for any source output, transcript excerpt, or artifact
content injected into the new prompt. Session lineage records how the provider
session was created; refs record the data that can change the result. The two
are never substitutes.

## Workflow file anatomy

A workflow is a plain Bun TypeScript module:

```typescript
// missions/fix-flaky-tests.workflow.ts
import { wf, defineWorkflow } from "@skastr0/prism-workflow";
import { Schema } from "effect";
import { agents } from "../.prism/generated/workflows/agents.js";

export default defineWorkflow({
  name: "fix-flaky-tests",
  input: Schema.Struct({ testFilter: Schema.String }),
  run: (input) => Effect.gen(function* () {
    ...
    return { fixed, remaining };
  }),
});
```

`defineWorkflow` is a typed envelope (name, input schema, run function) — it
exists so the CLI/MCP surface can validate input, list workflows, and record
the input value; it is not a constrained IR.

## Finish checks, judges, and review phases

Workflow task completion has four distinct layers:

1. **Schema decode** is the typed output boundary. The worker response must parse
   as one JSON value and decode through the task's Effect Schema before any
   downstream workflow code sees it. Decode failures are shape failures, not
   semantic judgments.
2. **Deterministic finish criteria** are local checks over the decoded output,
   raw output, and task metadata. They are ordinary Effect functions for bounded
   invariants such as "field X mentions the requested file" or "array Y is not
   empty." When configured with `maxRepairs`, failures can feed a repair prompt
   back through the original task path.
3. **Judge criteria** are bounded evaluator definitions. A judge receives the
   task goal, decoded output, task metadata, and explicitly selected evidence.
   It does not require full transcript ingestion. Its typed verdict is
   `pass`, `continue`, `fail`, or `escalate`: `continue` feeds feedback into the
   same repair/continuation path as deterministic finish criteria, `fail` ends
   the task as failed, and `escalate` marks the run as requiring escalation.
   Judge executions are ledgered and cached separately from primary task
   outputs using the criterion definition plus bounded judge input.
4. **Review phases** are normal workflow tasks or phases with their own agents,
   prompts, evidence refs, schemas, and outputs. They are not finish criteria.
   Use review phases when another identity should inspect a broader surface or
   produce durable review findings for downstream workflow code.

```typescript
const build = wf.agentRun("build", agents.builder, {
  prompt: "Implement the change.",
  output: PatchReport,                 // schema decode
  finish: {
    maxRepairs: 1,
    criteria: [
      {
        name: "mentions validation",
        check: ({ output }) => output.validation.length > 0
          ? Effect.void
          : Effect.fail(new Error("validation evidence required")),
      },
      {
        kind: "judge",
        name: "bounded quality judge",
        goal: "Decide whether this build report is ready for review.",
        selectEvidence: ({ output }) => ({
          summary: output.summary,
          validation: output.validation,
        }),
        evaluate: ({ output, evidence }) => Effect.succeed(
          output.ready
            ? { verdict: "pass" as const }
            : { verdict: "continue" as const, feedback: "Return missing readiness evidence." },
        ),
      },
    ],
  },
});
```

## What we deliberately did not build

- **Static whole-graph preflight** — replaced by the per-dispatch gate plus
  budget ceilings. An optional static analyzer over `defineWorkflow` programs
  whose structure is statically known can come later (WS6) without changing the
  runtime.
- **Hot reload / time travel / rewind** — Smithers proves the idea is powerful,
  but Prism v1 only needs durable AgentRun resources, immutable session forks, and
  explicit reruns of edited workflow files.
- **Complex cache policy surface** — project-global durable resources are the
  default. `volatile: true` or run-scoped resources can come later when pressure
  appears.
- **JSX / reconciler authoring** — smithers' render-loop model is elegant but
  drags React in as a dependency and makes the plan an emergent value; we want
  the program to be the plan.
- **String-DSL / JSON workflow specs** — that is flare's lane (data pipelines
  with contract registries). Coding-agent workflows want a real language.
