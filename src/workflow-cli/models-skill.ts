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
- Fixed effort controls: Claude Code \`low|medium|high|xhigh|max\`; Antigravity CLI \`low|medium|high\`; Hermes \`none|minimal|low|medium|high|xhigh|max|ultra\`; Kimi Code \`low|medium|high|xhigh|max\`; OMP \`off|minimal|low|medium|high|xhigh|max|auto\`. These literal values come from Prism's capability registry and are checked by the workflow DSL.
- Kimi Code sets effort through the undocumented \`KIMI_MODEL_THINKING_EFFORT\` environment variable on the spawned worker process. When the selected model's row in \`<KIMI_CODE_HOME>/config.toml\` declares \`support_efforts\`, validation also checks that model-specific subset.
- Amp, Codex CLI, and Grok: \`worker.effort\` uses discovered per-model values. Refresh with \`prism workflow refresh-harness-types\`; validation checks the selected model's row as well as the discovered union.
- Amp: \`worker.model\` is a \`--mode\` dial (\`low|medium|high|ultra\`) or plugin key. Catalog slugs go in \`worker.catalogModel\`. Reasoning goes in \`worker.effort\`. A dial in \`worker.model\` does not combine with \`catalogModel\` / \`effort\`.
- Codex and OMP modelspace targets use \`effort\`, not \`variant\`; direct task effort overrides the modelspace value. Devin and Cursor encode effort in model slugs, so they have no \`worker.effort\` field. OpenCode's \`variant\` selects a model variant.
- OMP pins are \`provider/id\` selectors from \`omp models --json\`. Bare ids are not selectors. \`opencode-go/*\` is Console Go and 400s in workflow \`--print\`.
- \`amp-orb\` \`worker.project\` is required and typed against the projects \`prism workflow refresh-harness-types\` discovered from \`amp projects list --json\` (namespace/name, owner/repo, or repository URL); validation lists the known ones. \`amp-runner\` \`worker.runnerId\` is the operator-declared runner id (\`amp runner list\` on that machine). Prefer a named worker that pins either target once.
- \`worker.permission\` is per-worker. Do not copy one harness's mode onto another.

| Worker | Allowed \`permission\` |
|---|---|
| \`claude-code\` | \`legacy\` \`permissive\` \`restricted\` (+ \`restrictedTools\`) \`full-access\` |
| \`codex-cli\` | \`legacy\` \`permissive\` \`full-access\` \`sandbox-read-only\` \`sandbox-workspace-write\` |
| \`cursor\` | \`legacy\` \`permissive\` \`full-access\` \`sandbox-workspace-write\` |
| \`devin\` \`omp\` | \`legacy\` \`permissive\` \`restricted\` \`full-access\` |
| \`amp-code\` \`antigravity-cli\` \`grok\` \`hermes\` \`kimi-code\` \`opencode\` | \`legacy\` \`permissive\` \`full-access\` |
| \`amp-orb\` \`amp-runner\` | \`legacy\` only — no per-invocation override reaches the remote executor |

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
