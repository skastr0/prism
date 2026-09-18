/**
 * Reference files for the embedded workflow-authoring skill.
 *
 * `SKILL.md` stays short and routes; the depth lives here, one file per
 * concern, so an agent loads only the chapter it needs. These are plain
 * markdown bodies (no frontmatter) written next to `SKILL.md` as
 * `references/<name>.md`.
 */

import type { EmbeddedSkillFile } from "../skill-files.js";
import { CACHE_AND_FINISH_REFERENCE_MARKDOWN } from "./cache-and-finish.js";
import { JEV_REFERENCE_MARKDOWN } from "./jev.js";
import { OBSERVABILITY_REFERENCE_MARKDOWN } from "./observability.js";
import { SCHEDULING_REFERENCE_MARKDOWN } from "./scheduling.js";
import { TOPOLOGY_REFERENCE_MARKDOWN } from "./topology.js";

export const WORKFLOW_SKILL_REFERENCES: readonly EmbeddedSkillFile[] = [
  { relativePath: "references/scheduling.md", markdown: SCHEDULING_REFERENCE_MARKDOWN },
  { relativePath: "references/jev.md", markdown: JEV_REFERENCE_MARKDOWN },
  { relativePath: "references/observability.md", markdown: OBSERVABILITY_REFERENCE_MARKDOWN },
  { relativePath: "references/cache-and-finish.md", markdown: CACHE_AND_FINISH_REFERENCE_MARKDOWN },
  { relativePath: "references/topology.md", markdown: TOPOLOGY_REFERENCE_MARKDOWN },
];
