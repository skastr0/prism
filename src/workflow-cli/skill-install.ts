/**
 * Install the embedded workflow skills into detected harness skill directories.
 *
 * `prism workflow skill` and `--write` are Prism-internal: they print the skill
 * or materialize it under PRISM_HOME, which no harness reads. This module is the
 * plugin-free delivery path — it drops the same files where a harness actually
 * discovers skills, so an agent can learn the workflow surface without a
 * compiled Prism plugin.
 *
 * The target layout comes from the harness registry (`skillsDir` under the
 * harness's `globalConfigPath`), not from a table duplicated here. Harnesses
 * that share a root (OpenCode 1.x and 2 share `~/.config/opencode/`) collapse
 * to one write.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandPath } from "../fs.js";
import { detectInstalledHarnessIds } from "../harness-install-detection.js";
import { getHarness } from "../harnesses.js";
import type { HarnessRootsEnv } from "../services/prism-env.js";
import type { HarnessId } from "../types.js";
import { workflowAuthoringSkill } from "./skill.js";
import { workflowModelsSkill } from "./models-skill.js";
import type { EmbeddedSkill } from "./skill-files.js";

/** The skills the CLI installs. Order is the write order. */
export const embeddedWorkflowSkills = (): readonly EmbeddedSkill[] => [
  workflowAuthoringSkill(),
  workflowModelsSkill(),
];

export interface WorkflowSkillInstallTarget {
  readonly harness: HarnessId;
  /** Absolute skill directory, e.g. `~/.claude/skills/prism-workflow`. */
  readonly skillDir: string;
  readonly skill: string;
  /** Absolute paths written (or that would be written, under `--dry-run`). */
  readonly files: readonly string[];
}

export interface WorkflowSkillInstallSkip {
  readonly harness: HarnessId;
  readonly reason: string;
}

export interface WorkflowSkillInstallResult {
  readonly dryRun: boolean;
  readonly targets: readonly WorkflowSkillInstallTarget[];
  readonly skipped: readonly WorkflowSkillInstallSkip[];
}

export interface InstallWorkflowSkillsOptions {
  /** Defaults to every harness Prism detects as installed. */
  readonly harnesses?: readonly HarnessId[];
  /** Test seam: redirect harness roots instead of expanding the real home. */
  readonly roots?: HarnessRootsEnv;
  readonly dryRun?: boolean;
}

/**
 * Write every embedded workflow skill into each harness's skill directory.
 *
 * A harness with no skill surface (`supportsSkills` false, or no `skillsDir`)
 * is reported in `skipped` rather than silently dropped — a user asking
 * `--install` deserves to know which harnesses were left alone and why.
 */
export const installWorkflowSkills = async (
  options: InstallWorkflowSkillsOptions = {},
): Promise<WorkflowSkillInstallResult> => {
  const dryRun = options.dryRun === true;
  const harnesses = options.harnesses ?? detectInstalledHarnessIds();
  const skills = embeddedWorkflowSkills();

  const targets: WorkflowSkillInstallTarget[] = [];
  const skipped: WorkflowSkillInstallSkip[] = [];
  const writtenSkillDirs = new Set<string>();

  for (const harnessId of harnesses) {
    const harness = getHarness(harnessId);
    if (!harness.supportsSkills || harness.skillsDir === null) {
      skipped.push({ harness: harnessId, reason: "no skill surface" });
      continue;
    }

    // Every harness declares `skills` in its catalog `scanDirs`, so a skill
    // directory under the harness root is the standard discovery surface — a
    // skill is markdown in a folder, nothing else. Prism's lowerers bundle
    // *plugin* skills for some harnesses because that is where the plugin's
    // own registration lives; it is not a statement about what the harness can
    // read.
    const root = options.roots !== undefined
      ? options.roots.resolve(harnessId)
      : expandPath(harness.globalConfigPath);
    if (!existsSync(root)) {
      // Only reachable for an explicit `--harness` naming a harness that is
      // not installed. Report it rather than creating a harness home.
      skipped.push({ harness: harnessId, reason: `${root} does not exist` });
      continue;
    }

    for (const skill of skills) {
      const skillDir = join(root, harness.skillsDir, skill.name);
      if (writtenSkillDirs.has(skillDir)) {
        skipped.push({ harness: harnessId, reason: `shares ${skillDir} with another harness` });
        continue;
      }
      writtenSkillDirs.add(skillDir);

      const files: string[] = [];
      for (const file of skill.files) {
        const target = join(skillDir, file.relativePath);
        files.push(target);
        if (dryRun) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.markdown, "utf8");
      }
      targets.push({ harness: harnessId, skillDir, skill: skill.name, files });
    }
  }

  return { dryRun, targets, skipped };
};

export const renderWorkflowSkillInstallHuman = (result: WorkflowSkillInstallResult): string => {
  const lines: string[] = [];
  if (result.targets.length === 0) {
    lines.push(
      result.dryRun
        ? "No harness skill directories to install into."
        : "No harness skill directories were written.",
    );
  } else {
    lines.push(
      result.dryRun
        ? "Would install the embedded workflow skills:"
        : "Installed the embedded workflow skills:",
    );
    for (const target of result.targets) {
      lines.push(`  ${target.harness} → ${target.skillDir} (${target.skill}, ${target.files.length} file${target.files.length === 1 ? "" : "s"})`);
    }
  }
  for (const skip of result.skipped) {
    lines.push(`  skipped ${skip.harness}: ${skip.reason}`);
  }
  if (!result.dryRun && result.targets.length > 0) {
    lines.push("");
    lines.push("Agents now discover these skills from the harness. No plugin required.");
  }
  return lines.join("\n");
};
