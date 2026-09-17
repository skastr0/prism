/**
 * Workflow authoring skill embedded in the Prism CLI.
 * Plugins are optional. This skill is product documentation, not plugin data.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { prismWorkflowAuthoringSkillPath } from "./paths.js";

export const WORKFLOW_AUTHORING_SKILL_NAME = "prism-workflow";

export const renderWorkflowAuthoringSkillMarkdown = (): string => `---
name: ${WORKFLOW_AUTHORING_SKILL_NAME}
description: Author and run Prism workflows — typed task graphs over real harness CLIs. Use when writing, typechecking, validating, or running a *.workflow.ts. Plugins are optional.
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

\`jev({ id, state, questions, model?, timeoutMs?, cacheKey? })\` — one TypeSafe System One request answers many typed questions (\`choice\` / \`score\` / \`noul\`) about one shared JSON \`state\`. Use it for classification/routing batches instead of worker fan-out: all items in \`state\`, all questions in \`questions\`, one call. State entries are strings/objects/arrays/null only (serialize numbers). The question id does not bind a question to a state item — pin the subject in \`instructions\`. ~28k estimated-token request budget; over it, shard the state into more jev tasks with the same questions. No prompt, repairs, or judges; failures are typed \`JevError\` kinds. Needs \`TYPESAFE_API_KEY\`. Ad hoc: \`prism jev ask --input '<json>' [--json-errors]\`; agents: the \`jev/systemone_ask\` tool. Full doctrine: docs/workflows.md "Jev tasks".

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
| \`skill\` | Print this guide |
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

The complete field reference is in the Prism repo at \`docs/workflows.md\` (tasks, finish criteria, cache, ledger, workers). This skill is the flagship path: models, scaffold, validate, run — no plugin required.
`;

export const writeWorkflowAuthoringSkill = async (
  prismHome: string,
): Promise<{ readonly path: string; readonly bytes: number }> => {
  const path = prismWorkflowAuthoringSkillPath(prismHome);
  const markdown = renderWorkflowAuthoringSkillMarkdown();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return { path, bytes: markdown.length };
};

export { writeWorkflowModelsSkill } from "./models-skill.js";
