/**
 * Small heterogeneous review council for the Prism workflow E2E plan.
 *
 * Run from the prism git root:
 *   prism workflow validate workflows/prism-workflow-e2e-plan-council.workflow.ts
 *   prism workflow run workflows/prism-workflow-e2e-plan-council.workflow.ts --store /tmp/prism-e2e-plan-council.sqlite
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const PLAN_BRIEF = `Review the Prism workflow E2E implementation plan and current repo direction.

Context:
- We are adding deterministic generated-tool E2E coverage for opencode, claude-code, codex-cli, grok, hermes, kimi-code, and amp-code.
- Antigravity remains quarantined: type/typecheck rejection only, no live run.
- The generated test tool must be pure: input challenge -> { challenge, proof: "prism-tool-proof:<challenge>", source: "prism-generated-tool" }.
- There will be two lanes: repeatable temp roots/homes for regression learning, and a live manual lane against the operator's real harness configs.
- Live successful runs submit Forge Tower dispatches to project "prism", orbit "forge".
- Worker fixes under consideration: Grok single-turn args, Amp mode guard, OpenCode direct agent selection, all modelspace profiles in workflow refs.

Inspect files if helpful, but return only JSON matching the requested schema.
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

const FusionReview = Schema.Struct({
  verdict: Schema.Literal("ship", "adjust", "block"),
  orderedActions: Schema.Array(Schema.String),
  mustFixBeforeLive: Schema.Array(Schema.String),
  regressionTests: Schema.Array(Schema.String),
  acceptanceRunbook: Schema.Array(Schema.String),
  dissent: Schema.Array(Schema.String),
});

const explorer = agents.forge.explorer;
const reviewer = agents.forge.verificationReviewer;
const orchestrator = agents.forge.orchestratorEngineer;

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
  const workerOptions =
    worker === "grok"
      ? { worker, model: "grok-build" as const }
      : worker === "opencode"
        ? { worker, model: "ollama-cloud/deepseek-v4-flash" as const }
        : { worker, model: "sonnet" as const };

  return defineTask({
    id,
    agent: worker === "claude-code" ? reviewer : explorer,
    prompt: `${PLAN_BRIEF}\n\nLens: ${lens}\nSet harness to "${worker}" and lens to ${JSON.stringify(lens)}.`,
    output: LensReport,
    cacheKey: `prism-e2e-plan-council-${id}-v1`,
    worker: workerOptions,
  });
};

export const workflow = defineWorkflow({
  name: "prism-workflow-e2e-plan-council",
  run: (wf) =>
    Effect.gen(function* () {
      const lenses = yield* Effect.all(
        [
          wf.runTask(lensTask("grok-worker-lens", "grok", "Grok worker invocation, headless flags, and generated plugin behavior")),
          wf.runTask(lensTask("grok-ops-lens", "grok", "E2E operations runbook, temp roots, live roots, and evidence capture")),
          wf.runTask(lensTask("claude-contract-lens", "claude-code", "Contracts, schemas, modelspace refs, and fail-closed behavior")),
          wf.runTask(lensTask("claude-risk-lens", "claude-code", "Risk review before live harness mutation and Tower dispatches")),
          wf.runTask(lensTask("opencode-direct-lens", "opencode", "OpenCode direct agent mode and no default-agent fallback")),
        ],
        { concurrency: "unbounded" },
      );

      const fusion = yield* wf.runTask(
        defineTask({
          id: "fusion-review",
          agent: orchestrator,
          prompt: `Fuse these council reports into a concise implementation review.

Reports:
${JSON.stringify(lenses, null, 2)}

Rules:
- Preserve real dissent.
- Separate changes required before committed regression tests from changes required only before live harness runs.
- Prefer actions that can be checked by bun tests or prism workflow validate/run.
- Return only JSON matching the schema.`,
          output: FusionReview,
          cacheKey: "prism-e2e-plan-council-fusion-v1",
          worker: { worker: "claude-code", model: "sonnet" },
        }),
      );

      return { lenses, fusion };
    }),
});
