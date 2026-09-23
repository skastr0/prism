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

const workflowSkillBody = (): string => `Write a \`.workflow.ts\` directly with the Prism DSL. It dispatches real harness CLIs through curated workers; a plugin is optional and adds compiled \`sops.*\` phase bindings.

Live runs spend real tokens. Rehearse with \`typecheck\`, \`validate\`, and \`--mock-output\`.

## Start from current truth

Installed named workers and compiled project refs change independently of any skill copy. Before authoring, run \`prism workflow skill\` — it prints this guide plus the machine's current worker catalog and this project's refs. A static installed copy of this skill is a starting point, never the catalog.

## Author from the goal

1. Define the requested outcome, its inputs, and what evidence will establish success. Choose tasks and dependencies for that goal.
2. Choose installed workers by the descriptions in the current catalog. Use only the listed names; no worker name is built in. Inspect relevant SOP contracts with \`prism workflow catalog --sop <name>\` when compiled refs are present.
3. Write the workflow directly in \`<PRISM_HOME>/workflows/<name>.workflow.ts\` (default \`~/.prism/workflows/\`), outside the target repository. Run Prism from the target repo root; use absolute paths when tasks address another repo. Export \`workflow = defineWorkflow(...)\`.
4. Give each task a stable, unique \`id\`, a goal-specific \`prompt\`, an Effect Schema \`output\`, and its chosen \`worker\`. Use \`run: (wf) => Effect.gen(...)\` for data dependencies, branching, loops, and parallelism. A static \`tasks: [defineTask(...)]\` list is enough for independent tasks.
5. Include changing inputs in the prompt: commit SHA, file contents, upstream values the task actually needs. Cache reuse cannot detect changes hidden behind phrases like “the current diff.” Names and descriptions are not cache namespaces.
6. Typecheck, inspect validation, then mock each relevant branch before spending tokens. Fix the workflow itself when a check fails.

\`\`\`bash
prism workflow skill              # current catalog + project refs + this guide
# Write your goal-specific .workflow.ts with your file editor, then:
prism workflow typecheck ~/.prism/workflows/review-change.workflow.ts
prism workflow validate ~/.prism/workflows/review-change.workflow.ts --table
prism workflow run ~/.prism/workflows/review-change.workflow.ts --mock-output mocks.json
\`\`\`

## Reference chapters

Read the one you need before you guess at semantics. Installed copies include these files under \`references/\`. From any CLI installation, print one directly with \`prism workflow skill --reference <chapter>\`; no source checkout or skill installation is required.

| Chapter / \`--reference\` value | Read it when |
|---|---|
| [topology](references/topology.md) | Choosing a graph: pipeline, fan-out, loops, gates, or concurrent writers. |
| [cache-and-finish](references/cache-and-finish.md) | Cache identity, resume, deterministic checks, judges, and repairs. |
| [observability](references/observability.md) | Run evidence, waiting, cancellation, and stop → edit → resume. |
| [scheduling](references/scheduling.md) | Cron declaration, installation, and scheduler operation. |
| [jev](references/jev.md) | Typed classification or scoring over shared state without a worker. |

## DSL: typed data flows between tasks

This example inspects a specific commit, then reviews only its changed files. \`workers.reviewer\` is an example ref: substitute a suitable name from the current catalog. Set \`REVIEW_COMMIT\` to the full commit SHA before typecheck, validate, or run. The workflow needs no plugin.

\`\`\`ts
import { Config, Effect, Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { workers } from "prism/refs/workers";

export const workflow = defineWorkflow({
  name: "review-change",
  run: (wf) => Effect.gen(function* () {
    const revision = yield* Config.NonEmptyString("REVIEW_COMMIT");
    const inspected = yield* wf.runTask(defineTask({
      id: "inspect",
      prompt: "List the files changed by commit " + revision + ". Do not edit files.",
      output: Schema.Struct({ files: Schema.Array(Schema.String) }),
      worker: workers.reviewer,
    }));
    if (inspected.files.length === 0) return { findings: [] };

    return yield* wf.runTask(defineTask({
      id: "review",
      prompt: "Find correctness regressions in commit " + revision
        + " for these files: " + JSON.stringify(inspected.files)
        + ". Return concrete findings with file and line evidence; do not edit files.",
      output: Schema.Struct({ findings: Schema.Array(Schema.String) }),
      worker: workers.reviewer,
    }));
  }),
});
\`\`\`

\`workers.reviewer\` is a typed ref to one installed named worker: its harness, model, supported effort, and permission were curated once in the catalog. The generated ref is literal raw config, so the existing DSL is unchanged — no new agent type.

Raw configurations remain available as the escape hatch:

\`\`\`ts
worker: { worker: "cursor" }  // omit model → harness default. Pin only slugs from \`prism workflow models\`.
\`\`\`

A task is \`id\`, \`prompt\`, an Effect Schema \`output\`, and optional \`worker\`, \`finish\`, \`phase\`, and \`cacheKey\`. \`yield* wf.runTask(task)\` returns the decoded output, not a result wrapper. For independent tasks, \`yield* Effect.all([wf.runTask(a), wf.runTask(b)], { concurrency: 2 })\` runs both concurrently. Use ordinary \`if\` / \`for\` for branches and loops; give repeated tasks distinct ids. There is no \`agent\` field on a task and no session continuation implied by reusing a named worker.

\`mocks.json\` maps task ids to schema-valid outputs. For the example:

\`\`\`json
{
  "inspect": { "files": ["src/parser.ts"] },
  "review": { "findings": ["src/parser.ts:42 rejects a valid empty input."] }
}
\`\`\`

Also test the no-files branch with \`{ "inspect": { "files": [] } }\`. Use separate \`--store <path>\` ledgers for distinct mock cases so a cached output cannot mask a branch. Mock runs exercise the graph and schemas, not the live harness or the truth of a finding. Run without \`--mock-output\` only when ready for real inference.

## Choosing a worker

Pick a named worker by its description — what it is for, its strengths, its limits — and state the goal in the prompt. List the current names and configurations with \`prism workflow workers\`. Descriptions guide selection; they are never task instructions. Do not copy a worker description into a prompt, and do not re-derive harness or model choices the catalog already made. Multiple names may share one harness.

## Orbs and runners (remote executors)

\`amp-orb\` runs a task in a fresh hosted Amp orb on a project's own checkout; \`amp-runner\` runs it on an operator's \`amp --no-tui --runner-id <id>\` runner, in that machine's checkout. Choose by where the code must run, not by model. An orb returns only its final JSON: to bring code back, the prompt must tell it to commit and push a branch and return the branch or PR URL. A runner's edits land in the runner's working tree directly.

Named workers are the primary way to use them: one catalog entry pins the target once, and its description says what it is for. Install with \`prism workflow workers install ./workers.json\`:

\`\`\`json
{ "version": 1, "workers": [
  { "name": "orb-scout", "description": "Bounded repo inspection in a cheap hosted orb on the prism project.",
    "config": { "worker": "amp-orb", "project": "acme-ns/prism", "size": "a1.tiny", "model": "low" } },
  { "name": "macbook-builder", "description": "Heavy build and test runs on the operator's MacBook checkout.",
    "config": { "worker": "amp-runner", "runnerId": "macbook", "runnerDir": "/Users/me/Projects/prism" } }
] }
\`\`\`

- **Orb project.** Run \`prism workflow refresh-harness-types\`; it snapshots \`amp projects list --json\` and types \`worker.project\` against the discovered projects (namespace/name, owner/repo, or repository URL). Validation rejects an unknown project and lists the known ones. \`size\` picks the orb (\`a1.tiny\` … \`a1.3xlarge\`); omit it for the project default. A paused orb costs nothing.
- **Runner.** \`runnerId\` is the id the operator started the runner with. To discover the account-wide runners (every machine, not just this one) run \`prism workflow refresh-harness-types --discover-amp-runners\`: it spends one small Amp turn calling Amp's \`list_runners\` tool, snapshots each runner's id, host, and served directories, and deletes the thread it created. A plain refresh keeps a previously captured snapshot. With a snapshot, validation fails closed on an unknown runner id (it lists the live ones) and on a \`runnerDir\` that runner does not serve (it lists the served directories); without one, both stay plain strings. Offline runners fail at Amp spawn time.
- Both accept only \`permission: "legacy"\` (the default): the remote machine's Amp settings govern tools. Repairs continue the same Amp thread.

## Raw configurations (escape hatch)

Named workers are the primary path. When none fits, compose a raw \`worker: { worker, model, effort, permission, ... }\` instead. Discover live slugs and per-model effort sets with \`prism workflow skill --models\`; fixed values come from Prism's capability registry: Claude Code \`low|medium|high|xhigh|max\`, Antigravity CLI \`low|medium|high\`, Hermes \`none|minimal|low|medium|high|xhigh|max|ultra\`, Kimi Code \`low|medium|high|xhigh|max\`, OMP \`off|minimal|low|medium|high|xhigh|max|auto\`. Kimi Code receives effort through the undocumented \`KIMI_MODEL_THINKING_EFFORT\` environment variable set only on the spawned worker process. If the selected model's row in \`<KIMI_CODE_HOME>/config.toml\` declares \`support_efforts\`, validation checks the value against that subset. A task's \`worker.effort\` overrides effort on its modelspace target. Codex and OMP modelspace targets use \`effort\`; \`variant\` is a model-selection field only and produces a one-line migration fix there. Devin, Cursor, and OpenCode do not accept \`worker.effort\`; their model slugs or model-selection settings carry their own meaning. Never invent a slug and never write \`model: ""\` — omit the field so the harness default stays.

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
| \`refresh-harness-types\` | Write \`prism/harnesses\` unions from installed CLIs. \`--discover-amp-runners\` also snapshots the account-wide Amp runners (one small Amp turn) |
| \`typecheck <file>\` | Generated tsconfig + shipped declarations |
| \`validate <file>\` | Every probed pin: worker, model, catalog, effort, permission |
| \`run <file>\` | Dispatch. Add \`--mock-output\` to rehearse |
| \`runs\` | Run history: \`list\` \`show\` \`summary\` \`events\` \`trace\` \`wait\` \`stop\` \`update\` \`resume\` \`inspect\` \`export\` \`delete\` \`prune\` |
| \`cache\` | Persisted task cache entries |
| \`schedule\` | \`install\` \`list\` \`show\` \`enable\` \`disable\` \`remove\` |
| \`scheduler\` | \`serve\` \`reconcile\` \`install-service\` \`uninstall-service\` \`status\` |
| \`skill\` | Print this guide with current workers + project refs. \`--reference <chapter>\` prints a chapter; \`--models\` prints raw-pin discovery. \`--write\` / \`--install\` place the static embedded copy |
| \`refs\` | Optional compiled plugin refs |

Workflow files live in \`~/.prism/workflows/\`, never inside the repo they drive.

## Validate before you spend

\`prism workflow validate <file> --table\` reports the tasks and pins its probe can discover, including each worker's effective effort. Data-dependent branches still need mock runs with inputs that reach them; validation is not proof of every path. Unsupported or invalid effort values and illegal \`worker.permission\` values fail closed with a one-line fix before dispatch.

## Full DSL

Author directly with named workers or raw pins, then typecheck, validate, and run — no plugin required. For depth without a source checkout, use the reference chapters above and \`prism workflow <command> --help\`. The complete field reference also lives in the Prism repo: \`docs/workflows.md\` and \`docs/workflow-scheduling.md\`.`;

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
