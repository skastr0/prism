/**
 * Reusable heterogeneous review council for the current Prism work slice.
 *
 * Run from the prism git root after each glyph-sized commit or before a
 * risky slice lands:
 *   prism workflow validate workflows/prism-workflow-work-review.workflow.ts
 *   PRISM_WORK_REVIEW_PACKET=/tmp/prism-review-packet.md prism workflow run workflows/prism-workflow-work-review.workflow.ts --store /tmp/prism-work-review.sqlite --no-cache
 *
 * The workflow deliberately captures failed reviewer harnesses as evidence so
 * auth-gated live configs do not hide available Claude/OpenCode findings.
 */
import { Effect, Either, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import {
  defineTask,
  defineWorkflow,
  type WorkflowAgentRef,
  type WorkflowRuntime,
  type WorkflowTaskWorkerOptions,
} from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";

const REVIEW_PACKET_MAX_CHARS = 60_000;

const readReviewPacket = (): string => {
  const packetPath = process.env.PRISM_WORK_REVIEW_PACKET;
  if (packetPath === undefined || packetPath.length === 0) {
    return "No review packet path was provided. Report this as a validation gap and do not infer repo state.";
  }
  if (!existsSync(packetPath)) {
    return `Review packet path does not exist: ${packetPath}`;
  }
  const packet = readFileSync(packetPath, "utf8");
  if (packet.length <= REVIEW_PACKET_MAX_CHARS) return packet;
  return `${packet.slice(0, REVIEW_PACKET_MAX_CHARS)}\n\n[review packet truncated at ${REVIEW_PACKET_MAX_CHARS} characters]`;
};

const reviewBrief = (reviewPacket: string): string => `Review the current Prism implementation slice.

Target:
- Use only the review packet embedded below.
- Do not inspect files, call tools, run shell commands, or infer unstated repo state.
- Treat unrelated local artifacts mentioned in the packet as out of scope instead of failing the slice solely for their existence.

Evidence discipline:
- A finding must cite concrete evidence from the review packet: file path plus line, diff hunk, or exact command output.
- If you cannot cite current-target evidence, put the concern in validationGaps or usefulFollowups, not findings.
- Do not turn plan-context uncertainty into a code finding unless the current diff touches that surface.
- Use only commands named in the review packet; never invent pnpm/npm/yarn commands.
- Do not accept env output, shell echo results, file reads, or hand-written JSON as proof of runtime behavior.

Plan context:
- Prism workflow E2E work is validating deterministic generated tools across live configs and repeatable temporary homes.
- Antigravity stays quarantined: type/typecheck rejection only.
- Generated MCP proof must come from a pure tool call, not env, shell echo, file reads, or fallback JSON.
- Reviews should protect worker invocation shape, modelspace resolution, generated MCP loading, finish criteria, and run evidence quality.
- This review workflow deliberately uses the Prism harness QA smoke modelspace profile for all reviewer workers to keep live routes known and comparable.
- Tower/Forge board identifiers are routing metadata only and must not leak into code, tests, schemas, or filenames.
- Prism plugin namespaces such as agents.forge are source references, not board identifiers.

Review packet:
${reviewPacket}

Return only JSON matching the requested schema.`;

const ReviewFinding = Schema.Struct({
  severity: Schema.Literal("high", "medium", "low"),
  title: Schema.String,
  evidence: Schema.String,
  recommendation: Schema.String,
});

const ReviewReport = Schema.Struct({
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  lens: Schema.String,
  verdict: Schema.Literal("pass", "needs-work", "block"),
  findings: Schema.Array(ReviewFinding),
  validationGaps: Schema.Array(Schema.String),
  usefulFollowups: Schema.Array(Schema.String),
});

const ReviewerResult = Schema.Struct({
  taskId: Schema.String,
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  status: Schema.Literal("completed", "failed"),
  report: Schema.optional(ReviewReport),
  error: Schema.optional(Schema.String),
});

const FusionVerdict = Schema.Struct({
  verdict: Schema.Literal("pass", "needs-work", "block"),
  blockingFindings: Schema.Array(ReviewFinding),
  orderedFixes: Schema.Array(Schema.String),
  validationToRun: Schema.Array(Schema.String),
  acceptedRisks: Schema.Array(Schema.String),
  harnessSetupBlockers: Schema.Array(Schema.String),
});

type ReviewReport = Schema.Schema.Type<typeof ReviewReport>;
type ReviewerResult = Schema.Schema.Type<typeof ReviewerResult>;
type FusionVerdict = Schema.Schema.Type<typeof FusionVerdict>;

const errorToMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 800);
};

const workerOptions = (
  worker: "grok" | "claude-code" | "opencode",
  model: WorkflowTaskWorkerOptions["model"],
): WorkflowTaskWorkerOptions => ({ worker, model });

const reviewTask = (
  brief: string,
  id: "grok-reliability-review" | "claude-contract-review" | "opencode-regression-review",
  harness: "grok" | "claude-code" | "opencode",
  agent: WorkflowAgentRef,
  model: WorkflowTaskWorkerOptions["model"],
  lens: string,
) =>
  defineTask({
    id,
    agent,
    prompt: `${brief}

Lens: ${lens}
Set harness to "${harness}" and lens to ${JSON.stringify(lens)}.`,
    output: ReviewReport,
    worker: workerOptions(harness, model),
  });

type ReviewTask = ReturnType<typeof reviewTask>;

const captureReviewer = (
  wf: WorkflowRuntime,
  task: ReviewTask,
  harness: "grok" | "claude-code" | "opencode",
) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(Effect.map(wf.runTask(task), (report): ReviewReport => report));
    if (Either.isRight(result)) {
      return {
        taskId: task.id,
        harness,
        status: "completed" as const,
        report: result.right,
      } satisfies ReviewerResult;
    }
    return {
      taskId: task.id,
      harness,
      status: "failed" as const,
      error: errorToMessage(result.left),
    } satisfies ReviewerResult;
  });

const localFusionVerdict = (reviewerResults: ReadonlyArray<ReviewerResult>): FusionVerdict => ({
  verdict: "needs-work",
  blockingFindings: [],
  orderedFixes: [],
  validationToRun: [],
  acceptedRisks: ["no reviewer harness completed; rerun after resolving harness setup blockers"],
  harnessSetupBlockers: reviewerResults.map((result) =>
    `${result.taskId}: ${result.error ?? "reviewer did not complete"}`,
  ),
});

const fusionWorker = (reviewerResults: ReadonlyArray<ReviewerResult>): WorkflowTaskWorkerOptions | null => {
  const completed = reviewerResults.find((result) => result.status === "completed");
  return completed ? workerOptions(completed.harness, models.prismHarnessQa.qaModels.smoke) : null;
};

export default defineWorkflow({
  name: "prism-workflow-work-review",
  run: (wf) =>
    Effect.gen(function* () {
      const brief = reviewBrief(readReviewPacket());
      const grokReview = reviewTask(
        brief,
        "grok-reliability-review",
        "grok",
        agents.forge.reliabilityReviewer,
        models.prismHarnessQa.qaModels.smoke,
        "Workflow runtime reliability: timeouts, auth prompts, process args, cancellation, and evidence capture.",
      );
      const claudeReview = reviewTask(
        brief,
        "claude-contract-review",
        "claude-code",
        agents.forge.contractReviewer,
        models.prismHarnessQa.qaModels.smoke,
        "Contracts and generated MCP: strict config loading, output schemas, finish criteria, and fail-closed behavior.",
      );
      const openCodeReview = reviewTask(
        brief,
        "opencode-regression-review",
        "opencode",
        agents.forge.orchestratorEngineer,
        models.prismHarnessQa.qaModels.smoke,
        "Regression proof quality: tests, modelspace coverage, direct agent selection, and false-positive prevention.",
      );

      const reviewerResults = yield* Effect.all(
        [
          captureReviewer(wf, grokReview, "grok"),
          captureReviewer(wf, claudeReview, "claude-code"),
          captureReviewer(wf, openCodeReview, "opencode"),
        ],
        { concurrency: "unbounded" },
      );

      const selectedFusionWorker = fusionWorker(reviewerResults);
      if (selectedFusionWorker === null) {
        return { reviewerResults, fusion: localFusionVerdict(reviewerResults) };
      }

      const fusion = yield* wf.runTask(
        defineTask({
          id: "fusion-verdict",
          agent: agents.forge.orchestratorEngineer,
          prompt: `Fuse these review results into one next-action verdict.

Reviewer results:
${JSON.stringify(reviewerResults, null, 2)}

Rules:
- Do not discard failed reviewer harnesses; classify setup/auth failures under harnessSetupBlockers.
- Preserve high-severity findings as blockingFindings only when they cite concrete current-target evidence.
- Downgrade evidence-free or plan-context-only concerns into acceptedRisks or validationToRun.
- orderedFixes must be directly actionable by an engineer in this repo.
- validationToRun must name exact commands only when they appeared in the review packet.
- Return only JSON matching the schema.`,
          output: FusionVerdict,
          worker: selectedFusionWorker,
        }),
      );

      return { reviewerResults, fusion };
    }),
});
