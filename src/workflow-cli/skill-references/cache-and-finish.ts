/**
 * Reference body: the durable task cache and finish criteria.
 * Product documentation, not plugin data. No frontmatter — the loader owns the
 * skill file; this module contributes one chapter of its body.
 */

export const CACHE_AND_FINISH_REFERENCE_MARKDOWN = `# Cache and finish criteria

## The composite cache key

Every completed task result is stored content-addressed. The primary key is the pair \`(cacheKey, promptHash)\`, and \`promptHash\` is not just the prompt text — it is a semantic hash salted with the task's worker semantics:

- the worker
- the worker's JSON contract and instruction source
- the resolved model and profile
- the output schema
- the finish criteria

All of them must match for a replay. \`cacheKey\` never substitutes for \`promptHash\`. Re-running a workflow replays completed tasks instantly, so resume after a crash costs nothing for finished work; changing a task's semantics changes its address, so only that task re-executes.

\`sessionPersistence\` does not change the address. It controls harness-side session retention, while the completed task result stays reusable across persistent and ephemeral runs.

Inspect the cache:

\`\`\`bash
prism workflow cache list [--workflow <name>] [--task-id <id>] [--cache-key <key>] [--prompt-hash <hash>] [--limit <n>]
prism workflow cache show --cache-key <key> [--task-id <id>] [--prompt-hash <hash>]
\`\`\`

## No cache-bypass flag

There is deliberately no cache-bypass flag; the cache is mandatory. The sanctioned no-reuse path is a fresh \`--store <path>\`: a new SQLite ledger has no prior entries to hit. To force re-execution of one task in place, bump its \`cacheKey\` (\`"…-v2"\`) — do that only for an intentional scope change, never to churn cosmetic edits.

## Interpolation discipline

Because \`promptHash\` hashes the rendered prompt verbatim, interpolate only narrow, stable upstream fields into a downstream prompt: ids, hashes, short enums (\`build.commitSha\`, \`explore.headline\`). Never interpolate freeform upstream text — judge prose, log tails, whole objects. That guarantees cache misses on resume by construction, because the rendered string changes even when nothing semantically did.

## A cache hit is not proof of a side effect

A cache hit proves the task once ran, not that the world still reflects it. If a cached task had side effects (a commit, a written file, a registered id), verify the durable artifact still exists before depending on it.

## Finish criteria

Finish criteria gate whether a decoded task output may be accepted. They are configured under \`finish\`:

\`\`\`ts
finish: {
  maxRepairs?: number;         // criteria-repair budget, default 0
  maxDecodeRepairs?: number;   // decode-repair budget, default 2
  criteria?: WorkflowFinishCriterion<Output>[];
}
\`\`\`

Two criterion kinds.

**Deterministic** — code decides. Return \`Effect.fail\` to reject; \`repairPrompt\` re-prompts the worker. \`kind\` is optional and defaults to \`"deterministic"\`.

\`\`\`ts
{
  name: "non-ship verdicts need findings",
  check: ({ output, rawOutput, metadata }) =>
    output.verdict !== "ship" && output.findings.length === 0
      ? Effect.fail(new Error("A non-ship verdict needs findings"))
      : Effect.void,
  repairPrompt: (error, { output }) => "Name the findings that justify your verdict.",
}
\`\`\`

**Judge** — a structured verdict decides.

\`\`\`ts
{
  kind: "judge",
  name: "claims are grounded",
  goal: "Every public claim traces to a receipt in the claim ledger.",
  selectEvidence: ({ output }) => ({ claims: output.claimLedger }),
  evaluate: ({ goal, evidence, output, task }) =>
    Effect.succeed(
      evidence.claims.every((claim) => claim.receipt !== "")
        ? { verdict: "pass" }
        : { verdict: "fail", feedback: "Unreceipted claims present." },
    ),
}
\`\`\`

Judge verdicts:

| Verdict | Effect |
|---|---|
| \`pass\` | Accept. |
| \`continue\` | Not done — consumes one repair from \`maxRepairs\`; its \`feedback\` becomes the next prompt. |
| \`fail\` | **Terminal reject — no repair attempt, even with budget remaining.** |
| \`escalate\` | Stop and surface. |

The criterion context is \`{ output, rawOutput, metadata? }\`. \`goal\` may be a string or a function of the evidence-selection context; \`selectEvidence\` narrows what the judge sees; \`task\` metadata (id, cacheKey, worker) is available for context.

Deterministic check failures route through the repair path like \`continue\`: they consume budget and their \`repairPrompt\` drives the next round. The practical rule for judge authors: return \`continue\` when you want the worker to try again, \`fail\` when the output is unsalvageable.

Separately, a worker's final message must parse as JSON and decode through the \`output\` schema. Decode repairs are budgeted by \`maxDecodeRepairs\` (default 2), independently of criteria repairs. A task that exhausts its decode budget fails typed — malformed output never reaches your workflow logic.

**Finish criteria are for task-local completion** (did this task produce a valid result?), not for hiding a whole review phase. Keep independent review visible in the topology.
`;
