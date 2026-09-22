import { afterAll, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllHarnessIds, getHarness } from "../harnesses.js";
import type { HarnessRootsEnv } from "../services/prism-env.js";
import { renderWorkflowModelsSkillMarkdown, WORKFLOW_MODELS_SKILL_NAME } from "./models-skill.js";
import { WORKFLOW_SKILL_REFERENCES } from "./skill-references/index.js";
import { installWorkflowSkills } from "./skill-install.js";
import { renderWorkflowAuthoringSkillMarkdown, WORKFLOW_AUTHORING_SKILL_NAME } from "./skill.js";

const tempRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-skill-install-"));
  tempRoots.push(root);
  return root;
};

const rootsAt = (root: string): HarnessRootsEnv => ({ resolve: () => root });

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("installs both embedded skills, with the reference chapters, into a harness skill dir", async () => {
  const root = await makeRoot();
  const result = await installWorkflowSkills({ harnesses: ["claude-code"], roots: rootsAt(root) });

  expect(result.dryRun).toBe(false);
  expect(result.skipped).toEqual([]);
  expect(result.targets.map((target) => target.skill)).toEqual([
    WORKFLOW_AUTHORING_SKILL_NAME,
    WORKFLOW_MODELS_SKILL_NAME,
  ]);

  const authoringDir = join(root, "skills", WORKFLOW_AUTHORING_SKILL_NAME);
  expect(await readFile(join(authoringDir, "SKILL.md"), "utf8")).toBe(
    renderWorkflowAuthoringSkillMarkdown(),
  );
  for (const reference of WORKFLOW_SKILL_REFERENCES) {
    expect(await readFile(join(authoringDir, reference.relativePath), "utf8")).toBe(
      reference.markdown,
    );
  }

  const modelsDir = join(root, "skills", WORKFLOW_MODELS_SKILL_NAME);
  expect(await readFile(join(modelsDir, "SKILL.md"), "utf8")).toBe(
    renderWorkflowModelsSkillMarkdown(),
  );
});

test("reports every path it writes", async () => {
  const root = await makeRoot();
  const result = await installWorkflowSkills({ harnesses: ["claude-code"], roots: rootsAt(root) });

  const authoring = result.targets[0]!;
  expect(authoring.files).toEqual([
    join(authoring.skillDir, "SKILL.md"),
    ...WORKFLOW_SKILL_REFERENCES.map((reference) => join(authoring.skillDir, reference.relativePath)),
  ]);
  for (const file of result.targets.flatMap((target) => target.files)) {
    expect(await pathExists(file)).toBe(true);
  }
});

test("--dry-run reports the plan and writes nothing", async () => {
  const root = await makeRoot();
  const result = await installWorkflowSkills({
    harnesses: ["claude-code"],
    roots: rootsAt(root),
    dryRun: true,
  });

  expect(result.dryRun).toBe(true);
  expect(result.targets.length).toBeGreaterThan(0);
  for (const file of result.targets.flatMap((target) => target.files)) {
    expect(await pathExists(file)).toBe(false);
  }
});

test("harnesses sharing a root collapse to one write instead of racing the same paths", async () => {
  // OpenCode 1.x and 2 share ~/.config/opencode/ until they consolidate.
  const root = await makeRoot();
  const result = await installWorkflowSkills({
    harnesses: ["opencode", "opencode2"],
    roots: rootsAt(root),
  });

  const skillDirs = result.targets.map((target) => target.skillDir);
  expect(new Set(skillDirs).size).toBe(skillDirs.length);
  expect(result.targets.every((target) => target.harness === "opencode")).toBe(true);
  expect(result.skipped).toEqual([
    { harness: "opencode2", reason: `shares ${join(root, "skills", WORKFLOW_AUTHORING_SKILL_NAME)} with another harness` },
    { harness: "opencode2", reason: `shares ${join(root, "skills", WORKFLOW_MODELS_SKILL_NAME)} with another harness` },
  ]);
});

test("installs into every requested harness at its own root", async () => {
  const claudeRoot = await makeRoot();
  const codexRoot = await makeRoot();
  const roots: HarnessRootsEnv = {
    resolve: (harnessId) => (harnessId === "codex-cli" ? codexRoot : claudeRoot),
  };

  const result = await installWorkflowSkills({
    harnesses: ["claude-code", "codex-cli"],
    roots,
  });

  expect(result.targets.map((target) => target.harness)).toEqual([
    "claude-code",
    "claude-code",
    "codex-cli",
    "codex-cli",
  ]);
  expect(await pathExists(join(claudeRoot, "skills", WORKFLOW_AUTHORING_SKILL_NAME, "SKILL.md"))).toBe(true);
  expect(await pathExists(join(codexRoot, "skills", WORKFLOW_AUTHORING_SKILL_NAME, "SKILL.md"))).toBe(true);
});

test("installs into every harness that has a skill surface", async () => {
  // Harnesses with a skillsDir use `<root>/skills/<name>/`. amp-orb writes
  // hosted skills at the checkout root and is not a workflow-skill install target.
  const root = await makeRoot();
  const harnesses = getAllHarnessIds().filter((id) => getHarness(id).skillsDir !== null);
  for (const harnessId of harnesses) {
    await mkdir(join(root, harnessId), { recursive: true });
  }

  const result = await installWorkflowSkills({
    harnesses,
    roots: { resolve: (harnessId) => join(root, harnessId) },
  });

  expect(result.skipped).toEqual([]);
  expect(result.targets.length).toBe(harnesses.length * 2);
  for (const harnessId of harnesses) {
    const harness = getHarness(harnessId);
    const skillDir = join(root, harnessId, harness.skillsDir!, WORKFLOW_AUTHORING_SKILL_NAME);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(
      renderWorkflowAuthoringSkillMarkdown(),
    );
    expect(await pathExists(join(skillDir, "references", "scheduling.md"))).toBe(true);
  }
});

test("does not fabricate a harness home that does not exist", async () => {
  const root = await makeRoot();
  const missing = join(root, "no-such-home");
  const result = await installWorkflowSkills({
    harnesses: ["claude-code"],
    roots: { resolve: () => missing },
  });

  expect(result.targets).toEqual([]);
  expect(result.skipped).toEqual([{ harness: "claude-code", reason: `${missing} does not exist` }]);
  expect(await pathExists(missing)).toBe(false);
});
