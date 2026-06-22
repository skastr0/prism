/**
 * Delegated workflow-permissions implementation challenge.
 *
 * Run from the prism git root:
 *   bun run dev -- workflow validate workflows/prism-workflow-permissions-fanout.workflow.ts
 *   bun run dev -- workflow run workflows/prism-workflow-permissions-fanout.workflow.ts --store /tmp/prism-permissions-fanout.sqlite --no-cache --max-concurrent-tasks 4
 *
 * Topology:
 *   harness self-research fanout -> mixed fusion console -> single delegated
 *   implementation task -> mixed review fanout -> final verdict.
 */
import { execFileSync } from "node:child_process";
import { Effect, Either, Schema } from "effect";
import {
  defineTask,
  defineWorkflow,
  type WorkflowRuntime,
  type WorkflowTaskWorkerOptions,
} from "prism";
import { agents } from "prism/refs";
import { models } from "prism/refs/models";

const TARGET_FILES = [
  "src/workflows.ts",
  "src/workflow-workers.ts",
  "src/workflow-opencode-worker.ts",
  "src/workflow-claude-worker.ts",
  "src/workflow-codex-worker.ts",
  "src/workflow-grok-worker.ts",
  "src/workflow-hermes-worker.ts",
  "src/workflow-kimi-worker.ts",
  "src/workflow-amp-worker.ts",
  "src/workflow-worker-args.test.ts",
  "src/workflows.test.ts",
  "src/cli.ts",
] as const;

const KNOWN_DIRTY_FILES = [
  "src/compile/mcp-bundle.ts",
  "src/manifest.ts",
  "src/refresh.ts",
  "src/types.ts",
  "workflows/prism-workflow-premium-council.workflow.ts",
] as const;

const IMPLEMENTATION_BRIEF = `Implement workflow-level permission controls for Prism by delegation.

Hard contract:
- Prism workflows need a unified task-level and CLI-level permission surface.
- Default behavior for workflow execution should choose each supported harness' most permissive viable noninteractive mode.
- An explicit legacy/default mode must preserve current worker behavior when the workflow author asks for it.
- Unsupported precise modes must fail closed before spawning the harness, with an actionable error.
- Antigravity is live; include it in WorkflowWorkerId, permission mapping checks, and explicit-conversation repair continuation.
- Do not touch unrelated dirty files unless the task escalates first.

Existing unrelated dirty files to avoid:
${KNOWN_DIRTY_FILES.map((file) => `- ${file}`).join("\n")}

Likely implementation targets:
${TARGET_FILES.map((file) => `- ${file}`).join("\n")}

Expected end state:
- WorkflowTaskWorkerOptions exposes a typed permission option.
- WorkflowRuntimeOptions and the CLI workflow run/update surfaces can provide a fallback permission.
- createWorkflowWorkerExecutor resolves task permission over runtime fallback.
- Every supported workflow worker interprets the unified permission mode into its own CLI/config shape.
- Worker arg tests cover the permission mappings, including Grok, Amp, Codex, Claude, OpenCode, Hermes, and Kimi.
- Validation includes targeted bun tests and typecheck where feasible.

Do not return prose. Return JSON matching the task schema.`;

const HarnessId = Schema.Literal(
  "opencode",
  "claude-code",
  "codex-cli",
  "grok",
  "hermes",
  "kimi-code",
  "amp-code",
);

const WorkerId = Schema.Literal("opencode", "claude-code", "codex-cli", "grok", "hermes", "kimi-code", "amp-code");

const EvidenceItem = Schema.Struct({
  source: Schema.String,
  claim: Schema.String,
  url: Schema.optional(Schema.String),
});

const PermissionMapping = Schema.Struct({
  workflowMode: Schema.String,
  support: Schema.Literal("native", "best-effort", "unsupported"),
  interpreter: Schema.String,
  evidence: Schema.Array(Schema.String),
  risk: Schema.optional(Schema.String),
});

const HarnessResearchReport = Schema.Struct({
  harness: HarnessId,
  status: Schema.Literal("researched", "blocked"),
  officialSources: Schema.optional(Schema.Array(EvidenceItem)),
  localEvidence: Schema.optional(Schema.Array(EvidenceItem)),
  availableControls: Schema.optional(Schema.Array(Schema.String)),
  mostPermissiveControl: Schema.optional(Schema.String),
  proposedMappings: Schema.optional(Schema.Array(PermissionMapping)),
  testsToAdd: Schema.optional(Schema.Array(Schema.String)),
  implementationNotes: Schema.optional(Schema.Array(Schema.String)),
  blockers: Schema.optional(Schema.Array(Schema.String)),
});

const HarnessResearchResult = Schema.Struct({
  taskId: Schema.String,
  harness: HarnessId,
  worker: WorkerId,
  status: Schema.Literal("completed", "failed"),
  report: Schema.optional(HarnessResearchReport),
  error: Schema.optional(Schema.String),
});

const WorkflowModeContract = Schema.Struct({
  name: Schema.String,
  contract: Schema.String,
  defaultForWorkflowExecution: Schema.Boolean,
});

const HarnessMappingContract = Schema.Struct({
  harness: HarnessId,
  defaultMode: Schema.String,
  mappings: Schema.Array(PermissionMapping),
  failClosedRules: Schema.Array(Schema.String),
});

const FusionProposal = Schema.Unknown;

const FusionResult = Schema.Struct({
  taskId: Schema.String,
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  status: Schema.Literal("completed", "failed"),
  proposal: Schema.optional(FusionProposal),
  error: Schema.optional(Schema.String),
});

const FinalFusion = Schema.Struct({
  verdict: Schema.Literal("implement", "adjust", "block"),
  chosenPermissionModes: Schema.Array(WorkflowModeContract),
  chosenHarnessMappings: Schema.Array(HarnessMappingContract),
  implementationContract: Schema.Array(Schema.String),
  testsRequired: Schema.Array(Schema.String),
  risksAccepted: Schema.Array(Schema.String),
  blockedReasons: Schema.Array(Schema.String),
});

const ValidationResult = Schema.Struct({
  command: Schema.String,
  status: Schema.Literal("passed", "failed", "skipped"),
  outputExcerpt: Schema.String,
});

const ImplementationReport = Schema.Struct({
  status: Schema.Literal("implemented", "blocked", "escalate"),
  summary: Schema.String,
  touchedFiles: Schema.Array(Schema.String),
  permissionContract: Schema.Array(Schema.String),
  validations: Schema.Array(ValidationResult),
  reviewNotes: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
});

const ReviewFinding = Schema.Struct({
  severity: Schema.Literal("high", "medium", "low"),
  title: Schema.String,
  evidence: Schema.String,
  fix: Schema.String,
});

const ReviewReport = Schema.Struct({
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  verdict: Schema.Literal("pass", "needs-work", "block"),
  findings: Schema.Array(ReviewFinding),
  validationGaps: Schema.Array(Schema.String),
  requiredFixes: Schema.Array(Schema.String),
});

const ReviewResult = Schema.Struct({
  taskId: Schema.String,
  harness: Schema.Literal("grok", "claude-code", "opencode"),
  status: Schema.Literal("completed", "failed"),
  report: Schema.optional(ReviewReport),
  error: Schema.optional(Schema.String),
});

type HarnessResearchReport = Schema.Schema.Type<typeof HarnessResearchReport>;
type HarnessResearchResult = Schema.Schema.Type<typeof HarnessResearchResult>;
type FusionProposal = Schema.Schema.Type<typeof FusionProposal>;
type FusionResult = Schema.Schema.Type<typeof FusionResult>;
type FinalFusion = Schema.Schema.Type<typeof FinalFusion>;
type ImplementationReport = Schema.Schema.Type<typeof ImplementationReport>;
type ReviewResult = Schema.Schema.Type<typeof ReviewResult>;

const qaAgent = agents.prismHarnessQa.qaTester;
const implementer = agents.forge.orchestratorEngineer;

const errorToMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 1_000);
};

const commandOutput = (command: string, args: ReadonlyArray<string>, maxChars = 30_000): string => {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout.slice(0, maxChars);
  } catch (cause) {
    const error = cause as {
      readonly status?: number;
      readonly stdout?: Buffer | string;
      readonly stderr?: Buffer | string;
      readonly message?: string;
    };
    const stdout = Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf8") : error.stdout ?? "";
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : error.stderr ?? "";
    return [
      `command failed: ${command} ${args.join(" ")}`,
      `status: ${error.status ?? "unknown"}`,
      stdout,
      stderr,
      error.message ?? "",
    ].join("\n").slice(0, maxChars);
  }
};

const workerOptions = (
  worker: "opencode" | "claude-code" | "codex-cli" | "grok" | "hermes" | "kimi-code" | "amp-code",
): WorkflowTaskWorkerOptions => {
  if (worker === "amp-code") return { worker, model: "deep" };
  return { worker, model: models.prismHarnessQa.qaModels.smoke };
};

const researchPrompt = (harness: string): string => `${IMPLEMENTATION_BRIEF}

Research assignment:
- You are running under the ${harness} worker.
- Web-research the official/current permission, sandbox, approval, yolo, or auto-approve controls for ${harness}.
- Also inspect the installed CLI help if available.
- Do not edit files in this phase.
- Separate official docs from local CLI evidence.
- Map what ${harness} can honestly support for Prism workflow permissions.
- Prefer exact flags/config values over broad prose.
- If a mode cannot be enforced by ${harness}, mark it unsupported instead of pretending.
- Include every schema field even if the value is an empty array.

Set harness to "${harness}".`;

const researchTask = (
  id: string,
  harness: "opencode" | "claude-code" | "codex-cli" | "grok" | "hermes" | "kimi-code" | "amp-code",
) =>
  defineTask({
    id,
    agent: qaAgent,
    prompt: researchPrompt(harness),
    output: HarnessResearchReport,
    worker: workerOptions(harness),
  });

const captureResearch = (
  wf: WorkflowRuntime,
  task: ReturnType<typeof researchTask>,
  harness: "opencode" | "claude-code" | "codex-cli" | "grok" | "hermes" | "kimi-code" | "amp-code",
) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(wf.runTask(task));
    if (Either.isRight(result)) {
      return {
        taskId: task.id,
        harness,
        worker: harness,
        status: "completed" as const,
        report: result.right,
      } satisfies HarnessResearchResult;
    }
    return {
      taskId: task.id,
      harness,
      worker: harness,
      status: "failed" as const,
      error: errorToMessage(result.left),
    } satisfies HarnessResearchResult;
  });

const fusionPrompt = (
  researchResults: ReadonlyArray<HarnessResearchResult>,
  harness: "grok" | "claude-code" | "opencode",
  lens: string,
): string => `${IMPLEMENTATION_BRIEF}

Fusion assignment:
- You are one seat in the fusion console running under ${harness}.
- Lens: ${lens}
- Fuse all harness self-research into one implementable Prism permission contract.
- Preserve dissent when evidence conflicts.
- Do not edit files in this phase.
- Favor a small unified schema that can survive worker differences.
- Include exact tests that should catch argument/config regressions.

Research results:
${JSON.stringify(researchResults, null, 2)}

Set harness to "${harness}".`;

const captureFusion = (
  wf: WorkflowRuntime,
  researchResults: ReadonlyArray<HarnessResearchResult>,
  id: "fusion-grok-runtime" | "fusion-claude-contract" | "fusion-grok-risk" | "fusion-claude-tests" | "fusion-opencode-dx",
  harness: "grok" | "claude-code" | "opencode",
  lens: string,
) =>
  Effect.gen(function* () {
    const task = defineTask({
      id,
      agent: qaAgent,
      prompt: fusionPrompt(researchResults, harness, lens),
      output: FusionProposal,
      worker: workerOptions(harness),
    });
    const result = yield* Effect.either(wf.runTask(task));
    if (Either.isRight(result)) {
      return {
        taskId: task.id,
        harness,
        status: "completed" as const,
        proposal: result.right,
      } satisfies FusionResult;
    }
    return {
      taskId: task.id,
      harness,
      status: "failed" as const,
      error: errorToMessage(result.left),
    } satisfies FusionResult;
  });

const localFinalFusion = (
  researchResults: ReadonlyArray<HarnessResearchResult>,
  fusionResults: ReadonlyArray<FusionResult>,
): FinalFusion => {
  const completed = fusionResults.flatMap((result) => result.status === "completed" && result.proposal !== undefined ? [result.proposal] : []);
  return {
    verdict: completed.length > 0 ? "implement" : "block",
    chosenPermissionModes: [],
    chosenHarnessMappings: [],
    implementationContract: [
      "Implement a unified workflow permission option using completed fusion proposal payloads plus harness self-research as the source of truth.",
      "Default unresolved workflow execution to the most permissive viable noninteractive mode.",
      "Provide an explicit legacy/default mode that preserves current worker behavior.",
      "Fail closed before spawn for unsupported precise modes such as sandbox/read-only/workspace-write when a harness cannot honestly enforce them.",
      "Keep Antigravity included in WorkflowWorkerId with explicit permission mapping and `--conversation` repair continuation.",
    ],
    testsRequired: [
      "worker arg tests for permissive and legacy/default mappings per supported harness",
      "runtime fallback permission resolution tests",
      "unsupported permission mode fail-closed tests",
      "CLI workflow run/update fallback permission tests",
    ],
    risksAccepted: [
      "Fusion payloads are heterogeneous raw JSON because live harnesses do not converge on a single planning schema.",
      "Grok and Codex research failures are preserved as run evidence; implementation must use completed harness research plus local code inspection for those workers.",
    ],
    blockedReasons: [
      ...researchResults.flatMap((result) => result.status === "failed" ? [`${result.taskId}: ${result.error}`] : []),
      ...fusionResults.flatMap((result) => result.status === "failed" ? [`${result.taskId}: ${result.error}`] : []),
    ],
  };
};

const implementationPrompt = (
  researchResults: ReadonlyArray<HarnessResearchResult>,
  fusionResults: ReadonlyArray<FusionResult>,
  finalFusion: FinalFusion,
): string => `${IMPLEMENTATION_BRIEF}

Implementation assignment:
- You own the code edit. Inspect the repo before editing.
- Implement the final fusion contract below unless it conflicts with the hard contract.
- Fusion proposal payloads are raw heterogeneous JSON by design; inspect them directly.
- Do not commit.
- Do not edit the known unrelated dirty files unless you return status "escalate" and explain why.
- Keep changes tightly scoped and add focused tests.
- Run targeted validation commands you change; include command outputs in the JSON.

Final fusion:
${JSON.stringify(finalFusion, null, 2)}

Research results:
${JSON.stringify(researchResults, null, 2)}

Fusion console results:
${JSON.stringify(fusionResults, null, 2)}

Return status "implemented" only if the repo files were actually changed and validation was attempted.`;

const reviewPacket = (
  implementation: ImplementationReport,
  finalFusion: FinalFusion,
): string => {
  const status = commandOutput("git", ["status", "--short"], 20_000);
  const diffStat = commandOutput("git", ["diff", "--stat", "--", ...TARGET_FILES], 20_000);
  const diff = commandOutput("git", ["diff", "--", ...TARGET_FILES], 80_000);
  return `Implementation report:
${JSON.stringify(implementation, null, 2)}

Final fusion:
${JSON.stringify(finalFusion, null, 2)}

Git status:
${status}

Target diff stat:
${diffStat}

Target diff:
${diff}
`;
};

const reviewPrompt = (
  packet: string,
  harness: "grok" | "claude-code" | "opencode",
  lens: string,
): string => `Review the delegated Prism workflow-permissions implementation.

Rules:
- Use only the packet below.
- Do not edit files.
- Findings must cite concrete packet evidence.
- Check whether the implementation honors workflow-level permissions, permissive default behavior, explicit legacy/default behavior, and fail-closed unsupported modes.
- Check whether tests cover worker argument/config mappings.
- Do not fail the slice solely because unrelated dirty files exist; only flag target diffs and contract violations.

Lens: ${lens}

Packet:
${packet}

Set harness to "${harness}". Return JSON only.`;

const captureReview = (
  wf: WorkflowRuntime,
  packet: string,
  id: "review-grok-runtime" | "review-claude-contract" | "review-opencode-regression",
  harness: "grok" | "claude-code" | "opencode",
  lens: string,
) =>
  Effect.gen(function* () {
    const task = defineTask({
      id,
      agent: qaAgent,
      prompt: reviewPrompt(packet, harness, lens),
      output: ReviewReport,
      worker: workerOptions(harness),
    });
    const result = yield* Effect.either(wf.runTask(task));
    if (Either.isRight(result)) {
      return {
        taskId: task.id,
        harness,
        status: "completed" as const,
        report: result.right,
      } satisfies ReviewResult;
    }
    return {
      taskId: task.id,
      harness,
      status: "failed" as const,
      error: errorToMessage(result.left),
    } satisfies ReviewResult;
  });

const finalVerdict = (
  implementation: ImplementationReport | null,
  reviews: ReadonlyArray<ReviewResult>,
): "pass" | "needs-work" | "block" => {
  if (implementation === null || implementation.status !== "implemented") return "block";
  const completed = reviews.flatMap((review) => review.status === "completed" && review.report ? [review.report] : []);
  if (completed.some((review) => review.verdict === "block")) return "block";
  if (reviews.some((review) => review.status === "failed") || completed.some((review) => review.verdict === "needs-work")) {
    return "needs-work";
  }
  return "pass";
};

export default defineWorkflow({
  name: "prism-workflow-permissions-fanout",
  run: (wf) =>
    Effect.gen(function* () {
      const researchTasks = [
        ["opencode", researchTask("research-opencode", "opencode")],
        ["claude-code", researchTask("research-claude-code", "claude-code")],
        ["codex-cli", researchTask("research-codex-cli", "codex-cli")],
        ["grok", researchTask("research-grok", "grok")],
        ["hermes", researchTask("research-hermes", "hermes")],
        ["kimi-code", researchTask("research-kimi-code", "kimi-code")],
        ["amp-code", researchTask("research-amp-code", "amp-code")],
      ] as const;
      const researchResults = yield* Effect.all(
        researchTasks.map(([harness, task]) => captureResearch(wf, task, harness)),
        { concurrency: "unbounded" },
      );

      const fusionResults = yield* Effect.all(
        [
          captureFusion(wf, researchResults, "fusion-grok-runtime", "grok", "Runtime flag and process invocation mapping."),
          captureFusion(wf, researchResults, "fusion-claude-contract", "claude-code", "Typed API contract, CLI surface, and fail-closed semantics."),
          captureFusion(wf, researchResults, "fusion-grok-risk", "grok", "Permission default risk and unsupported-mode honesty."),
          captureFusion(wf, researchResults, "fusion-claude-tests", "claude-code", "Regression test coverage and code organization."),
          captureFusion(wf, researchResults, "fusion-opencode-dx", "opencode", "Workflow authoring ergonomics and OpenCode direct execution."),
        ],
        { concurrency: "unbounded" },
      );

      const finalFusion = localFinalFusion(researchResults, fusionResults);
      if (finalFusion.verdict === "block") {
        return {
          researchResults,
          fusionResults,
          finalFusion,
          implementation: null,
          reviews: [],
          verdict: "block" as const,
        };
      }

      const implementationTask = defineTask({
        id: "implement-permissions",
        agent: implementer,
        prompt: implementationPrompt(researchResults, fusionResults, finalFusion),
        output: ImplementationReport,
        worker: workerOptions("opencode"),
      });
      const implementationResult = yield* Effect.either(wf.runTask(implementationTask));
      if (Either.isLeft(implementationResult)) {
        return {
          researchResults,
          fusionResults,
          finalFusion,
          implementation: {
            status: "blocked" as const,
            summary: "implementation task failed",
            touchedFiles: [],
            permissionContract: [],
            validations: [],
            reviewNotes: [],
            blockers: [errorToMessage(implementationResult.left)],
          },
          reviews: [],
          verdict: "block" as const,
        };
      }

      const implementation = implementationResult.right;
      if (implementation.status !== "implemented") {
        return {
          researchResults,
          fusionResults,
          finalFusion,
          implementation,
          reviews: [],
          verdict: "block" as const,
        };
      }

      const packet = reviewPacket(implementation, finalFusion);
      const reviews = yield* Effect.all(
        [
          captureReview(wf, packet, "review-grok-runtime", "grok", "Runtime behavior, worker args, and most-permissive mappings."),
          captureReview(wf, packet, "review-claude-contract", "claude-code", "Type contract, CLI fallback permission, and fail-closed semantics."),
          captureReview(wf, packet, "review-opencode-regression", "opencode", "Regression tests, workflow DX, and default behavior compatibility."),
        ],
        { concurrency: "unbounded" },
      );

      return {
        researchResults,
        fusionResults,
        finalFusion,
        implementation,
        reviews,
        verdict: finalVerdict(implementation, reviews),
      };
    }),
});
