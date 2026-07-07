import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { injectSkillReferenceFiles } from "./skill-reference-files.js";
import { Skill } from "./sources.js";
import type { DesiredFile } from "../sync/desired.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-skill-refs-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("adds sibling reference markdown next to a bare SKILL.md desired file", async () => {
  const root = await createTempRoot();
  const skillDir = join(root, "source", "skills", "workflows");
  await writeText(join(skillDir, "SKILL.md"), "# Workflows\n\nSee [ref](workflow-authoring.md).\n");
  await writeText(join(skillDir, "workflow-authoring.md"), "# Workflow authoring\n\nFull download.\n");
  await writeText(join(skillDir, "references", "extra.md"), "# Extra\n\nNested reference.\n");

  const skill = new Skill({ name: "workflows", sourcePath: join(skillDir, "SKILL.md") });
  const files: DesiredFile[] = [
    {
      targetPath: join(root, "out", "skills", "workflows", "SKILL.md"),
      content: "# Workflows\n",
      plugin: "demo",
    },
  ];

  const result = await injectSkillReferenceFiles(files, [skill]);

  expect(result).toHaveLength(3);
  const authoring = result.find((file) =>
    file.targetPath.endsWith(join("skills", "workflows", "workflow-authoring.md")),
  );
  expect(authoring?.content).toContain("Full download.");
  const nested = result.find((file) =>
    file.targetPath.endsWith(join("skills", "workflows", "references", "extra.md")),
  );
  expect(nested?.content).toContain("Nested reference.");
});

test("is a no-op when the skill directory has no sibling markdown", async () => {
  const root = await createTempRoot();
  const skillDir = join(root, "source", "skills", "solo");
  await writeText(join(skillDir, "SKILL.md"), "# Solo\n");

  const skill = new Skill({ name: "solo", sourcePath: join(skillDir, "SKILL.md") });
  const files: DesiredFile[] = [
    { targetPath: join(root, "out", "skills", "solo", "SKILL.md"), content: "# Solo\n", plugin: "demo" },
  ];

  const result = await injectSkillReferenceFiles(files, [skill]);
  expect(result).toEqual(files);
});

test("does not match a skill name that is only a suffix of the target's directory segment", async () => {
  const root = await createTempRoot();
  const webappDir = join(root, "source", "skills", "webapp");
  await writeText(join(webappDir, "SKILL.md"), "# Webapp\n");
  await writeText(join(webappDir, "notes.md"), "# Notes\n");

  // A distinct skill named "app" must never pick up "webapp"'s sibling files.
  const appSkill = new Skill({ name: "app", sourcePath: join(root, "source", "skills", "app", "SKILL.md") });
  const files: DesiredFile[] = [
    { targetPath: join(root, "out", "skills", "webapp", "SKILL.md"), content: "# Webapp\n", plugin: "demo" },
  ];

  const result = await injectSkillReferenceFiles(files, [appSkill]);
  expect(result).toEqual(files);
});

test("leaves files untouched when no skills are passed", async () => {
  const files: DesiredFile[] = [
    { targetPath: "/out/skills/solo/SKILL.md", content: "# Solo\n", plugin: "demo" },
  ];
  const result = await injectSkillReferenceFiles(files, []);
  expect(result).toEqual(files);
  expect(result).not.toBe(files);
});
