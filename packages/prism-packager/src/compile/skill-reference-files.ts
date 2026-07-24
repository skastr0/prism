/**
 * Skill reference-file injection (PQ-176 footgun #3).
 *
 * A plugin skill directory commonly holds `SKILL.md` plus sibling reference
 * markdown the skill links to (e.g. `workflow-authoring.md`,
 * `references/spec.md`) for progressive disclosure — SKILL.md stays short and
 * links out to the full download. Several directory-native lowerers
 * (claude-code, grok, factory-droid, codex-cli, pi — see
 * `src/compile/lowerers/*`) only ever plan a single `skills/<name>/SKILL.md`
 * write, so every sibling reference file is silently dropped from compiled
 * output: an agent following a link in SKILL.md finds nothing there.
 *
 * The fix belongs where those lowerers plan their skill writes, but that
 * source is owned by a concurrent consolidation lane. This module patches
 * the *lowered plan* instead of the lowerer: for every desired
 * `skills/<name>/SKILL.md` file, it looks up sibling `.md` files next to the
 * skill's source `SKILL.md` and adds them as additional desired files at the
 * matching relative path. Lowerers that already copy a skill's full source
 * tree (antigravity-cli, amp-code, kimi-code, hermes — via
 * `collectArtifactSourceFiles`) never produce a bare `SKILL.md`-only entry
 * for a directory with siblings, so this is a no-op for them.
 */

import { dirname, join } from "node:path";
import { listDirRecursive, readFile } from "../fs.js";
import type { DesiredFile } from "../sync/desired.js";
import type { Skill } from "./sources.js";

const SKILL_MD = "SKILL.md";

/** True when `targetPath`'s final two segments are exactly `skills/<name>/SKILL.md` for `skillName`. */
const isSkillMdTarget = (targetPath: string, skillName: string): boolean => {
  const segments = targetPath.split("/");
  const last = segments.length - 1;
  return last >= 1 && segments[last] === SKILL_MD && segments[last - 1] === skillName;
};

/**
 * Given a lowerer's already-planned files, add sibling markdown reference
 * files for every skill whose `SKILL.md` the lowerer planned as a standalone
 * file (i.e. `desiredFile.targetPath` ends with `skills/<skill.name>/SKILL.md`).
 * Returns a new array; never mutates `files`.
 */
export const injectSkillReferenceFiles = async (
  files: ReadonlyArray<DesiredFile>,
  skills: ReadonlyArray<Skill>,
): Promise<DesiredFile[]> => {
  if (skills.length === 0) return [...files];

  const additions: DesiredFile[] = [];
  for (const file of files) {
    const skill = skills.find((candidate) => isSkillMdTarget(file.targetPath, candidate.name));
    if (!skill) continue;

    const skillSourceDir = dirname(skill.sourcePath);
    const siblingRelativePaths = (await listDirRecursive(skillSourceDir))
      .filter((relativePath) => relativePath.endsWith(".md") && relativePath !== SKILL_MD)
      .sort((left, right) => left.localeCompare(right));

    const targetDir = file.targetPath.slice(0, file.targetPath.length - SKILL_MD.length);
    for (const relativePath of siblingRelativePaths) {
      additions.push({
        targetPath: `${targetDir}${relativePath}`,
        content: await readFile(join(skillSourceDir, relativePath)),
        plugin: file.plugin,
      });
    }
  }

  return additions.length === 0 ? [...files] : [...files, ...additions];
};
