/**
 * Small heterogeneous review council for the Prism workflow E2E plan.
 *
 * Run from the prism git root:
 *   prism workflow validate workflows/prism-workflow-e2e-plan-council.workflow.ts
 *   prism workflow run workflows/prism-workflow-e2e-plan-council.workflow.ts --store /tmp/prism-e2e-plan-council.sqlite
 *
 * Failed reviewer harnesses are captured as evidence so one auth-gated live
 * route does not prevent the remaining council from producing suggestions.
 */
import { Effect, Either, Schema } from "effect";
import {
  defineTask,
  defineWorkflow,
  type WorkflowRuntime,
  type WorkflowTaskWorkerOptions,
} from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";

const PLAN_BRIEF = `Review the Prism workflow E2E implementation plan and current repo direction.

Context:
- We are adding deterministic generated-tool E2E coverage for opencode, claude-code, codex-cli, grok, hermes, kimi-code, and amp-code.
- Antigravity has live prompted-contract workflow dispatch plus native `--conversation` repair continuation; generated-tool E2E remains separate from this plan until lowered-agent binding is proven.
- The generated test tool must be pure: input challenge -> { challenge, proof: "prism-tool-proof:<challenge>", source: "prism-generated-tool" }.
- There will be two lanes: repeatable temp roots/homes for regression learning, and a live manual lane against the operator's real harness configs.
- Live successful runs submit Forge Tower dispatches to project "prism", orbit "forge".
- Worker fixes under consideration: Grok single-turn args, Amp mode guard, OpenCode direct agent selection, all modelspace profiles in workflow refs.

Do not inspect files or call tools; return only JSON matching the requested schema.
Focus on concrete corrections, missing tests, and sequencing risks.`;

const LensReport = Schema.Struct({
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  lens: Schema.String,
  verdict: Schema.Literal("ship", "adjust", "block"),
  topRisks: Schema.Array(Schema.String),
  recommendedChanges: Schema.Array(Schema.String),
  testsToAdd: Schema.Array(Schema.String),
  runbookNotes: Schema.Array(Schema.String),
});

const CompletedLensResult = Schema.Struct({
  taskId: Schema.String,
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  status: Schema.Literal("completed"),
  report: LensReport,
});

const FailedLensResult = Schema.Struct({
  taskId: Schema.String,
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  status: Schema.Literal("failed"),
  error: Schema.String,
});

const LensResult = Schema.Union(CompletedLensResult, FailedLensResult);

const FusionReview = Schema.Struct({
  verdict: Schema.Literal("ship", "adjust", "block"),
  orderedActions: Schema.Array(Schema.String),
  mustFixBeforeLive: Schema.Array(Schema.String),
  regressionTests: Schema.Array(Schema.String),
  acceptanceRunbook: Schema.Array(Schema.String),
  dissent: Schema.Array(Schema.String),
});

type LensReport = Schema.Schema.Type<typeof LensReport>;
type LensResult = Schema.Schema.Type<typeof LensResult>;
type FusionReview = Schema.Schema.Type<typeof FusionReview>;

const qaTester = agents.prismHarnessQa.qaTester;

const errorToMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 800);
};

const lensTask = (
  id:
    | "grok-worker-lens"
    | "grok-ops-lens"
    | "claude-contract-lens"
    | "claude-risk-lens"
    | "opencode-direct-lens",
  worker: "grok" | "claude-code" | "opencode",
  lens: string,
) => {
  return defineTask({
    id,
    agent: qaTester,
    prompt: `${PLAN_BRIEF}\n\nLens: ${lens}\nSet harness to "${worker}" and lens to ${JSON.stringify(lens)}.`,
    output: LensReport,
    worker: { worker, model: models.prismHarnessQa.qaModels.smoke },
  });
};

type LensTask = ReturnType<typeof lensTask>;

const captureLens = (
  wf: WorkflowRuntime,
  task: LensTask,
  harness: "grok" | "claude-code" | "opencode",
) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(wf.runTask(task));
    if (Either.isRight(result)) {
      return {
        taskId: task.id,
        harness,
        status: "completed" as const,
        report: result.right,
      } satisfies LensResult;
    }
    return {
      taskId: task.id,
      harness,
      status: "failed" as const,
      error: errorToMessage(result.left),
    } satisfies LensResult;
  });

const fusionWorker = (lensResults: ReadonlyArray<LensResult>): WorkflowTaskWorkerOptions | null => {
  const completed = lensResults.find((result) => result.status === "completed");
  return completed ? { worker: completed.harness, model: models.prismHarnessQa.qaModels.smoke } : null;
};

const localFusionReview = (lensResults: ReadonlyArray<LensResult>): FusionReview => {
  const completedReports = lensResults.flatMap((result) => result.status === "completed" ? [result.report] : []);
  return {
    verdict: completedReports.some((report) => report.verdict === "block")
      ? "block"
      : lensResults.some((result) => result.status === "failed") || completedReports.some((report) => report.verdict === "adjust")
        ? "adjust"
        : "ship",
    orderedActions: [
      ...completedReports.flatMap((report) => report.recommendedChanges),
      ...lensResults.flatMap((result) =>
        result.status === "failed"
          ? [`Resolve ${result.harness} setup for ${result.taskId}: ${result.error}`]
          : [],
      ),
    ],
    mustFixBeforeLive: lensResults.flatMap((result) => {
      if (result.status === "failed") return [`${result.taskId}: ${result.error}`];
      return result.report.verdict === "block"
        ? result.report.topRisks.map((risk) => `${result.taskId}: ${risk}`)
        : [];
    }),
    regressionTests: completedReports.flatMap((report) => report.testsToAdd),
    acceptanceRunbook: [
      ...completedReports.flatMap((report) => report.runbookNotes),
      "rerun prism-workflow-e2e-plan-council after harness auth refresh; completed tasks replay from cache and failed tasks execute again",
    ],
    dissent: lensResults.map((result) =>
      result.status === "completed"
        ? `${result.taskId}: ${result.report.verdict}`
        : `${result.taskId}: setup-blocked: ${result.error}`,
    ),
  };
};

export const workflow = defineWorkflow({
  name: "prism-workflow-e2e-plan-council",
  run: (wf) =>
    Effect.gen(function* () {
      const lensTasks = [
        ["grok", lensTask("grok-worker-lens", "grok", "Grok worker invocation, headless flags, and generated plugin behavior")],
        ["grok", lensTask("grok-ops-lens", "grok", "E2E operations runbook, temp roots, live roots, and evidence capture")],
        ["claude-code", lensTask("claude-contract-lens", "claude-code", "Contracts, schemas, modelspace refs, and fail-closed behavior")],
        ["claude-code", lensTask("claude-risk-lens", "claude-code", "Risk review before live harness mutation and Tower dispatches")],
        ["opencode", lensTask("opencode-direct-lens", "opencode", "OpenCode direct agent mode and no default-agent fallback")],
      ] as const;
      const lenses = yield* Effect.all(
        lensTasks.map(([harness, task]) => captureLens(wf, task, harness)),
        { concurrency: "unbounded" },
      );

      const selectedFusionWorker = fusionWorker(lenses);
      if (selectedFusionWorker === null) {
        return { lenses, fusion: localFusionReview(lenses), fusionSource: "local" as const };
      }

      const aiFusion = yield* Effect.either(
        wf.runTask(
          defineTask({
            id: "fusion-review",
            agent: qaTester,
            prompt: `Fuse these council reports into a concise implementation review.

Reports:
${JSON.stringify(lenses, null, 2)}

Rules:
- Preserve real dissent.
- Classify failed reviewer harnesses as setup blockers instead of discarding them.
- Separate changes required before committed regression tests from changes required only before live harness runs.
- Prefer actions that can be checked by bun tests or prism workflow validate/run.
- Every field must be an array of plain strings except verdict.
- Return only JSON matching the schema.`,
            output: FusionReview,
            worker: selectedFusionWorker,
          }),
        ),
      );

      if (Either.isRight(aiFusion)) return { lenses, fusion: aiFusion.right, fusionSource: "ai" as const };

      return {
        lenses,
        fusion: localFusionReview(lenses),
        fusionSource: "local" as const,
        fusionError: errorToMessage(aiFusion.left),
      };
    }),
});
