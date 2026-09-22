/**
 * Workflow authoring skill embedded in the Prism CLI.
 * Plugins are optional. This skill is product documentation, not plugin data.
 *
 * `SKILL.md` stays a routing body; the depth lives in `references/`. Both are
 * generated from this binary, so the CLI is the single source of truth for what
 * an agent is told — `--write` materializes them under PRISM_HOME and
 * `--install` drops them into detected harness skill directories.
 *
 * Two renderings share one body:
 *
 * - `renderWorkflowAuthoringSkillMarkdown()` — the static embedded copy that
 *   is written and installed. Installed skills are static, so the body itself
 *   instructs the agent to fetch fresh context with `prism workflow skill`.
 * - `renderWorkflowSkillMarkdown(context)` — what `prism workflow skill`
 *   prints: the same body plus the machine's current installed named-worker
 *   catalog and the current project's compiled SOP refs. One normal skill call
 *   is enough to author with named workers.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddedSkill, EmbeddedSkillFile } from "./skill-files.js";
import { prismWorkflowAuthoringSkillPath } from "./paths.js";
import { WORKFLOW_SKILL_REFERENCES } from "./skill-references/index.js";
import { namedWorkerRef, type WorkflowWorkerCatalog } from "../workflow-named-workers.js";

export const WORKFLOW_AUTHORING_SKILL_NAME = "prism-workflow";

/** Current-context inputs the printed skill embeds. */
export interface WorkflowSkillContext {
  readonly workers: WorkflowWorkerCatalog;
  readonly project: {
    readonly surfaceDir: string;
    readonly present: boolean;
    readonly namespaces: ReadonlyArray<{ readonly namespace: string; readonly sopRefs: readonly string[] }>;
  };
}

const workflowSkillBody = (): string => `Workflows are the flagship. A \`.workflow.ts\` file dispatches real harness CLIs (\`cursor\`, \`amp-code\`, \`claude-code\`, …). A Prism plugin is an optional add-on for compiled \`sops.*\` phase bindings.

Live runs spend real tokens. Rehearse with \`typecheck\`, \`validate\`, and \`--mock-output\`.

## Start from current truth

Installed named workers and compiled project refs change independently of any skill copy. Before authoring, run \`prism workflow skill\` — it prints this guide plus the machine's current worker catalog and this project's refs. A static installed copy of this skill is a starting point, never the catalog.

## First moves

\`\`\`bash
prism workflow skill                                # this guide + current catalog + project refs
prism workflow workers                              # installed named workers (names, descriptions, configs)
prism workflow scaffold hello --worker <name>       # omit --worker to use the first curated entry
prism workflow typecheck ~/.prism/workflows/hello.workflow.ts
prism workflow validate ~/.prism/workflows/hello.workflow.ts --table
prism workflow run ~/.prism/workflows/hello.workflow.ts --mock-output mocks.json
\`\`\`

## Reference chapters

Read the one you need before you guess at semantics. They sit next to this file under \`references/\`.

| Chapter | Read it when |
|---|---|
| [references/topology.md](references/topology.md) | Choosing a shape — council → fusion, pipeline, build → QA gate → review → synthesize, adversarial verify, loop-until, mock-first. Also side-effecting tasks and multi-worker checkouts. |
| [references/cache-and-finish.md](references/cache-and-finish.md) | Setting \`cacheKey\`, reasoning about resume, or adding \`finish\` criteria (deterministic + judge, \`maxRepairs\`). |
| [references/observability.md](references/observability.md) | Reading a run — \`runs summary\` / \`events\` / \`trace\`, the machine-wide \`--all\` view, and stop → edit → resume. |
| [references/scheduling.md](references/scheduling.md) | Putting a workflow on a cron — the declare / install / serve gates and what each one does not do. |
| [references/jev.md](references/jev.md) | Batched classification or scoring over one shared state, without a worker. |

## Authoring surface

\`\`\`ts
import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { workers } from "prism/refs/workers";

export const workflow = defineWorkflow({
  name: "hello",
  tasks: [defineTask({
    id: "review",
    prompt: "Return a one-line summary in \\"summary\\".",
    output: Schema.Struct({ summary: Schema.String }),
    worker: workers.reviewer, // example ref — pick an installed name from \`prism workflow workers\`
  })],
});
\`\`\`

\`workers.reviewer\` is a typed ref to one installed named worker: its harness, model, effort, and permission were curated once in the catalog. The generated ref is literal raw config, so the existing DSL is unchanged — no new agent type.

Raw configurations remain available as the escape hatch:

\`\`\`ts
worker: { worker: "cursor" }  // omit model → harness default. Pin only slugs from \`prism workflow models\`.
\`\`\`

A task is \`id\`, \`prompt\`, an Effect Schema \`output\`, and an optional \`worker\`, \`finish\`, \`phase\`, and \`cacheKey\`. The dynamic form takes \`run: (wf) => Effect.gen(...)\` and threads typed outputs between tasks with \`yield* wf.runTask(task)\` — use it whenever the graph branches, loops, or fans out. There is no \`agent\` field on a task.

## Choosing a worker

Pick a named worker by its description — what it is for, its strengths, its limits — and state the goal in the prompt. Descriptions guide selection; they are never task instructions. Do not copy a worker description into a prompt, and do not re-derive harness or model choices the catalog already made. Multiple names may share one harness.

## Raw configurations (escape hatch)

Named workers are the primary path. When none fits, compose a raw \`worker: { worker, model, permission, ... }\` instead — the DSL takes it unchanged. Discover live slugs and the per-harness combination rules (model dials, Amp catalog slugs and effort, permission modes) with \`prism workflow skill --models\`; never invent a slug and never write \`model: ""\` — omit the field so the harness default stays.

## SOP phases (optional plugin)

A compiled plugin adds typed phase refs. Tasks have no agent field — bind a
phase with \`wf.phase\`, then \`ctx.task({ worker, prompt })\`:

\`\`\`ts
import { Effect } from "effect";
import { defineWorkflow } from "prism";
import { sops } from "prism/refs/sops";
import { workers } from "prism/refs/workers";

export const workflow = defineWorkflow({
  name: "forge-explore",
  run: (wf) =>
    Effect.gen(function* () {
      return yield* wf.phase(sops.forge.forge.phases.explore, (ctx) =>
        ctx.task({
          id: "explore",
          worker: workers.reviewer,
          prompt: "Inspect the repo; return seams, risks, and a direction.",
        }),
      );
    }),
});
\`\`\`

\`wf.phase\` applies the SOP's input/output schemas, acceptance criteria, and
framing. The refs compiled for this project are listed below when present.
Discover details: \`prism workflow catalog --sop <name>\`. Refs live at
\`~/.prism/state/projects/<key>/generated/\` — run from the repo root so the
project key matches.

## Jev decisions (no worker)

\`jev({ id, state, questions, model?, timeoutMs?, cacheKey? })\` — one TypeSafe System One request answers many typed questions (\`choice\` / \`score\` / \`noul\`) about one shared JSON \`state\`. Use it for classification/routing batches instead of worker fan-out: all items in \`state\`, all questions in \`questions\`, one call. State is one entry: a string, JSON object/array, or null (serialize bare numbers; nested numbers are fine). The question id does not bind a question to a state item — pin the subject in \`instructions\`. ~28k estimated-token request budget; over it, shard the state into more jev tasks with the same questions. No prompt, repairs, or judges; failures are typed \`JevError\` kinds. Needs \`TYPESAFE_API_KEY\`. Ad hoc: \`prism jev ask --input '<json>' [--json-errors]\`; agents: the \`jev/systemone_ask\` tool. Full doctrine: [references/jev.md](references/jev.md).

## Scheduling (no daemon required to author)

A workflow may declare \`schedule: { cron, timezone, overlap, missedRuns }\`. **Declaring registers nothing** — \`prism workflow schedule install <file>\` registers it, and \`prism workflow scheduler serve\` launches it. Full semantics: [references/scheduling.md](references/scheduling.md).

## Commands (all plugin-free)

| Command | What it does |
|---|---|
| \`workers\` | Installed named workers: names, descriptions, raw configs |
| \`workers install <files...>\` | Explicitly replace the installed catalog with portable JSON files (merges unique names, rejects duplicates) |
| \`workers export\` | Print the installed catalog as portable JSON (nothing is written to the source files) |
| \`models\` | Live harness slugs for raw pins. \`--offer\` samples; you combine pins explicitly |
| \`catalog\` | Workers + slug counts. \`--query\` searches models when no plugin |
| \`scaffold <name>\` | Starter in \`~/.prism/workflows/\`; \`--worker <name>\` binds an installed named worker |
| \`refresh-harness-types\` | Write \`prism/harnesses\` unions from installed CLIs |
| \`typecheck <file>\` | Generated tsconfig + shipped declarations |
| \`validate <file>\` | Every probed pin: worker, model, catalog, effort, permission |
| \`run <file>\` | Dispatch. Add \`--mock-output\` to rehearse |
| \`runs\` | Run history: \`list\` \`show\` \`summary\` \`events\` \`trace\` \`wait\` \`stop\` \`update\` \`resume\` \`inspect\` \`export\` \`delete\` \`prune\` |
| \`cache\` | Persisted task cache entries |
| \`schedule\` | \`install\` \`list\` \`show\` \`enable\` \`disable\` \`remove\` |
| \`scheduler\` | \`serve\` \`reconcile\` \`install-service\` \`uninstall-service\` \`status\` |
| \`skill\` | Print this guide with current workers + project refs. \`--models\` prints raw-pin discovery. \`--write\` / \`--install\` place the static embedded copy |
| \`refs\` | Optional compiled plugin refs |

Workflow files live in \`~/.prism/workflows/\`, never inside the repo they drive.

## Validate before you spend

\`prism workflow validate <file> --table\` lists every task the \`run:\` graph dispatches, including Amp catalog/effort. Illegal Amp efforts and illegal \`worker.permission\` values fail closed with the same remediation as run.

## Full DSL

This skill covers the flagship path: named workers, raw pins, scaffold, validate, run — no plugin required. The complete field reference is in the Prism repo: \`docs/workflows.md\` (tasks, finish criteria, cache, ledger, workers, Jev, named workers) and \`docs/workflow-scheduling.md\` (cron, cursor, overlap, the scheduler).`;

/** The static embedded skill: body plus the fresh-context instruction. */
export const renderWorkflowAuthoringSkillMarkdown = (): string => `---
name: ${WORKFLOW_AUTHORING_SKILL_NAME}
description: Author and run Prism workflows — typed task graphs over real harness CLIs, selecting curated named workers by description. Use when writing, typechecking, validating, running, scheduling, or debugging a *.workflow.ts. Plugins are optional.
---

# Prism workflows

${workflowSkillBody()}`;

const renderInstalledWorkersSection = (catalog: WorkflowWorkerCatalog): string => {
  if (catalog.workers.length === 0) {
    return [
      "## Installed named workers (current machine truth)",
      "",
      "No named workers installed. Install a portable catalog: `prism workflow workers install ./workers.json`. Raw worker configurations remain available.",
    ].join("\n");
  }
  return [
    "## Installed named workers (current machine truth)",
    "",
    'Import `{ workers } from "prism/refs/workers"` and set `worker: workers.<name>`. Choose by description; the description is selection guidance, never prompt content.',
    "",
    ...catalog.workers.flatMap(({ name, description, config }) => [
      `- \`${namedWorkerRef(name)}\` — ${description}`,
      `  Configuration: \`${JSON.stringify(config)}\``,
    ]),
  ].join("\n");
};

const renderProjectRefsSection = (project: WorkflowSkillContext["project"]): string => {
  if (!project.present) {
    return [
      "## Compiled SOP refs (this project)",
      "",
      `No compiled plugin refs at ${project.surfaceDir}. SOP phases are optional; compile with \`prism refresh <plugin-path>\` only if you want \`sops.*\`.`,
    ].join("\n");
  }
  const lines = Object.entries(groupNamespaces(project.namespaces)).flatMap(([namespace, sopRefs]) => [
    `- \`${namespace}\`: ${sopRefs.join(", ")}`,
  ]);
  return [
    "## Compiled SOP refs (this project)",
    "",
    `Import \`import { sops } from "prism/refs/sops";\` from the repo root. Surface: ${project.surfaceDir}`,
    ...lines,
  ].join("\n");
};

const groupNamespaces = (
  namespaces: ReadonlyArray<{ readonly namespace: string; readonly sopRefs: readonly string[] }>,
): Record<string, readonly string[]> =>
  Object.fromEntries(namespaces.filter((ns) => ns.sopRefs.length > 0).map((ns) => [ns.namespace, ns.sopRefs]));

/** What `prism workflow skill` prints: the body plus live catalog and project refs. */
export const renderWorkflowSkillMarkdown = (context: WorkflowSkillContext): string =>
  `${renderWorkflowAuthoringSkillMarkdown()}\n\n${renderInstalledWorkersSection(context.workers)}\n\n${renderProjectRefsSection(context.project)}\n`;

/** Every file of the authoring skill, relative to its own directory. */
export const workflowAuthoringSkillFiles = (): readonly EmbeddedSkillFile[] => [
  { relativePath: "SKILL.md", markdown: renderWorkflowAuthoringSkillMarkdown() },
  ...WORKFLOW_SKILL_REFERENCES,
];

export const workflowAuthoringSkill = (): EmbeddedSkill => ({
  name: WORKFLOW_AUTHORING_SKILL_NAME,
  files: workflowAuthoringSkillFiles(),
});

/**
 * Materialize the authoring skill (SKILL.md plus its reference chapters) under
 * PRISM_HOME. Returns every path written.
 */
export const writeWorkflowAuthoringSkill = async (
  prismHome: string,
): Promise<{ readonly path: string; readonly bytes: number; readonly files: readonly string[] }> => {
  const skillPath = prismWorkflowAuthoringSkillPath(prismHome);
  const skillDir = dirname(skillPath);
  const files: string[] = [];
  let bytes = 0;
  for (const file of workflowAuthoringSkillFiles()) {
    const target = join(skillDir, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, "utf8");
    files.push(target);
    bytes += file.markdown.length;
  }
  return { path: skillPath, bytes, files };
};

export { writeWorkflowModelsSkill } from "./models-skill.js";
