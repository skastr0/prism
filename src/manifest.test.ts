import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("readManifest rejects unsupported direct source noun targets", async () => {
  const agentPluginRoot = await createPluginWithManifest("unsupported-hermes-agent", {
    agents: ["hermes"],
  });
  const hookPluginRoot = await createPluginWithManifest("unsupported-hermes-hook", {
    hooks: ["hermes"],
  });

  await expectManifestValidationDetails(agentPluginRoot, [
    "targets.agents resolves to unsupported compile harnesses: hermes (Hermes Agent). Source agents must be authored as agents/*.agent.ts and can only target compile-supported harnesses.",
  ]);
  await expectManifestValidationDetails(hookPluginRoot, [
    "targets.hooks resolves to unsupported harnesses for hooks: hermes (Hermes Agent)",
  ]);
});

test("readManifest rejects presets that resolve to no supported source noun targets", async () => {
  const agentPluginRoot = await createPluginWithManifest("empty-preset-agent", {
    agents: ["claw-harness"],
  });
  const hookPluginRoot = await createPluginWithManifest("empty-preset-hook", {
    hooks: ["claw-harness"],
  });

  await expectManifestValidationDetails(agentPluginRoot, [
    "targets.agents preset 'claw-harness' resolves to no supported harnesses for agents",
  ]);
  await expectManifestValidationDetails(hookPluginRoot, [
    "targets.hooks preset 'claw-harness' resolves to no supported harnesses for hooks",
  ]);
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

test("readManifest rejects rule, command, and skill support symlinks outside the plugin root", async () => {
  const root = await createTempRoot();
  const externalRoot = join(root, "external");
  await writeText(join(externalRoot, "rules.md"), "# External rules\n");
  await writeText(join(externalRoot, "command.md"), "# External command\n");
  await writeText(join(externalRoot, "reference.md"), "# External reference\n");

  const pluginRoot = await createPluginWithManifest("escaped-artifact-symlinks", {
    rules: ["opencode"],
    commands: ["opencode"],
    skills: ["opencode"],
  });
  await writeText(
    join(pluginRoot, "skills", "testing", "SKILL.md"),
    "---\nname: testing\ndescription: Testing guidance\n---\n\n# Testing\n",
  );
  await mkdir(join(pluginRoot, "rules", "global"), { recursive: true });
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "testing", "references"), { recursive: true });
  await symlink(
    join(externalRoot, "rules.md"),
    join(pluginRoot, "rules", "global", "standards.md"),
  );
  await symlink(
    join(externalRoot, "command.md"),
    join(pluginRoot, "commands", "review.md"),
  );
  await symlink(
    join(externalRoot, "reference.md"),
    join(pluginRoot, "skills", "testing", "references", "external.md"),
  );

  await expectManifestValidationDetails(pluginRoot, [
    "Symlinked artifact file rules/global/standards.md resolves outside plugin root",
    "Symlinked artifact file commands/review.md resolves outside plugin root",
    "Symlinked artifact file skills/testing/references/external.md resolves outside plugin root",
  ]);
});

test("readManifest rejects harness overlay symlinks outside the plugin root", async () => {
  const root = await createTempRoot();
  const externalRoot = join(root, "external");
  await writeText(join(externalRoot, "command.md"), "# External command\n");

  const pluginRoot = await createPluginWithManifest("escaped-overlay-symlink", {
    commands: ["opencode"],
  });
  await mkdir(join(pluginRoot, "harness", "opencode", "commands"), { recursive: true });
  await symlink(
    join(externalRoot, "command.md"),
    join(pluginRoot, "harness", "opencode", "commands", "review.md"),
  );

  await expectManifestValidationDetails(pluginRoot, [
    "Symlinked artifact file harness/opencode/commands/review.md resolves outside plugin root",
  ]);
});

test("readManifest rejects artifact directory symlinks outside the plugin root", async () => {
  const root = await createTempRoot();
  const externalCommands = join(root, "external", "commands");
  await writeText(join(externalCommands, "review.md"), "# External command\n");

  const pluginRoot = await createPluginWithManifest("escaped-artifact-directory", {
    commands: ["opencode"],
  });
  await symlink(externalCommands, join(pluginRoot, "commands"));

  await expectManifestValidationDetails(pluginRoot, [
    "Symlinked artifact root commands resolves outside plugin root",
  ]);
});

test("readManifest rejects harness roots and overlay artifact roots symlinked outside the plugin root", async () => {
  const root = await createTempRoot();
  const externalHarnessRoot = join(root, "external-harness");
  const externalCommands = join(root, "external-commands");
  await writeText(join(externalHarnessRoot, "opencode", "commands", "review.md"), "# External command\n");
  await writeText(join(externalCommands, "review.md"), "# External command\n");

  const harnessRootPlugin = await createPluginWithManifest("escaped-harness-root", {
    commands: ["opencode"],
  });
  await symlink(externalHarnessRoot, join(harnessRootPlugin, "harness"));
  await expectManifestValidationDetails(harnessRootPlugin, [
    "Symlinked harness root harness resolves outside plugin root",
  ]);

  const overlayRootPlugin = await createPluginWithManifest("escaped-overlay-root", {
    commands: ["opencode"],
  });
  await mkdir(join(overlayRootPlugin, "harness", "opencode"), { recursive: true });
  await symlink(externalCommands, join(overlayRootPlugin, "harness", "opencode", "commands"));
  await expectManifestValidationDetails(overlayRootPlugin, [
    "Symlinked artifact root harness/opencode/commands resolves outside plugin root",
  ]);
});
