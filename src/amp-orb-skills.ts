/**
 * Hosted Amp skill checkout contract.
 *
 * Limits are from https://ampcode.com/docs/customize/skills (read 2026-09-22).
 * They apply to each personal or workspace skills repository, not to local
 * Amp skill directories. A git push past 200 skills silently keeps the first
 * 200 directories in alphabetical order, so Prism rejects that plan instead
 * of writing a set Amp will not fully load.
 */

import { basename, join, relative, resolve, sep } from "node:path";
import { exists, listDirRecursive } from "./fs.js";

export const AMP_ORB_SKILL_LIMITS = {
  maxSkills: 200,
  maxFilesPerSkill: 200,
  maxFileBytes: 10 * 1024 * 1024,
  maxSkillBytes: 25 * 1024 * 1024,
  maxRepoBytes: 25 * 1024 * 1024,
} as const;

export class AmpOrbSkillError extends Error {
  override readonly name = "AmpOrbSkillError";

  constructor(message: string) {
    super(message);
  }
}

export interface AmpOrbSkillFile {
  readonly relativePath: string;
  readonly sourcePath: string;
}

const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

const segmentsIncludeNestedSkill = (files: ReadonlyArray<AmpOrbSkillFile>): boolean =>
  files.some((file) => file.relativePath.split("/").length > 2);

const skillDirectoryName = (relativePath: string): string | undefined => {
  const [skillDir, nested] = relativePath.split("/");
  if (!skillDir || !nested || skillDir === "." || skillDir === "..") return undefined;
  return skillDir;
};

const assertText = async (relativePath: string, sourcePath: string): Promise<string> => {
  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(sourcePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AmpOrbSkillError(
      `amp-orb skill file '${relativePath}' is not valid UTF-8 text. Hosted Amp skill files must be text.`,
    );
  }
  if (DISALLOWED_CONTROL.test(content) || content.includes("\u007F") || content.includes("\uFFFD")) {
    throw new AmpOrbSkillError(
      `amp-orb skill file '${relativePath}' is not text. Hosted Amp skill files must be text.`,
    );
  }
  return content;
};

const assertWithin = (root: string, targetPath: string): void => {
  const rel = relative(resolve(root), resolve(targetPath));
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new AmpOrbSkillError(
      `amp-orb refuses to write outside the skills checkout: ${targetPath}`,
    );
  }
};

/**
 * Fail closed before any hosted skill write. `root` is the checkout root,
 * which is also the skills root: skill directories sit at the top level.
 */
export const assertAmpOrbCheckout = async (root: string): Promise<void> => {
  if (!(await exists(root)) || !(await exists(join(root, ".git")))) {
    throw new AmpOrbSkillError(
      `amp-orb --root '${root}' is not a skills checkout. Clone with \`amp clone user-skills\` or \`amp clone workspace-skills\`, then pass that directory. Prism does not create or publish it.`,
    );
  }
};

export const assertAmpOrbSkillPlan = async (options: {
  readonly root: string;
  readonly files: ReadonlyArray<AmpOrbSkillFile>;
  readonly existingRepoBytes?: number;
}): Promise<void> => {
  const bySkill = new Map<string, AmpOrbSkillFile[]>();
  let repoBytes = options.existingRepoBytes ?? 0;

  for (const file of options.files) {
    assertWithin(options.root, join(options.root, file.relativePath));
    const segments = file.relativePath.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 2 || segments.some((segment) => segment === "." || segment === "..")) {
      throw new AmpOrbSkillError(
        `amp-orb skill path '${file.relativePath}' must be a flat top-level <skill>/... path, not a nested skill directory.`,
      );
    }
    if (segments.length > 2 && segments[1] === "SKILL.md") {
      throw new AmpOrbSkillError(
        `amp-orb skill path '${file.relativePath}' nests under SKILL.md. Put SKILL.md directly inside '${segments[0]}'.`,
      );
    }
    const skillDir = segments[0]!;
    const group = bySkill.get(skillDir) ?? [];
    group.push(file);
    bySkill.set(skillDir, group);
  }

  if (bySkill.size > AMP_ORB_SKILL_LIMITS.maxSkills) {
    throw new AmpOrbSkillError(
      `amp-orb plan has ${bySkill.size} skills. Hosted Amp loads at most ${AMP_ORB_SKILL_LIMITS.maxSkills} per repository, and a push past that silently drops the rest.`,
    );
  }

  for (const [skillDir, files] of [...bySkill.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (files.length > AMP_ORB_SKILL_LIMITS.maxFilesPerSkill) {
      throw new AmpOrbSkillError(
        `amp-orb skill '${skillDir}' has ${files.length} files. Hosted Amp allows ${AMP_ORB_SKILL_LIMITS.maxFilesPerSkill} per skill, including SKILL.md.`,
      );
    }
    const skillMd = files.find((file) => file.relativePath === `${skillDir}/SKILL.md`);
    if (!skillMd) {
      throw new AmpOrbSkillError(
        segmentsIncludeNestedSkill(files)
          ? `amp-orb skill path is a nested skill directory, not a flat top-level skill. Hosted skills put SKILL.md directly inside the top-level directory.`
          : `amp-orb skill '${skillDir}' is missing ${skillDir}/SKILL.md. Hosted skills require SKILL.md directly inside the skill directory.`,
      );
    }

    let skillBytes = 0;
    let skillMdText = "";
    for (const file of files) {
      const content = await assertText(file.relativePath, file.sourcePath);
      if (file.relativePath === `${skillDir}/SKILL.md`) skillMdText = content;
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > AMP_ORB_SKILL_LIMITS.maxFileBytes) {
        throw new AmpOrbSkillError(
          `amp-orb skill file '${file.relativePath}' is ${bytes} bytes. Hosted Amp allows ${AMP_ORB_SKILL_LIMITS.maxFileBytes} bytes per file.`,
        );
      }
      skillBytes += bytes;
    }
    if (skillBytes > AMP_ORB_SKILL_LIMITS.maxSkillBytes) {
      throw new AmpOrbSkillError(
        `amp-orb skill '${skillDir}' is ${skillBytes} bytes. Hosted Amp allows ${AMP_ORB_SKILL_LIMITS.maxSkillBytes} bytes per skill.`,
      );
    }
    repoBytes += skillBytes;

    const frontmatterName = readSkillFrontmatterName(skillMdText);
    if (frontmatterName !== skillDir) {
      throw new AmpOrbSkillError(
        `amp-orb skill directory '${skillDir}' must match SKILL.md name '${frontmatterName ?? "(missing)"}'.`,
      );
    }
  }

  if (repoBytes > AMP_ORB_SKILL_LIMITS.maxRepoBytes) {
    throw new AmpOrbSkillError(
      `amp-orb plan is ${repoBytes} bytes. Hosted Amp allows ${AMP_ORB_SKILL_LIMITS.maxRepoBytes} bytes per skills repository.`,
    );
  }
};

const readSkillFrontmatterName = (raw: string): string | undefined => {
  if (!raw.startsWith("---")) return undefined;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const block = raw.slice(3, end);
  for (const line of block.split("\n")) {
    const match = /^name:\s*(.+?)\s*$/u.exec(line);
    if (!match?.[1]) continue;
    return match[1].replace(/^["']|["']$/gu, "");
  }
  return undefined;
};

/**
 * Bytes already in the checkout that this plan will not replace, excluding .git.
 * `replacedRelativePaths` are checkout-relative paths the plan overwrites.
 */
export const ampOrbRetainedBytes = async (
  root: string,
  replacedRelativePaths: ReadonlySet<string>,
): Promise<number> => {
  const fs = await import("node:fs/promises");
  let entries: ReadonlyArray<string> = [];
  try {
    entries = await listDirRecursive(root);
  } catch {
    return 0;
  }
  let total = 0;
  for (const relativePath of entries) {
    if (relativePath === ".git" || relativePath.startsWith(".git/")) continue;
    if (replacedRelativePaths.has(relativePath)) continue;
    const stat = await fs.stat(join(root, relativePath));
    if (stat.isFile()) total += stat.size;
  }
  return total;
};

/** Existing checkout skills Prism does not own. Counted against the 200 cap. */
export const listForeignAmpOrbSkills = async (
  root: string,
  ownedSkillDirs: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> => {
  let entries: ReadonlyArray<string> = [];
  try {
    entries = await listDirRecursive(root);
  } catch {
    return [];
  }
  const foreign = new Set<string>();
  for (const relativePath of entries) {
    if (relativePath === ".git" || relativePath.startsWith(".git/")) continue;
    const skillDir = skillDirectoryName(relativePath);
    if (!skillDir || ownedSkillDirs.has(skillDir)) continue;
    if (basename(relativePath) === "SKILL.md" && relativePath === `${skillDir}/SKILL.md`) {
      foreign.add(skillDir);
    }
  }
  return [...foreign].sort((left, right) => left.localeCompare(right));
};
