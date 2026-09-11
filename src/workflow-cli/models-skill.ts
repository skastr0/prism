/**
 * Embedded skill: quiz the user for workflow model preferences.
 * Product documentation, not plugin data.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { prismWorkflowModelsSkillPath } from "./paths.js";

export const WORKFLOW_MODELS_SKILL_NAME = "prism-workflow-models";

export const renderWorkflowModelsSkillMarkdown = (): string => `---
name: ${WORKFLOW_MODELS_SKILL_NAME}
description: Quiz the user for Prism workflow model preferences and save them. Use the first time you write a *.workflow.ts, when the user says re-quiz / update models / preferred models, or when a worker has no stated preference. Do not invent slugs.
---

# Prism workflow models

Agents have no intuition for which model to pin. Do not guess. Do not copy a slug from memory.

An unpinned worker (\`{ worker: "cursor" }\` with no \`model\`) is correct. Prism omits the harness model flag so the user's harness default stays in force.

## First write, or re-quiz

1. \`prism workflow refresh-harness-types\` if there is no snapshot.
2. \`prism workflow models --offer\` (or \`--json --offer\`). This lists every worker, its slug count, a sample of up to five slugs, and any already-stated preferences.
3. Show that offer to the user. Ask which workers they use and which slug (Amp: \`catalogModel\` + \`effort\`) they want for each. They may say "leave this worker on my harness default".
4. Save with \`prism workflow models prefer <id> --model <slug>\` (Amp: \`--catalog-model\` / \`--effort\`). Clear a pin with \`--clear\`. Write a free-form note with \`--notes\`.
5. When writing a task, copy a stated preference into \`worker.model\` / \`catalogModel\` / \`effort\`. If there is no preference, omit those fields.

Re-quiz anytime. The offer reprints current preferences next to the live inventory so the user can change one worker without redoing the rest.

## Commands

\`\`\`bash
prism workflow models --offer
prism workflow models prefer cursor --model composer-2.5-fast
prism workflow models prefer amp-code --catalog-model anthropic/claude-haiku-4-5-20251001 --effort none
prism workflow models prefer grok --clear
prism workflow models prefer --notes "cheap cursor; opus only for review"
\`\`\`

Preferences live at \`~/.prism/state/workflow-model-preferences.json\`. Print this skill: \`prism workflow skill --models\`.

## Pinning rules

- \`worker.model\` is harness-bound. There is no shared model type.
- Cursor slugs are effort-suffixed. \`gemini-3.8-flash\` is not a slug; use \`gemini-3.8-flash-low|medium|high\`.
- Amp: \`worker.model\` is a \`--mode\` dial (\`low|medium|high|ultra\`) or plugin key. Catalog slugs go in \`worker.catalogModel\`. Reasoning goes in \`worker.effort\`.
- OMP pins are \`provider/id\` from \`omp models --json\`. \`opencode-go/*\` 400s in workflow \`--print\`.
- Discover more slugs: \`prism workflow models --worker <id> --query <text>\`.
- Never write \`model: ""\`. Omit the field.

Scaffold and type generation use stated preferences when present and otherwise omit the model field.
`;

export const writeWorkflowModelsSkill = async (
  prismHome: string,
): Promise<{ readonly path: string; readonly bytes: number }> => {
  const path = prismWorkflowModelsSkillPath(prismHome);
  const markdown = renderWorkflowModelsSkillMarkdown();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return { path, bytes: markdown.length };
};
