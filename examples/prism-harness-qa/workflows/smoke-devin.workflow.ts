/**
 * Devin CLI live smoke + dual self-review of Prism's Devin integration.
 *
 * Spawns two Devin workers (SWE-1.7) that each open one primary source file
 * and return structured review JSON. No MCP challenge proof (Devin PR1 does
 * not lower canonical tools).
 *
 * Prefer `--max-concurrent-tasks 1`: concurrent dual local Devin sessions were
 * flaky under shared herdr hooks / session load (timeouts). Sequential is the
 * reliable production shape for this harness today.
 *
 * Live proof (prism-dev, sequential dual, both completed ship):
 *   runId  (from /tmp/devin-static-dual.log) — both tasks ~20s, sessions
 *   mesquite-duckling (lowerer) + efficient-enquiry (worker).
 *
 * Run from the prism git root:
 *   prism-dev workflow validate examples/prism-harness-qa/workflows/smoke-devin.workflow.ts
 *   prism-dev workflow run examples/prism-harness-qa/workflows/smoke-devin.workflow.ts \
 *     --permission full-access --task-timeout-ms 300000 \
 *     --max-concurrent-tasks 1 --store /tmp/devin-smoke.sqlite
 *
 * Cache is mandatory — there is no cache-bypass flag; point `--store` at a
 * fresh path for a clean re-run instead.
 */
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const ReviewOutput = Schema.Struct({
  slice: Schema.String,
  summary: Schema.String,
  findings: Schema.Array(
    Schema.Struct({
      severity: Schema.Literal("high", "med", "low"),
      loc: Schema.String,
      issue: Schema.String,
    }),
  ),
  verdict: Schema.Literal("ship", "fix-then-ship", "block"),
  evidence: Schema.Array(Schema.String),
});

const DEVIN_WORKER = {
  worker: "devin" as const,
  model: "swe-1-7",
  permission: "full-access" as const,
  // Headroom above observed ~20s healthy runs; Devin can stall under load.
  processTimeoutMs: 300_000,
};

const reviewLowerer = defineTask({
  id: "review-devin-lowerer",
  agent: agents.prismHarnessQa.qaTester,
  prompt:
    'Review ONLY src/compile/lowerers/devin.ts. Return ONLY JSON: {"slice":"lowerer-hooks","summary":"technical paragraph about the lowerer ownership and hooks","findings":[{"severity":"med","loc":"src/compile/lowerers/devin.ts","issue":"note"}],"verdict":"ship","evidence":["src/compile/lowerers/devin.ts"]}. Stop after JSON.',
  output: ReviewOutput,
  worker: DEVIN_WORKER,
});

const reviewWorker = defineTask({
  id: "review-devin-worker",
  agent: agents.prismHarnessQa.qaTester,
  prompt:
    'Review ONLY src/workflow-devin-worker.ts. Return ONLY JSON: {"slice":"workflow-worker","summary":"technical paragraph about -p permissions ATIF resume","findings":[{"severity":"med","loc":"src/workflow-devin-worker.ts","issue":"note"}],"verdict":"ship","evidence":["src/workflow-devin-worker.ts"]}. Stop after JSON.',
  output: ReviewOutput,
  worker: DEVIN_WORKER,
});

export default defineWorkflow({
  name: "devin-smoke",
  tasks: [reviewLowerer, reviewWorker],
});
