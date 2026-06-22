/**
 * Two-harness review of the native structured-output workflow slice.
 *
 * Run from the prism git root:
 *   prism workflow validate workflows/prism-workflow-native-output-review.workflow.ts
 *   PRISM_NATIVE_OUTPUT_REVIEW_PACKET=/tmp/prism-native-output-review.md prism workflow run workflows/prism-workflow-native-output-review.workflow.ts --store /tmp/prism-native-output-review.sqlite --no-cache --task-timeout-ms 600000
 *
 * The workflow is intentionally review-only. Discuss findings before applying fixes.
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

const REVIEW_PACKET_MAX_CHARS = 80_000;

const readReviewPacket = (): string => {
  const packetPath = process.env.PRISM_NATIVE_OUTPUT_REVIEW_PACKET;
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

const reviewBrief = (reviewPacket: string): string => `Review Prism commit b7c9eca, "Cover workflow native output schemas".

Scope:
- Review only the evidence packet below.
- Do not modify files.
- Do not propose fixes for unrelated code outside the packet.
- This review is for discussion before any follow-up changes.

Target behavior:
- Claude Code workflow tasks should pass a native JSON schema and consume native structured_output when present.
- Codex CLI workflow tasks should write a derived output-schema.json, pass it through --output-schema, and consume --output-last-message.
- Unsupported Effect output schemas should remain opportunistic and fall back to the prompt/repair loop.
- Tests should be deterministic and should not require live Claude Code or Codex auth.

Finding rules:
- A finding needs concrete evidence from this packet.
- Put weak concerns in validationGaps, not findings.
- Call out any false confidence in the tests, schema conversion, metadata, or fallback behavior.
- Treat board/workflow routing ids as out of scope unless they leak into code/tests/fixtures.

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
  harness: Schema.Literal("grok", "antigravity-cli"),
  lens: Schema.String,
  verdict: Schema.Literal("pass", "needs-work", "block"),
  findings: Schema.Array(ReviewFinding),
  validationGaps: Schema.Array(Schema.String),
  usefulFollowups: Schema.Array(Schema.String),
});

const ReviewerResult = Schema.Struct({
  taskId: Schema.String,
  harness: Schema.Literal("grok", "antigravity-cli"),
  status: Schema.Literal("completed", "failed"),
  report: Schema.optional(ReviewReport),
  error: Schema.optional(Schema.String),
});

const Synthesis = Schema.Struct({
  verdict: Schema.Literal("pass", "needs-work", "block"),
  findings: Schema.Array(ReviewFinding),
  validationGaps: Schema.Array(Schema.String),
  harnessSetupBlockers: Schema.Array(Schema.String),
  discussBeforeFixing: Schema.Array(Schema.String),
});

type ReviewReport = Schema.Schema.Type<typeof ReviewReport>;
type ReviewerResult = Schema.Schema.Type<typeof ReviewerResult>;
type Synthesis = Schema.Schema.Type<typeof Synthesis>;

const errorToMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 800);
};

const workerOptions = (
  worker: "grok" | "antigravity-cli",
): WorkflowTaskWorkerOptions =>
  worker === "grok"
    ? { worker, model: models.prismHarnessQa.qaModels.smoke, permission: "legacy" }
    : { worker, permission: "legacy" };

const reviewTask = (
  brief: string,
  id: "grok-verification-review" | "agy-contract-review",
  harness: "grok" | "antigravity-cli",
  agent: WorkflowAgentRef,
  lens: string,
) =>
  defineTask({
    id,
    agent,
    prompt: `${brief}

Lens: ${lens}
Set harness to "${harness}" and lens to ${JSON.stringify(lens)}.`,
    output: ReviewReport,
    worker: workerOptions(harness),
  });

type ReviewTask = ReturnType<typeof reviewTask>;

const captureReviewer = (
  wf: WorkflowRuntime,
  task: ReviewTask,
  harness: "grok" | "antigravity-cli",
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

const synthesize = (results: ReadonlyArray<ReviewerResult>): Synthesis => {
  const completed = results.flatMap((result) => result.report === undefined ? [] : [result.report]);
  const findings = completed.flatMap((report) => report.findings);
  const harnessSetupBlockers = results.flatMap((result) =>
    result.status === "failed" ? [`${result.taskId}: ${result.error ?? "reviewer did not complete"}`] : [],
  );
  const validationGaps = completed.flatMap((report) => report.validationGaps);
  const hasBlock = completed.some((report) => report.verdict === "block");
  const hasNeedsWork = completed.some((report) => report.verdict === "needs-work") || findings.length > 0;
  return {
    verdict: hasBlock ? "block" : hasNeedsWork ? "needs-work" : "pass",
    findings,
    validationGaps,
    harnessSetupBlockers,
    discussBeforeFixing: [
      ...findings.map((finding) => `${finding.severity}: ${finding.title}`),
      ...validationGaps.map((gap) => `gap: ${gap}`),
      ...harnessSetupBlockers.map((blocker) => `harness: ${blocker}`),
    ],
  };
};

export default defineWorkflow({
  name: "prism-workflow-native-output-review",
  run: (wf) =>
    Effect.gen(function* () {
      const brief = reviewBrief(readReviewPacket());
      const results = yield* Effect.all(
        [
          captureReviewer(
            wf,
            reviewTask(
              brief,
              "grok-verification-review",
              "grok",
              agents.forge.verificationReviewer,
              "Verification: prove the new tests and validation actually cover native structured-output behavior.",
            ),
            "grok",
          ),
          captureReviewer(
            wf,
            reviewTask(
              brief,
              "agy-contract-review",
              "antigravity-cli",
              agents.forge.contractReviewer,
              "Contract: check schema translation, harness CLI contract assumptions, and fallback behavior boundaries.",
            ),
            "antigravity-cli",
          ),
        ],
        { concurrency: "unbounded" },
      );

      return {
        reviewerResults: results,
        synthesis: synthesize(results),
      };
    }),
});
