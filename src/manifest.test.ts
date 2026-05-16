import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_VALIDATION } from "./types.js";
import { PluginManifestError, readManifest, validateSkill } from "./manifest.js";

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

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const createPluginWithManifest = async (
  name: string,
  targets: Record<string, string[]>,
): Promise<string> => {
  const root = await createTempRoot();
  const pluginRoot = join(root, name);
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name, version: "0.1.0", targets }, null, 2)}\n`,
  );
  return pluginRoot;
};

const expectManifestValidationDetails = async (
  pluginRoot: string,
  expectedDetails: string[],
): Promise<void> => {
  try {
    await readManifest(pluginRoot);
    throw new Error("expected manifest validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    if (!(error instanceof PluginManifestError)) throw error;
    for (const detail of expectedDetails) {
      expect(error.details).toContain(detail);
    }
  }
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

test("readManifest rejects file-level targets in shared install artifacts", async () => {
  const pluginRoot = await createPluginWithManifest("shared-file-targets", {
    rules: ["opencode"],
    commands: ["opencode"],
    agents: ["opencode"],
    skills: ["opencode"],
  });
  await writeText(
    join(pluginRoot, "rules", "global", "standards.md"),
    "---\ntargets: [opencode]\n---\n\n# Standards\n",
  );
  await writeText(
    join(pluginRoot, "commands", "review.md"),
    "---\ntargets: [opencode]\n---\n\n# Review\n",
  );
  await writeText(
    join(pluginRoot, "agents", "reviewer.md"),
    "---\ntargets: [opencode]\n---\n\n# Reviewer\n",
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\ntargets: [opencode]\n---\n\n# Testing\n",
  );

  try {
    await readManifest(pluginRoot);
    throw new Error("expected manifest validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    if (!(error instanceof PluginManifestError)) throw error;
    expect(error.details).toEqual([
      "File-level install targets are not supported in rules/global/standards.md. Move install scope to plugin.json targets.rules",
      "File-level install targets are not supported in commands/review.md. Move install scope to plugin.json targets.commands",
      "File-level install targets are not supported in agents/reviewer.md. Move install scope to plugin.json targets.agents",
      "File-level install targets are not supported in skills/testing/SKILL.md. Move install scope to plugin.json targets.skills",
      "Source markdown agents are not supported at agents/reviewer.md. Author agents as agents/*.agent.ts and let harness lowerers generate markdown output.",
    ]);
  }
});

test("readManifest rejects file-level targets in harness overlay entrypoints", async () => {
  const pluginRoot = await createPluginWithManifest("overlay-file-targets", {
    commands: ["opencode"],
    skills: ["opencode"],
  });
  await writeText(
    join(pluginRoot, "harness", "opencode", "commands", "review.md"),
    "---\ntargets: [opencode]\n---\n\n# Review\n",
  );
  await writeText(
    join(pluginRoot, "harness", "opencode", "skills", "debugging", "SKILL.md"),
    "---\nname: debugging\ndescription: Debugging guidance\ntargets: [opencode]\n---\n\n# Debugging\n",
  );

  await expectManifestValidationDetails(pluginRoot, [
    "File-level install targets are not supported in harness/opencode/commands/review.md. Move install scope to plugin.json targets.commands",
    "File-level install targets are not supported in harness/opencode/skills/debugging/SKILL.md. Move install scope to plugin.json targets.skills",
  ]);
});

test("readManifest ignores skill support markdown file-level targets", async () => {
  const pluginRoot = await createPluginWithManifest("support-file-targets", {
    skills: ["opencode"],
  });
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );
  await writeText(
    join(pluginRoot, "skills", "testing", "notes.md"),
    "---\ntargets: [opencode]\n---\n\nIgnored support file.\n",
  );
  await writeText(
    join(pluginRoot, "harness", "opencode", "skills", "testing", "notes.md"),
    "---\ntargets: [opencode]\n---\n\nIgnored overlay support file.\n",
  );

  const manifest = await readManifest(pluginRoot);

  expect(manifest.name).toBe("support-file-targets");
});

test("readManifest reports invalid YAML while checking file-level targets", async () => {
  const pluginRoot = await createPluginWithManifest("invalid-file-target-yaml", {
    commands: ["opencode"],
  });
  await writeText(
    join(pluginRoot, "commands", "review.md"),
    "---\ntargets: [unterminated\n---\n\n# Review\n",
  );

  await expect(readManifest(pluginRoot)).rejects.toThrow("unexpected end of the stream");
});
