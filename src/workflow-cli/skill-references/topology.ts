/**
 * Reference body: composition topologies for workflow graphs.
 * Product documentation, not plugin data. No frontmatter — the loader owns the
 * skill file; this module contributes one chapter of its body.
 */

export const TOPOLOGY_REFERENCE_MARKDOWN = `# Composition topologies

Prism is Effect. \`wf.runTask(task)\` yields the task's typed output, so the graph is ordinary control flow: \`Effect.all\`, loops, conditionals, retries, races. Workflow files live at \`~/.prism/workflows/<name>.workflow.ts\`, never inside the repo they drive — tasks reference their target repo by absolute path.

## Council → fusion

Same brief across several harnesses in parallel, then one orchestrator fuses the typed lenses. Diversity of harness is the value.

\`\`\`ts
const lens = (id: string, worker: WorkflowWorkerId) =>
  defineTask({
    id,
    prompt: \`Speak from the strengths of the \${worker} harness; set worker="\${worker}".\`,
    output: Lens,
    cacheKey: \`council-\${worker}-v1\`,
    worker: { worker },
  });

export const workflow = defineWorkflow({
  name: "council",
  run: (wf) =>
    Effect.gen(function* () {
      const lenses = yield* Effect.all(
        [lens("claude", "claude-code"), lens("grok", "grok"), lens("codex", "codex-cli")].map(
          (task) => wf.runTask(task),
        ),
        { concurrency: "unbounded" },
      );
      return yield* wf.runTask(
        defineTask({
          id: "synthesize",
          prompt: ["Fuse these lenses into one verdict:", JSON.stringify(lenses, null, 2)].join("\\n"),
          output: Synthesis,
          cacheKey: "council-synthesis-v1",
          worker: { worker: "claude-code" },
        }),
      );
    }),
});
\`\`\`

## Pipeline

Chain \`yield* wf.runTask\` so each task consumes the prior's typed output. Inserting a task is a graph edit, not a prompt edit, and the cache replays every unchanged stage.

## Build → QA gate → review → synthesize

The highest-value shape: a build task makes a change and returns a durable artifact; a deterministic QA task runs tests and yields green only if they pass; a data-driven review fan-out reviews independently; an orchestrator synthesizes ship / return-to-build / block.

\`\`\`ts
run: (wf) =>
  Effect.gen(function* () {
    // build returns a durable artifact: { commitSha, changedFiles }
    const build = yield* wf.runTask(buildTask);

    // deterministic QA gate — reject and re-prompt until green
    const qa = yield* wf.runTask(
      defineTask({
        id: "qa",
        prompt: [
          "Run the validation commands and report pass/fail with the failing output.",
          \`commit: \${build.commitSha}\`,
          \`commands: \${JSON.stringify(["bun test", "bun run typecheck"])}\`,
        ].join("\\n"),
        output: QaReport,
        finish: {
          criteria: [
            {
              name: "green",
              check: ({ output }) =>
                output.pass ? Effect.void : Effect.fail(new Error("validation is not green")),
              repairPrompt: () => "Fix the failing checks, then re-run and report again.",
            },
          ],
        },
        cacheKey: "delivery-qa-v1",
        worker: { worker: "claude-code" },
      }),
    );
    if (!qa.pass) return { verdict: "return-to-build", build, qa };

    // review lenses — derived from an authored array, fanned out in parallel
    const reviews = yield* Effect.all(
      reviewLenses.map(({ id, lens }) =>
        wf.runTask(
          defineTask({
            id: \`review-\${id}\`,
            prompt: \`Lens: \${lens}\\nReview commit \${build.commitSha}.\`,
            output: ReviewFinding,
            cacheKey: \`delivery-review-\${id}-v1\`,
            worker: { worker: "codex-cli" },
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );

    return yield* wf.runTask(synthesisTask(build, qa, reviews));
  }),
\`\`\`

### The data-driven review-lens pattern

Never hand-pick a fixed reviewer array inline. Derive the fan-out from an authored array, so adding a lens means adding a row, not editing the loop:

\`\`\`ts
const reviewLenses: ReadonlyArray<{ readonly id: string; readonly lens: string }> = [
  { id: "contract", lens: "Does the change honor its typed contract?" },
  { id: "security", lens: "Any injectable input or secret exposure?" },
  { id: "simplicity", lens: "Could this be materially simpler?" },
];
\`\`\`

Both forms are the same shape — an authored array of \`{ id, lens }\` rows mapped into tasks and fanned out with \`Effect.all\`. Inside a bound SOP phase, map through \`ctx.task\` so every lens inherits the phase's framing, acceptance criteria, and output schema; ad hoc, map through \`wf.runTask\` with a workflow-local output schema. The array is the data; the fan-out code never changes when the array does.

## Adversarial verify

Pair a cheap doer with an independent reviewer on a **different, stronger** worker, or express the check as a \`judge\` finish criterion. Independence is the point: a reviewer on the same worker that produced the draft inherits its blind spots.

\`\`\`ts
const draft = yield* wf.runTask(doerTask);
const verdict = yield* wf.runTask(
  defineTask({
    id: "verify",
    prompt: \`Attack this draft. Default to refuted.\\n\${JSON.stringify(draft)}\`,
    output: Verdict,
    cacheKey: "verify-v1",
    worker: { worker: "claude-code" }, // pin the strongest model from the model offer
  }),
);
\`\`\`

## Loop until

A \`while\`/\`for\` in the dynamic \`run\`, accumulating toward a target:

\`\`\`ts
run: (wf) =>
  Effect.gen(function* () {
    let round = yield* wf.runTask(firstAttempt);
    for (let attempt = 1; attempt < 3 && !round.pass; attempt++) {
      round = yield* wf.runTask(retryTask(round));
    }
    return round;
  }),
\`\`\`

## Mock-first authoring

Author the graph, then rehearse the whole control flow for free. \`--mock-output\` takes a JSON object keyed by task id; each entry stands in for that task's worker output and still flows through schema decoding and finish criteria.

\`\`\`bash
prism workflow typecheck ~/.prism/workflows/council.workflow.ts
prism workflow validate  ~/.prism/workflows/council.workflow.ts --table
prism workflow run       ~/.prism/workflows/council.workflow.ts --mock-output mocks.json
\`\`\`

## Fan-out: fail-fast vs error-tolerant

\`Effect.all\` is **fail-fast**: one arm's failure aborts the whole block and the sibling results are lost. For a council or a review fan-out that must collect partial results, settle each arm instead:

\`\`\`ts
import { Effect, Result } from "effect";

// fail-fast — one dead seat sinks the council
const lenses = yield* Effect.all(arms.map((arm) => wf.runTask(arm)), { concurrency: "unbounded" });

// error-tolerant — every arm's outcome survives
const settled = yield* Effect.all(
  arms.map((arm) => Effect.result(wf.runTask(arm))),
  { concurrency: "unbounded" },
);
const lenses = settled.flatMap((outcome) =>
  Result.isSuccess(outcome) ? [outcome.success] : [],
);
\`\`\`

\`Effect.either\` does not exist in this Effect build; the error-tolerant combinator is \`Effect.result\`, which yields a \`Result.Result\` you inspect with \`Result.isSuccess\` / \`Result.isFailure\`.

## Side-effecting tasks

When a task changes the world, define its durable handoff artifact — a commit sha, a written path, a registered id — and return it in the typed output. Reviewers inspect the explicit artifact, not an ambient dirty tree. For builds: the builder makes an **atomic commit for the work unit**, staging only its own changes (never \`git add -A\`), and returns the commit sha plus the paths actually changed. A builder that cannot complete returns a typed \`blocked\`/\`escalate\` result — never a fabricated "done".

A cache hit does not prove the side effect still holds; verify the durable artifact before depending on it.

## Multiple workers in one checkout

Prism workflows do not use Git worktrees. Plan concurrent repository work by declaring ownership and dependencies in the graph:

- Run read-only tasks in parallel.
- Run writers in parallel only when each task owns an explicit, disjoint set of paths. Put those paths in the task prompt and require the result to return the commit sha plus the paths actually changed.
- Sequence tasks that may touch the same path or whose edits are tightly coupled. The downstream task starts from the upstream task's atomic commit — the commit is the integration boundary.
- Every writer checks the live shared checkout before editing, preserves foreign changes, stages only its assigned paths, and never uses \`git add -A\`.
- If the declared scopes overlap unexpectedly, the task stops and returns a typed \`blocked\`/\`escalate\` result. It does not create a worktree, hide the collision, or commit another lane's changes.

This is an authoring contract, not a global repository lock. A blanket single-writer lane throws away safe parallelism; unscoped parallel writers make the checkout nondeterministic.

## Choosing the worker by validation cost

Pick each task's worker and model by how cheaply its output can be validated:

- **Strong deterministic check** (tests, typecheck, schema, exact match) → a cheap worker plus a deterministic finish criterion. Fan out widely.
- **Partial check** (structured extraction, summaries) → the default workhorse.
- **Taste / expensive-to-validate** (planning, synthesis, adversarial review) → the strongest model. Spend concentrates at the two ends — plan and final judgement — not the validatable middle.

The worker set is \`claude-code\`, \`opencode\`, \`hermes\`, \`codex-cli\`, \`antigravity-cli\`, \`kimi-code\`, \`amp-code\`, \`amp-orb\`, \`amp-runner\`, \`cursor\`, \`omp\`, \`grok\`, \`devin\`. Prefer an installed named worker when the catalog has one that fits (\`prism workflow workers\`; descriptions guide selection). Otherwise compose a raw pin explicitly: slugs come from \`prism workflow models\`, and a raw \`worker: { worker, model, ... }\` is written into the workflow source by the authoring agent — never applied at run time. An unpinned worker omits the harness \`--model\` flag, so the user's harness default stays in force.

Place a task by where its code must run as well as by cost: \`amp-orb\` for isolated work in a hosted orb on a project checkout (results return as JSON; code returns only as a pushed branch), \`amp-runner\` for work in an operator machine's own checkout. Pin those targets in named workers (\`project\` for an orb, \`runnerId\` + \`runnerDir\` for a runner) so tasks select them by description. Live runner ids and their served directories come from \`prism workflow refresh-harness-types --discover-amp-runners\` (one small Amp turn, thread deleted); validation fails closed on an unknown runner or an unserved directory.
`;
