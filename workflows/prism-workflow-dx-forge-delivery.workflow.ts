/**
 * Forge-orbit end-to-end delivery for Prism workflow DX (post–premium-council fusion).
 *
 * Implements ranked initiatives from `prism-workflow-premium-council` as real code in
 * `Projects/prism`, with Forge-shaped phases, typed handoffs, parallel review, and
 * a fail-closed QA gate.
 *
 * Explore, build, and review dispatch through the compiled forge orbit's phase
 * surface (`orbits.forge.forge.phases.*`): agents, criteria, and framing come
 * from that generated data — this file adds only the output contract each
 * phase leaves author-owned (the orbit declares no per-phase JSON-schema
 * contract yet) plus the task-specific prompt content. Commit, synthesis, and
 * the final delivery report are orchestrator judgment calls the compiled
 * orbit surface does not project as phases, so they stay direct
 * `agents.forge.*` tasks outside any phase.
 *
 * Tower glyphs are represented as **CommittedGlyphPack** JSON in this workflow
 * (workflow harnesses do not mount Tower MCP by default). Builders treat packs as
 * the committed contract; reviewers trace acceptance criteria from the pack.
 *
 * Prerequisites:
 *   - Run from prism git root (prism/refs -> generated agents + orbits for this project).
 *   - The forge plugin must be refreshed against this project so orbits.ts carries
 *     forge's explore/build/review phases, e.g.:
 *       prism refresh <forge-plugin-path> --harness claude-code --compile-only --project <this-repo>
 *   - Optional: council fusion JSON at workflows/fixtures/prism-dx-fusion-brief.json
 *     or path in env PRISM_DX_FUSION_BRIEF (builders read via shell in harness).
 *
 * Validate:
 *   prism workflow validate workflows/prism-workflow-dx-forge-delivery.workflow.ts
 *
 * Run (long; prefer persisted store + foreground):
 *   prism workflow run workflows/prism-workflow-dx-forge-delivery.workflow.ts \
 *     --max-concurrent-tasks 4 \
 *     --store ~/.prism/state/projects/<project-key>/workflows-dx-forge.sqlite
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";
import { orbits } from "prism/refs/orbits";

// --- Shared schemas (Forge handoff contracts) ---

const ValidationRow = Schema.Struct({
  command: Schema.String,
  result: Schema.Literal("passed", "failed", "skipped"),
  notes: Schema.String,
});

const AcceptanceRow = Schema.Struct({
  id: Schema.String,
  met: Schema.Boolean,
  evidence: Schema.String,
});

const ExploreReport = Schema.Struct({
  headline: Schema.String,
  recommendedDirection: Schema.String,
  seams: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  rejectedOptions: Schema.Array(
    Schema.Struct({
      option: Schema.String,
      whyNot: Schema.String,
    }),
  ),
  filesToTouch: Schema.Array(Schema.String),
});

const GlyphSpec = Schema.Struct({
  title: Schema.String,
  problem: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  outOfScope: Schema.Array(Schema.String),
});

const CommittedPlan = Schema.Struct({
  programTitle: Schema.String,
  glyphs: Schema.Array(GlyphSpec),
  implementationOrder: Schema.Array(Schema.String),
  globalConstraints: Schema.Array(Schema.String),
});

const BuildReport = Schema.Struct({
  glyphTitle: Schema.String,
  status: Schema.Literal("built", "blocked", "escalate"),
  summary: Schema.String,
  commitSha: Schema.optional(Schema.String),
  filesChanged: Schema.Array(Schema.String),
  validation: Schema.Array(ValidationRow),
  acceptanceCriteria: Schema.Array(AcceptanceRow),
  blockers: Schema.Array(Schema.String),
});

const ReviewFinding = Schema.Struct({
  reviewer: Schema.String,
  verdict: Schema.Literal("pass", "pass-with-notes", "return-to-build", "block"),
  summary: Schema.String,
  findings: Schema.Array(
    Schema.Struct({
      severity: Schema.Literal("info", "warning", "critical"),
      topic: Schema.String,
      evidence: Schema.String,
      recommendation: Schema.String,
    }),
  ),
  humanSignoffRequired: Schema.Boolean,
});

const ReviewSynthesis = Schema.Struct({
  overallVerdict: Schema.Literal("ship", "return-to-build", "block", "evolve-only"),
  summary: Schema.String,
  clearedRisks: Schema.Array(Schema.String),
  openFindings: Schema.Array(Schema.String),
  nextActions: Schema.Array(Schema.String),
  backlogPromotions: Schema.Array(
    Schema.Struct({
      pattern: Schema.String,
      sink: Schema.String,
      rationale: Schema.String,
    }),
  ),
});

const DeliveryReport = Schema.Struct({
  programComplete: Schema.Boolean,
  shippedInitiatives: Schema.Array(Schema.String),
  blockedInitiatives: Schema.Array(Schema.String),
  finalValidation: Schema.Array(ValidationRow),
  councilAlignmentNotes: Schema.String,
});

type BuildReportT = Schema.Schema.Type<typeof BuildReport>;

// --- Forge orbit phase surface (agents, criteria, framing all compiled — never hand-listed) ---

const forge = orbits.forge.forge;

const REPO_ROOT = "/Users/guilhermecastro/Projects/prism";

const FORGE_SKILLS = `Load and follow these skills when relevant: forge, prism (workflow-authoring), software-development-practices, consolidation-engineering, testing, atomic-commits.`;

const FUSION_PROGRAM = `Premium council fusion program (ranked initiatives — implement in order, one glyph per build task):

1. Keystone: compile workflow-surface.json (+ human workflow-catalog.md) under ~/.prism/state/projects/<key>/generated/ — manifestHash, JSON Schema per task, no Tower/glyph/signal IDs in surface.
2. CLI: workflow catalog, workflow docs, workflow typecheck, workflows ls|show|graph, workflow refs; stale ref regen before reads.
3. Doc layering: per-project truth (B), per-orbit *-prism-workflows skill index (C), thin global prism skill index (A) — all projections of same surface.
4. Scaffold: init --with-workflow, workflow scaffold, generated authoring-reference from JSDoc + compiling examples.
5. Doctor/freshness: stale surface vs manifest; contamination scan fail-closed.
6. Maintenance: workflow cache prune, runs gc.

Non-goals: literal OpenAPI 3.1 export until surface stabilizes; Tower execution coupling; hand-maintained per-project inventory in global skill.`;

export const workflow = defineWorkflow({
  name: "prism-workflow-dx-forge-delivery",
  run: (wf) =>
    Effect.gen(function* () {
      const explore = yield* wf.phase(
        { ...forge.phases.explore, output: ExploreReport },
        (explore) =>
          explore.task({
            id: "explore-codebase",
            agent: explore.agents.codebaseArcheologist,
            prompt: `${FORGE_SKILLS}

Repo: ${REPO_ROOT}.

Inspect: src/compile/pipeline.ts, workflow-refs-emitter.ts, workflow-loader.ts, workflow-tsconfig.ts, cli workflow commands, docs/workflows/*, prism skill workflow-authoring.md install paths.

${FUSION_PROGRAM}

Deliver cold-pickup exploration: seams, files to touch, risks, rejected options, recommended direction.
Return ExploreReport JSON only.`,
            cacheKey: "prism-dx-forge-explore-v3",
            worker: { worker: "claude-code" },
          }),
      );

      const commit = yield* wf.runTask(
        defineTask({
          id: "commit-glyphs",
          agent: agents.forge.orchestratorEngineer,
          prompt: `${FORGE_SKILLS}

Forge **commit** — crystallize exploration into buildable glyphs (no Tower IDs in titles).

Exploration:
${JSON.stringify(explore, null, 2)}

${FUSION_PROGRAM}

Emit one glyph per ranked initiative (6 glyphs) with testable acceptance criteria and explicit out-of-scope.
Order: surface emitter → CLI → doc projections → scaffold → doctor → maintenance.
Return CommittedPlan JSON only.`,
          output: CommittedPlan,
          cacheKey: "prism-dx-forge-commit-v2",
          worker: { worker: "claude-code" },
        }),
      );

      const buildScopes: Array<{ id: string; title: string; scope: string }> = [
        {
          id: "build-01-surface",
          title: "Keystone workflow surface emitter",
          scope: `Add src/compile/workflow-surface-emitter.ts (and tests). Wire pipeline after syncWorkflowRefsForProject. Emit workflow-surface.json + workflow-catalog.md under generated/. Lift Effect Schema to JSON Schema per registered workflow task; stamp manifestHash. Refuse Tower/glyph/signal tokens in emitted surface.`,
        },
        {
          id: "build-02-cli",
          title: "CLI discovery and typecheck",
          scope: `Add prism workflow catalog|docs|typecheck and workflows ls|show|graph reading emitted surface. Export typecheck entry from workflow-loader. Auto-refresh stale refs before reads. Tests in cli.test.ts or dedicated workflow-cli tests.`,
        },
        {
          id: "build-03-doc-projections",
          title: "Three-layer doc projections",
          scope: `Emit per-orbit *-prism-workflows skill stubs at compile where routed; update prism skill install template to thin index (doctrine + discovery commands). Ensure workflow-catalog.md banner GENERATED — do not edit.`,
        },
        {
          id: "build-04-scaffold",
          title: "Authoring scaffold",
          scope: `init --with-workflow + workflow scaffold command; smoke.workflow.ts template; workflowDir in workflow-tsconfig generation.`,
        },
        {
          id: "build-05-doctor",
          title: "Doctor and freshness",
          scope: `prism doctor checks: stale surface vs manifest, orphaned workflows, contamination scan. workflow run/validate warn or fail on manifestHash mismatch.`,
        },
        {
          id: "build-06-maintenance",
          title: "Cache and runs maintenance",
          scope: `prism workflow cache prune --keep N; workflow runs gc --older-than; dry-run flags; tests.`,
        },
      ];

      const builds: BuildReportT[] = yield* wf.phase(
        { ...forge.phases.build, output: BuildReport },
        (build) =>
          Effect.gen(function* () {
            const reports: BuildReportT[] = [];
            for (const spec of buildScopes) {
              const glyph = commit.glyphs.find((g) => g.title.includes(spec.title.split(" ")[0])) ?? {
                title: spec.title,
                problem: spec.scope,
                acceptanceCriteria: ["Implementation merged with passing tests"],
                constraints: commit.globalConstraints,
                outOfScope: [],
              };
              const report = yield* build.task({
                id: spec.id,
                agent: build.agents.builder,
                prompt: `${FORGE_SKILLS}

Repo: ${REPO_ROOT}.

Committed glyph: **${glyph.title}**

${FUSION_PROGRAM}

Glyph scope for this task:
${glyph.problem}

${spec.scope}

Acceptance:
${glyph.acceptanceCriteria.join("\n")}

Prior build reports (do not redo completed work; integrate):
${JSON.stringify(reports, null, 2)}

Rules:
- Stay inside glyph scope; note scope creep as blockers, do not silently expand.
- Produce real code changes in ${REPO_ROOT}; run validation (bun test targeted paths, prism workflow validate on touched workflows).
- Prefer atomic commits; return commitSha when you commit, else blocked with reason.
- NEVER embed glyph IDs, signal IDs, or board state names in source, tests, paths, or public contracts.
- Return JSON matching BuildReport only.`,
                cacheKey: `prism-dx-forge-build-${spec.id}-v3`,
                worker: { worker: "claude-code" },
              });
              reports.push(report);
              if (report.status === "escalate") break;
            }
            return reports;
          }),
      );

      const { qaGate, reviews } = yield* wf.phase(
        { ...forge.phases.review, output: ReviewFinding },
        (review) =>
          Effect.gen(function* () {
            const qaGate = yield* review.task({
              id: "qa-integration-gate",
              agent: review.agents.verificationReviewer,
              prompt: `${FORGE_SKILLS}

QA integration gate before review fan-out.

Build reports:
${JSON.stringify(builds, null, 2)}

In ${REPO_ROOT}: run bun test for workflow/compile/cli areas touched; prism workflow validate workflows/*.workflow.ts; prism compile dry path if applicable.

Return ReviewFinding JSON (verdict pass only if validation honestly passed).`,
              cacheKey: "prism-dx-forge-qa-gate-v3",
              worker: { worker: "claude-code" },
            });

            // Data-driven review-lens fan-out: every agent the compiled review
            // phase declares is its own lens (its description doubles as the
            // lens statement) — never a hand-picked reviewer array.
            const reviewEntries = Object.entries(review.agents);
            const reviews = yield* Effect.all(
              reviewEntries.map(([key, agent]) => {
                const id = `review-${key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
                return review.task({
                  id,
                  agent,
                  prompt: `${FORGE_SKILLS}

Forge **review** phase — lens: ${agent.description}

Committed plan:
${JSON.stringify(commit, null, 2)}

Build reports to review:
${JSON.stringify(builds, null, 2)}

Review the cumulative diff in ${REPO_ROOT} (read files). Trace acceptance criteria from glyphs.
Fail closed on: missing tests for new CLI/emitters, glyph/signal contamination in workflow surface, duplicate doc sources of truth, incomplete migrations.

Return JSON matching ReviewFinding only.`,
                  cacheKey: `prism-dx-forge-${id}-v3`,
                  worker: { worker: "codex-cli" },
                });
              }),
              { concurrency: "unbounded" },
            );

            return { qaGate, reviews };
          }),
      );

      const synthesis = yield* wf.runTask(
        defineTask({
          id: "synthesize-review",
          agent: agents.forge.orchestratorEngineer,
          prompt: `${FORGE_SKILLS}

Forge orchestrator: synthesize review verdict.

QA gate:
${JSON.stringify(qaGate, null, 2)}

Reviewer findings:
${JSON.stringify(reviews, null, 2)}

Build reports:
${JSON.stringify(builds, null, 2)}

Decide ship | return-to-build | block | evolve-only. Promote recurring gaps to backlogPromotions per forge-backpressure spirit.
Return ReviewSynthesis JSON only.`,
          output: ReviewSynthesis,
          cacheKey: "prism-dx-forge-synthesis-v2",
          worker: { worker: "claude-code" },
        }),
      );

      const delivery = yield* wf.runTask(
        defineTask({
          id: "delivery-report",
          agent: agents.forge.explorer,
          prompt: `${FORGE_SKILLS}

Final delivery report for Guilherme.

Synthesis:
${JSON.stringify(synthesis, null, 2)}

Map shipped vs blocked initiatives vs council fusion program. List exact commands to verify on mac-mini.
Return DeliveryReport JSON only.`,
          output: DeliveryReport,
          cacheKey: "prism-dx-forge-delivery-v2",
          worker: { worker: "claude-code" },
        }),
      );

      return {
        explore,
        commit,
        builds,
        qaGate,
        reviews,
        synthesis,
        delivery,
      };
    }),
});
