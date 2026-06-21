/**
 * Heterogeneous council → fusion plan for Prism workflow authoring DX.
 *
 * Run from the prism git root (refs resolve to ~/.prism/state/projects/<key>/generated):
 *   prism workflow validate workflows/prism-workflow-premium-council.workflow.ts
 *   prism workflow run workflows/prism-workflow-premium-council.workflow.ts
 *
 * Parallel explore: grok + opencode + claude-code (same brief, different harnesses).
 * Sequential fuse: claude-code orchestrator synthesizes a single premium roadmap.
 */
import { Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { agents } from "prism/refs";

const COUNCIL_BRIEF = `You are on a product+platform council improving Prism workflow authoring, execution, and maintenance.

Context:
- Prism = language + runtime (defineWorkflow/defineTask, workers, cache, finish criteria, prism/refs).
- Orbits (Forge, Beacon, Atelier, …) = our framework; orbit skills carry phase workflow specs.
- Generated refs live at ~/.prism/state/projects/<sha256(git-root)>/generated/{agents,models,orbits,skills,traits,tools}.ts
- Workers: amp-code, claude-code, codex-cli, grok, hermes (--profile), kimi-code, opencode.

Your lens: recommend concrete, shippable improvements for:
1) The prism skill + workflow-authoring reference (discoverability, catalog, no-brainer authoring).
2) Prism compile emitters: orbit-workflow skills, per-orbit workflow routing, workflow-catalog.md (or OpenAPI-style workflow surface docs).
3) Prism CLI: workflow docs/refs catalog, typecheck auto-detection, init/scaffold, maintenance commands.
4) Where compiled docs should live: global Hermes skill vs per-project .prism vs per-orbit prism-workflows skill.

Constraints:
- Prefer compile-time truth over hand-maintained READMEs.
- Keep orbit protocol (Tower) separate from workflow execution unless explicitly bridged.
- Name files, commands, and artifact paths precisely.
- Disagree constructively when another harness would choose differently.

Inspect the prism repo and prism skill sources when helpful.

Return JSON matching the output schema only.`;

const CouncilLensReport = Schema.Struct({
  harness: Schema.Literal("grok", "codex-cli", "claude-code"),
  headline: Schema.String,
  summary: Schema.String,
  recommendations: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      rationale: Schema.String,
      surfaces: Schema.Array(Schema.String),
      effort: Schema.Literal("S", "M", "L"),
    }),
  ),
  cliCommands: Schema.Array(Schema.String),
  compileArtifacts: Schema.Array(Schema.String),
  skillChanges: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  dissent: Schema.optional(Schema.String),
});

const FusionPlan = Schema.Struct({
  executiveSummary: Schema.String,
  rankedInitiatives: Schema.Array(
    Schema.Struct({
      rank: Schema.Number,
      title: Schema.String,
      outcome: Schema.String,
      owner: Schema.Literal("prism-core", "prism-skill", "orbit-compiler", "docs-emit"),
      milestones: Schema.Array(Schema.String),
    }),
  ),
  proposedCliSurface: Schema.Struct({
    commands: Schema.Array(Schema.String),
    flags: Schema.Array(Schema.String),
    examples: Schema.Array(Schema.String),
  }),
  compileOutputsDebate: Schema.Struct({
    recommendation: Schema.String,
    options: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        pros: Schema.Array(Schema.String),
        cons: Schema.Array(Schema.String),
      }),
    ),
  }),
  openQuestions: Schema.Array(Schema.String),
  councilConsensus: Schema.Array(Schema.String),
  councilDissent: Schema.Array(Schema.String),
});

const explorer = agents.forge.explorer;
const orchestrator = agents.forge.orchestratorEngineer;

const councilTask = (
  id: "explore-grok" | "explore-codex" | "explore-claude",
  harness: "grok" | "codex-cli" | "claude-code",
) =>
  defineTask({
    id,
    agent: explorer,
    prompt: `${COUNCIL_BRIEF}\n\nSpeak from the strengths and limits of the **${harness}** harness you are running under. Set harness field to "${harness}".`,
    output: CouncilLensReport,
    cacheKey: `prism-premium-council-${harness}-v1`,
    worker: { worker: harness },
  });

export const workflow = defineWorkflow({
  name: "prism-workflow-premium-council",
  run: (wf) =>
    Effect.gen(function* () {
      const [grokLens, codexLens, claudeLens] = yield* Effect.all(
        [
          wf.runTask(councilTask("explore-grok", "grok")),
          wf.runTask(councilTask("explore-codex", "codex-cli")),
          wf.runTask(councilTask("explore-claude", "claude-code")),
        ],
        { concurrency: "unbounded" },
      );

      const fusion = yield* wf.runTask(
        defineTask({
          id: "fuse-roadmap",
          agent: orchestrator,
          prompt: `Fuse three council lenses into one premium Prism workflow DX roadmap.

Grok lens:
${JSON.stringify(grokLens, null, 2)}

Codex CLI lens:
${JSON.stringify(codexLens, null, 2)}

Claude Code lens:
${JSON.stringify(claudeLens, null, 2)}

Rules:
- Merge duplicates; preserve valuable dissent in councilDissent.
- Rank initiatives by leverage for "no-brainer" workflow authoring for orbit + ad-hoc (Hermes council) cases.
- proposedCliSurface must include a prism workflow docs (or equivalent) and how it relates to compile-emitted OpenAPI-style workflow surface docs.
- compileOutputsDebate must compare: (A) global prism skill reference, (B) per-project generated catalog under ~/.prism/state, (C) per-orbit prism-workflows skills.
- Be concrete enough that an engineer can open issues immediately.`,
          output: FusionPlan,
          cacheKey: "prism-premium-council-fusion-v1",
          worker: {
            worker: "claude-code",
          },
        }),
      );

      return {
        lenses: { grok: grokLens, codex: codexLens, claude: claudeLens },
        fusion,
      };
    }),
});