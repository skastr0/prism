import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  AMP_ORB_SKILL_LIMITS,
  AmpOrbSkillError,
  assertAmpOrbSkillPlan,
  listForeignAmpOrbSkills,
} from "./amp-orb-skills.js";

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "amp-orb-skills-"));

const writeSkill = async (
  root: string,
  name: string,
  body = "Use this skill.\n",
): Promise<string> => {
  const path = join(root, name, "SKILL.md");
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    path,
    `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n\n${body}`,
  );
  return path;
};

test("amp-orb accepts UTF-8 skill text and rejects a NUL byte", async () => {
  const root = await tempRoot();
  await mkdir(join(root, ".git"), { recursive: true });
  const source = join(root, "release-notes", "SKILL.md");
  await mkdir(join(root, "release-notes"), { recursive: true });
  await writeFile(
    source,
    "---\nname: release-notes\ndescription: Notes — with an em dash\n---\n# Notes\n\nUse → this.\n",
  );
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [{ relativePath: "release-notes/SKILL.md", sourcePath: source }],
    }),
  ).resolves.toBeUndefined();

  await writeFile(source, "---\nname: release-notes\ndescription: bad\n---\nbinary\u0000");
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [{ relativePath: "release-notes/SKILL.md", sourcePath: source }],
    }),
  ).rejects.toThrow(/not text/);
});

test("amp-orb refuses a root that is not a git checkout", async () => {
  const root = await tempRoot();
  const { assertAmpOrbCheckout } = await import("./amp-orb-skills.js");
  await expect(assertAmpOrbCheckout(root)).rejects.toThrow(/not a skills checkout/);
  await mkdir(join(root, ".git"), { recursive: true });
  await expect(assertAmpOrbCheckout(root)).resolves.toBeUndefined();
});

test("amp-orb counts retained checkout bytes against the repo cap", async () => {
  const root = await tempRoot();
  await mkdir(join(root, ".git"), { recursive: true });
  const foreign = await writeSkill(root, "foreign-skill", "x".repeat(1024));
  const planned = await writeSkill(root, "release-notes");
  await expect(
    assertAmpOrbSkillPlan({
      root,
      existingRepoBytes: 26 * 1024 * 1024,
      files: [{ relativePath: "release-notes/SKILL.md", sourcePath: planned }],
    }),
  ).rejects.toThrow(/skills repository/);
  expect(foreign).toContain("foreign-skill");
});

test("amp-orb accepts a flat text skill whose directory matches frontmatter name", async () => {
  const root = await tempRoot();
  const source = await writeSkill(root, "release-notes");
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [{ relativePath: "release-notes/SKILL.md", sourcePath: source }],
    }),
  ).resolves.toBeUndefined();
});

test("amp-orb rejects a skill directory that does not match frontmatter name", async () => {
  const root = await tempRoot();
  const source = await writeSkill(root, "release-notes");
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [{ relativePath: "other-name/SKILL.md", sourcePath: source }],
    }),
  ).rejects.toBeInstanceOf(AmpOrbSkillError);
});

test("amp-orb rejects a non-text SKILL.md and any file that is not SKILL.md", async () => {
  const root = await tempRoot();
  const binary = join(root, "release-notes", "SKILL.md");
  await mkdir(join(root, "release-notes"), { recursive: true });
  await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [{ relativePath: "release-notes/SKILL.md", sourcePath: binary }],
    }),
  ).rejects.toThrow(/not text/);

  const skillMd = await writeSkill(root, "release-notes");
  const extra = join(root, "release-notes", "references", "checklist.md");
  await mkdir(join(root, "release-notes", "references"), { recursive: true });
  await writeFile(extra, "Check this.\n");
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [
        { relativePath: "release-notes/SKILL.md", sourcePath: skillMd },
        { relativePath: "release-notes/references/checklist.md", sourcePath: extra },
      ],
    }),
  ).resolves.toBeUndefined();
});

test("amp-orb rejects a nested skill directory", async () => {
  const root = await tempRoot();
  const source = await writeSkill(root, "release-notes");
  await expect(
    assertAmpOrbSkillPlan({
      root,
      files: [{ relativePath: "team/release-notes/SKILL.md", sourcePath: source }],
    }),
  ).rejects.toThrow(/flat top-level/);
});

test("amp-orb rejects a plan past the hosted skill count", async () => {
  const root = await tempRoot();
  const files = [];
  for (let index = 0; index < AMP_ORB_SKILL_LIMITS.maxSkills + 1; index += 1) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    files.push({
      relativePath: `${name}/SKILL.md`,
      sourcePath: await writeSkill(root, name),
    });
  }
  await expect(assertAmpOrbSkillPlan({ root, files })).rejects.toThrow(/200/);
});

test("amp-orb counts foreign checkout skills against the hosted cap", async () => {
  const root = await tempRoot();
  await writeSkill(root, "foreign-skill");
  const foreign = await listForeignAmpOrbSkills(root, new Set(["owned-skill"]));
  expect(foreign).toEqual(["foreign-skill"]);
  const ignored = await listForeignAmpOrbSkills(root, new Set(["foreign-skill"]));
  expect(ignored).toEqual([]);
});
