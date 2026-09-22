/**
 * Embedded skill: discover live harness model slugs for raw worker pins.
 * Product documentation, not plugin data.
 *
 * This is the escape hatch next to named workers: when an author must compose
 * a raw `worker: { worker, model, ... }` configuration instead of picking an
 * installed named worker, this skill tells them how to find real slugs and how
 * the harness-bound fields combine. It is discovery, not a quiz — nothing is
 * saved, and no slug is ever invented.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddedSkill, EmbeddedSkillFile } from "./skill-files.js";
import { prismWorkflowModelsSkillPath } from "./paths.js";

export const WORKFLOW_MODELS_SKILL_NAME = "prism-workflow-models";

export const renderWorkflowModelsSkillMarkdown = (): string => `---
name: ${WORKFLOW_MODELS_SKILL_NAME}
description: Discover live harness model slugs for raw Prism workflow worker pins (worker.model / catalogModel / effort). Use when composing a raw worker configuration instead of an installed named worker, or when a pin fails validation. Do not invent slugs.
---

# Prism workflow models — raw pin discovery

Named workers are the primary path (\`prism workflow workers\`). When you must
compose a raw worker configuration instead, discover real slugs first — never
from memory.

## Discover, then combine

1. \`prism workflow refresh-harness-types\` if there is no snapshot.
2. \`prism workflow models --offer\` — every worker, its slug count, and a sample of up to five slugs.
3. Narrow with \`prism workflow models --worker <id> --query <text>\`.
4. Copy a slug you actually saw into the pin field. Omit \`model\` entirely to keep the harness default. Never write \`model: ""\`.

\`\`\`bash
prism workflow refresh-harness-types
prism workflow models --offer
prism workflow models --worker cursor --query opus
\`\`\`

## Combination rules

- \`worker.model\` is harness-bound. There is no shared model type.
- Cursor slugs are effort-suffixed. \`gemini-3.8-flash\` is not a slug; use \`gemini-3.8-flash-low|medium|high\`.
- Amp: \`worker.model\` is a \`--mode\` dial (\`low|medium|high|ultra\`) or plugin key. Catalog slugs go in \`worker.catalogModel\`. Reasoning goes in \`worker.effort\`. A dial in \`worker.model\` does not combine with \`catalogModel\` / \`effort\`.
- OMP pins are \`provider/id\` selectors from \`omp models --json\`. Bare ids are not selectors. \`opencode-go/*\` is Console Go and 400s in workflow \`--print\`.
- \`worker.permission\` is per-worker. Do not copy one harness's mode onto another.

| Worker | Allowed \`permission\` |
|---|---|
| \`claude-code\` | \`legacy\` \`permissive\` \`restricted\` (+ \`restrictedTools\`) \`full-access\` |
| \`codex-cli\` | \`legacy\` \`permissive\` \`full-access\` \`sandbox-read-only\` \`sandbox-workspace-write\` |
| \`cursor\` | \`legacy\` \`permissive\` \`full-access\` \`sandbox-workspace-write\` |
| \`devin\` \`omp\` | \`legacy\` \`permissive\` \`restricted\` \`full-access\` |
| \`amp-code\` \`antigravity-cli\` \`grok\` \`hermes\` \`kimi-code\` \`opencode\` \`opencode2\` | \`legacy\` \`permissive\` \`full-access\` |

- Nothing is saved by this skill. Pins live in the workflow source; the harness default stays when you omit the field.

If typecheck rejects a family name, the error lists the effort-suffixed slugs. Fix the one-line pin; do not invent a shared model type.

Print this skill: \`prism workflow skill --models\`. Named workers instead: \`prism workflow workers\`.
`;

/** Every file of the model-discovery skill, relative to its own directory. */
export const workflowModelsSkillFiles = (): readonly EmbeddedSkillFile[] => [
  { relativePath: "SKILL.md", markdown: renderWorkflowModelsSkillMarkdown() },
];

export const workflowModelsSkill = (): EmbeddedSkill => ({
  name: WORKFLOW_MODELS_SKILL_NAME,
  files: workflowModelsSkillFiles(),
});

export const writeWorkflowModelsSkill = async (
  prismHome: string,
): Promise<{ readonly path: string; readonly bytes: number; readonly files: readonly string[] }> => {
  const skillPath = prismWorkflowModelsSkillPath(prismHome);
  const skillDir = dirname(skillPath);
  const files: string[] = [];
  let bytes = 0;
  for (const file of workflowModelsSkillFiles()) {
    const target = join(skillDir, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, "utf8");
    files.push(target);
    bytes += file.markdown.length;
  }
  return { path: skillPath, bytes, files };
};
