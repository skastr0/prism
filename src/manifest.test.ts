import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_VALIDATION } from "./types.js";
import { validateSkill } from "./manifest.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-manifest-"));
  tempRoots.push(root);
  return root;
};

const createSkillDir = async (name = "testing"): Promise<string> => {
  const root = await createTempRoot();
  const skillPath = join(root, name);
  await mkdir(skillPath, { recursive: true });
  return skillPath;
};

const writeSkill = async (skillPath: string, content: string): Promise<void> => {
  await writeFile(join(skillPath, "SKILL.md"), content);
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("validateSkill reports missing SKILL.md", async () => {
  const skillPath = await createSkillDir();

  const result = await validateSkill(skillPath, "testing");

  expect(result).toEqual({
    valid: false,
    errors: ["SKILL.md not found"],
    warnings: [],
    skillPath,
  });
});

test("validateSkill rejects files without frontmatter marker", async () => {
  const skillPath = await createSkillDir();
  await writeSkill(skillPath, "name: testing\n\n# Body\n");

  const result = await validateSkill(skillPath, "testing");

  expect(result).toEqual({
    valid: false,
    errors: ["No YAML frontmatter found (file must start with ---)"],
    warnings: [],
    skillPath,
  });
});

test("validateSkill reports invalid YAML and non-dictionary frontmatter", async () => {
  const invalidYamlPath = await createSkillDir("invalid-yaml");
  await writeSkill(invalidYamlPath, "---\nname: [unterminated\n---\n\n# Body\n");

  const invalidYaml = await validateSkill(invalidYamlPath, "invalid-yaml");

  expect(invalidYaml.valid).toBe(false);
  expect(invalidYaml.errors).toHaveLength(1);
  expect(invalidYaml.errors[0]).toStartWith("Invalid YAML in frontmatter:");
  expect(invalidYaml.warnings).toEqual([]);
  expect(invalidYaml.skillPath).toBe(invalidYamlPath);

  const nonDictionaryPath = await createSkillDir("non-dictionary");
  await writeSkill(nonDictionaryPath, "---\n- name\n---\n\n# Body\n");

  const nonDictionary = await validateSkill(nonDictionaryPath, "non-dictionary");

  expect(nonDictionary).toEqual({
    valid: false,
    errors: ["Frontmatter must be a YAML dictionary"],
    warnings: [],
    skillPath: nonDictionaryPath,
  });
});

test("validateSkill reports required frontmatter field errors", async () => {
  const skillPath = await createSkillDir();
  await writeSkill(skillPath, "---\nlicense: MIT\n---\n\n# Body\n");

  const result = await validateSkill(skillPath, "testing");

  expect(result.valid).toBe(false);
  expect(result.errors).toEqual([
    "Missing 'name' in frontmatter",
    "Missing 'description' in frontmatter",
  ]);
  expect(result.warnings).toEqual([]);
  expect(result.skillName).toBeUndefined();
  expect(result.skillPath).toBe(skillPath);
});

test("validateSkill preserves diagnostic ordering and invalid string skillName", async () => {
  const skillPath = await createSkillDir("ordered-diagnostics");
  await writeSkill(
    skillPath,
    `---
zebra: unexpected
alpha: unexpected
name: Invalid Name
description: Contains <angle>
compatibility: 42
allowed-tools: [run_shell, 7]
metadata:
  owner: team
  priority: 1
license: 12
---

# Body
`,
  );

  const result = await validateSkill(skillPath, "ordered-diagnostics");

  expect(result.valid).toBe(false);
  expect(result.errors).toEqual([
    "Unexpected key(s) in SKILL.md frontmatter: alpha, zebra. Allowed properties are: allowed-tools, compatibility, description, license, metadata, name",
    "Name 'Invalid Name' should be kebab-case (lowercase letters, digits, and hyphens only)",
    "Description cannot contain angle brackets (< or >)",
    "'compatibility' must be a string, got number",
    "'allowed-tools' must be an array of strings",
    "'license' must be a string, got number",
  ]);
  expect(result.warnings).toEqual([
    "Skill name 'Invalid Name' does not match directory name 'ordered-diagnostics'",
    "metadata.priority should be a string, got number",
  ]);
  expect(result.skillName).toBe("Invalid Name");
  expect(result.skillPath).toBe(skillPath);
});

test("validateSkill warns when skill name differs from directory", async () => {
  const skillPath = await createSkillDir("expected-name");
  await writeSkill(
    skillPath,
    "---\nname: actual-name\ndescription: Testing guidance\n---\n\n# Body\n",
  );

  const result = await validateSkill(skillPath, "expected-name");

  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([
    "Skill name 'actual-name' does not match directory name 'expected-name'",
  ]);
  expect(result.skillName).toBe("actual-name");
  expect(result.skillPath).toBe(skillPath);
});

test("validateSkill does not warn at recommended body length boundary", async () => {
  const skillPath = await createSkillDir("boundary-skill");
  const body = Array.from(
    { length: SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES },
    (_, index) => `Line ${index + 1}`,
  ).join("\n");
  await writeSkill(
    skillPath,
    `---\nname: boundary-skill\ndescription: Testing guidance\n---\n\n${body}`,
  );

  const result = await validateSkill(skillPath, "boundary-skill");

  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.skillName).toBe("boundary-skill");
  expect(result.skillPath).toBe(skillPath);
});

test("validateSkill warns when body exceeds recommended length", async () => {
  const skillPath = await createSkillDir("long-skill");
  const body = Array.from(
    { length: SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES + 1 },
    (_, index) => `Line ${index + 1}`,
  ).join("\n");
  await writeSkill(
    skillPath,
    `---\nname: long-skill\ndescription: Testing guidance\n---\n\n${body}\n`,
  );

  const result = await validateSkill(skillPath, "long-skill");

  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([
    `SKILL.md body is ${SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES + 1} lines (recommended max: ${SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES}). Consider splitting into reference files.`,
  ]);
  expect(result.skillName).toBe("long-skill");
  expect(result.skillPath).toBe(skillPath);
});
