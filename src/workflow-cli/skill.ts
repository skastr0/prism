/**
 * Workflow authoring skill embedded in the Prism CLI.
 * Plugins are optional. This skill is product documentation, not plugin data.
 *
 * `SKILL.md` stays a routing body; the depth lives in `references/`. Both are
 * generated from this binary, so the CLI is the single source of truth for what
 * an agent is told — `--write` materializes them under PRISM_HOME and
 * `--install` drops them into detected harness skill directories.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddedSkill, EmbeddedSkillFile } from "./skill-files.js";
import { prismWorkflowAuthoringSkillPath } from "./paths.js";
import { WORKFLOW_SKILL_REFERENCES } from "./skill-references/index.js";

export const WORKFLOW_AUTHORING_SKILL_NAME = "prism-workflow";

export const renderWorkflowAuthoringSkillMarkdown = (): string => `---
name: ${WORKFLOW_AUTHORING_SKILL_NAME}
description: Author and run Prism workflows — typed task graphs over real harness CLIs. Use when writing, typechecking, validating, running, scheduling, or debugging a *.workflow.ts. Plugins are optional.
---

# Prism workflows

Workflows are the flagship. A \`.workflow.ts\` file dispatches real harness CLIs (\`cursor\`, \`amp-code\`, \`claude-code\`, …). A Prism plugin is an optional add-on for compiled \`sops.*\` phase bindings.

Live runs spend real tokens. Rehearse with \`typecheck\`, \`validate\`, and \`--mock-output\`.

## First moves (no plugin)

\`\`\`bash
prism workflow refresh-harness-types
prism workflow models --offer
# Stop. Quiz the user from that offer. Save only their answer:
#   prism workflow models prefer <worker> --model <slug>
# Amp catalog: --catalog-model <slug> [--effort <value>]
prism workflow scaffold hello
prism workflow typecheck ~/.prism/workflows/hello.workflow.ts
prism workflow validate ~/.prism/workflows/hello.workflow.ts --table
prism workflow run ~/.prism/workflows/hello.workflow.ts --mock-output mocks.json
\`\`\`

Print this skill anytime: \`prism workflow skill\`. Model quiz: \`prism workflow skill --models\`.

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

export const workflow = defineWorkflow({
  name: "hello",
  tasks: [defineTask({
    id: "cursor",
    prompt: "Reply with summary: hello",
    output: Schema.Struct({ summary: Schema.String }),
    worker: { worker: "cursor" }, // omit model → harness default. Pin only from \`prism workflow models --offer\`.
  })],
});
\`\`\`

A task is \`id\`, \`prompt\`, an Effect Schema \`output\`, and an optional \`worker\`, \`finish\`, \`phase\`, and \`cacheKey\`. The dynamic form takes \`run: (wf) => Effect.gen(...)\` and threads typed outputs between tasks with \`yield* wf.runTask(task)\` — use it whenever the graph branches, loops, or fans out. There is no \`agent\` field on a task.

- \`worker.model\` is harness-bound. There is no shared model type.
- Cursor slugs are effort-suffixed. \`gemini-3.8-flash\` is not a slug; use \`gemini-3.8-flash-low|medium|high\`.
- OMP pins are \`provider/id\` selectors from \`omp models --json\` (e.g. \`ollama-cloud/glm-5.3-flash\`). Bare ids such as \`gpt-5.6-luna\` are not selectors. \`opencode-go/*\` is Console Go and 400s in workflow \`--print\` (\`MissingSessionID\`). Thinking stays on \`--thinking\` / a \`:high\` config suffix, not \`worker.effort\`.
- Amp: \`worker.model\` is a \`--mode\` dial (\`low|medium|high|ultra\`) or plugin key. Catalog slugs go in \`worker.catalogModel\`. Reasoning goes in \`worker.effort\`. Example: \`{ worker: "amp-code", catalogModel: "anthropic/claude-haiku-4-5-20251001", effort: "none" }\`.
- Discover slugs: \`prism workflow models --offer\` then \`--worker <id> --query <text>\`. Do not invent slugs.
- \`worker.permission\` is harness-bound. Do not copy Codex \`sandbox-read-only\` onto Claude, Grok, Amp, or OMP.

| Worker | Allowed \`permission\` |
|---|---|
| \`claude-code\` | \`legacy\` \`permissive\` \`restricted\` (+ \`restrictedTools\`) \`full-access\` |
| \`codex-cli\` | \`legacy\` \`permissive\` \`full-access\` \`sandbox-read-only\` \`sandbox-workspace-write\` |
| \`cursor\` | \`legacy\` \`permissive\` \`full-access\` \`sandbox-workspace-write\` |
| \`devin\` \`omp\` | \`legacy\` \`permissive\` \`restricted\` \`full-access\` |
| \`amp-code\` \`antigravity-cli\` \`grok\` \`hermes\` \`kimi-code\` \`opencode\` \`opencode2\` | \`legacy\` \`permissive\` \`full-access\` |

## SOP phases (optional plugin)

A compiled plugin adds typed phase refs. Tasks have no agent field — bind a
phase with \`wf.phase\`, then \`ctx.task({ worker, prompt })\`:

\`\`\`ts
import { Effect } from "effect";
import { defineWorkflow } from "prism";
import { sops } from "prism/refs/sops";

export const workflow = defineWorkflow({
  name: "forge-explore",
  run: (wf) =>
    Effect.gen(function* () {
      return yield* wf.phase(sops.forge.forge.phases.explore, (ctx) =>
        ctx.task({
          id: "explore",
          worker: { worker: "claude-code" },
          prompt: "Inspect the repo; return seams, risks, and a direction.",
        }),
      );
    }),
});
\`\`\`

\`wf.phase\` applies the SOP's input/output schemas, acceptance criteria, and
framing. Discover what is compiled here: \`prism workflow catalog --sop forge\`.
Refs live at \`~/.prism/state/projects/<key>/generated/\` — run from the repo
root so the project key matches. If \`prism workflow refs\` is missing/stale,
refresh the plugin (not required for plugin-free workflows).

## Jev decisions (no worker)

\`jev({ id, state, questions, model?, timeoutMs?, cacheKey? })\` — one TypeSafe System One request answers many typed questions (\`choice\` / \`score\` / \`noul\`) about one shared JSON \`state\`. Use it for classification/routing batches instead of worker fan-out: all items in \`state\`, all questions in \`questions\`, one call. State is one entry: a string, JSON object/array, or null (serialize bare numbers; nested numbers are fine). The question id does not bind a question to a state item — pin the subject in \`instructions\`. ~28k estimated-token request budget; over it, shard the state into more jev tasks with the same questions. No prompt, repairs, or judges; failures are typed \`JevError\` kinds. Needs \`TYPESAFE_API_KEY\`. Ad hoc: \`prism jev ask --input '<json>' [--json-errors]\`; agents: the \`jev/systemone_ask\` tool. Full doctrine: [references/jev.md](references/jev.md).

## Scheduling (no daemon required to author)

A workflow may declare \`schedule: { cron, timezone, overlap, missedRuns }\`. **Declaring registers nothing** — \`prism workflow schedule install <file>\` registers it, and \`prism workflow scheduler serve\` launches it. Full semantics: [references/scheduling.md](references/scheduling.md).

## Commands (all plugin-free)

| Command | What it does |
|---|---|
| \`models\` | Live harness slugs. \`--offer\` quizzes with samples + prefs. \`prefer\` saves them |
| \`catalog\` | Workers + slug counts. \`--query\` searches models when no plugin |
| \`scaffold <name>\` | Starter in \`~/.prism/workflows/\` with typed pins when a snapshot exists |
| \`refresh-harness-types\` | Write \`prism/harnesses\` unions from installed CLIs |
| \`typecheck <file>\` | Generated tsconfig + shipped declarations |
| \`validate <file>\` | Every probed pin: worker, model, catalog, effort, permission |
| \`run <file>\` | Dispatch. Add \`--mock-output\` to rehearse |
| \`runs\` | Run history: \`list\` \`show\` \`summary\` \`events\` \`trace\` \`wait\` \`stop\` \`update\` \`resume\` \`inspect\` \`export\` \`delete\` \`prune\` |
| \`cache\` | Persisted task cache entries |
| \`schedule\` | \`install\` \`list\` \`show\` \`enable\` \`disable\` \`remove\` |
| \`scheduler\` | \`serve\` \`reconcile\` \`install-service\` \`uninstall-service\` \`status\` |
| \`skill\` | Print this guide. \`--models\` prints the quiz. \`--write\` / \`--install\` place both |
| \`refs\` | Optional compiled plugin refs |

Workflow files live in \`~/.prism/workflows/\`, never inside the repo they drive.

## Pinning models

1. \`prism workflow refresh-harness-types\`
2. \`prism workflow models --offer\` — workers, slug counts, five-slug samples, current prefs
3. Quiz the user from the offer. Save only their answer: \`prism workflow models prefer <id> --model <slug>\` (Amp catalog: \`--catalog-model\`)
4. Copy a stated preference into \`worker.model\` (Amp: \`catalogModel\` / \`effort\`). No preference → omit the field so the harness default stays.

If typecheck rejects a family name, the error should list the effort-suffixed slugs. Fix the one-line pin; do not invent a shared model type. Never write \`model: ""\`.

## Validate before you spend

\`prism workflow validate <file> --table\` lists every task the \`run:\` graph dispatches, including Amp catalog/effort. Illegal Amp efforts and illegal \`worker.permission\` values fail closed with the same remediation as run.

## Full DSL

This skill covers the flagship path: models, scaffold, validate, run — no plugin required. The complete field reference is in the Prism repo: \`docs/workflows.md\` (tasks, finish criteria, cache, ledger, workers, Jev) and \`docs/workflow-scheduling.md\` (cron, cursor, overlap, the scheduler).
`;

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
