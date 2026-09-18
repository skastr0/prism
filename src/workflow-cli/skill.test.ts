import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_VALIDATION } from "../types.js";
import { prismWorkflowAuthoringSkillPath } from "./paths.js";
import { WORKFLOW_SKILL_REFERENCES } from "./skill-references/index.js";
import { renderWorkflowAuthoringSkillMarkdown, writeWorkflowAuthoringSkill } from "./skill.js";

test("embedded workflow skill teaches the plugin-free path", () => {
  const markdown = renderWorkflowAuthoringSkillMarkdown();
  expect(markdown).toContain("name: prism-workflow");
  expect(markdown).toContain("Plugins are optional");
  expect(markdown).toContain("prism workflow models");
  expect(markdown).toContain("prism workflow models --offer");
  expect(markdown).not.toContain("agent:");
  expect(markdown).toContain("catalogModel");
  expect(markdown).toContain("gemini-3.8-flash-low");
  expect(markdown).toContain("sandbox-read-only");
  expect(markdown).toContain("claude-code");
  expect(markdown).toContain("opencode2");
  expect(markdown).toContain("wf.phase");
  expect(markdown).toContain("prism/refs/sops");
  expect(markdown).toContain("catalog --sop");
  expect(markdown).not.toContain("orbit");
  expect(markdown).toContain("omit model");
  expect(markdown).toContain("Save only their answer");
  expect(markdown).not.toContain("prefer cursor --model composer-2.5-fast");
});

test("writeWorkflowAuthoringSkill materializes SKILL.md under PRISM_HOME", async () => {
  const prismHome = mkdtempSync(join(tmpdir(), "prism-skill-"));
  const result = await writeWorkflowAuthoringSkill(prismHome);
  expect(result.path).toBe(prismWorkflowAuthoringSkillPath(prismHome));
  const written = await readFile(result.path, "utf8");
  expect(written).toBe(renderWorkflowAuthoringSkillMarkdown());
});

test("SKILL.md routes to its reference chapters instead of carrying their depth", () => {
  const markdown = renderWorkflowAuthoringSkillMarkdown();
  expect(WORKFLOW_SKILL_REFERENCES.length).toBeGreaterThan(0);

  const seen = new Set<string>();
  for (const reference of WORKFLOW_SKILL_REFERENCES) {
    expect(reference.relativePath.startsWith("references/")).toBe(true);
    expect(reference.relativePath.endsWith(".md")).toBe(true);
    expect(seen.has(reference.relativePath)).toBe(false);
    seen.add(reference.relativePath);

    // Linked from the routing body, and a real chapter rather than a stub.
    expect(markdown).toContain(reference.relativePath);
    expect(reference.markdown.startsWith("# ")).toBe(true);
    expect(reference.markdown.trim().split("\n").length).toBeGreaterThan(40);
  }

  // The whole point of splitting: the body stays under the harness recommendation.
  expect(markdown.trim().split("\n").length).toBeLessThanOrEqual(
    SKILL_VALIDATION.RECOMMENDED_BODY_MAX_LINES,
  );
});

test("the reference chapters cover the features the CLI ships", () => {
  const paths = WORKFLOW_SKILL_REFERENCES.map((reference) => reference.relativePath);
  expect(paths).toContain("references/scheduling.md");
  expect(paths).toContain("references/jev.md");
  expect(paths).toContain("references/observability.md");
  expect(paths).toContain("references/cache-and-finish.md");
  expect(paths).toContain("references/topology.md");

  // Scheduling is the surface that had no agent-facing documentation anywhere.
  const scheduling = WORKFLOW_SKILL_REFERENCES.find(
    (reference) => reference.relativePath === "references/scheduling.md",
  )!;
  expect(scheduling.markdown).toContain("prism workflow schedule install");
  expect(scheduling.markdown).toContain("prism workflow scheduler serve");
});

test("writeWorkflowAuthoringSkill writes the reference chapters next to SKILL.md", async () => {
  const prismHome = mkdtempSync(join(tmpdir(), "prism-skill-refs-"));
  const result = await writeWorkflowAuthoringSkill(prismHome);
  const skillDir = dirname(result.path);

  expect(result.files).toEqual([
    result.path,
    ...WORKFLOW_SKILL_REFERENCES.map((reference) => join(skillDir, reference.relativePath)),
  ]);
  for (const reference of WORKFLOW_SKILL_REFERENCES) {
    expect(await readFile(join(skillDir, reference.relativePath), "utf8")).toBe(reference.markdown);
  }
});
