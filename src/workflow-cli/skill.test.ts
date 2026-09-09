import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prismWorkflowAuthoringSkillPath } from "./paths.js";
import { renderWorkflowAuthoringSkillMarkdown, writeWorkflowAuthoringSkill } from "./skill.js";

test("embedded workflow skill teaches the plugin-free path", () => {
  const markdown = renderWorkflowAuthoringSkillMarkdown();
  expect(markdown).toContain("name: prism-workflow");
  expect(markdown).toContain("Plugins are optional");
  expect(markdown).toContain("prism workflow models");
  expect(markdown).toContain("anonymousWorkflowAgent");
  expect(markdown).toContain("catalogModel");
  expect(markdown).toContain("gemini-3.8-flash-low");
});

test("writeWorkflowAuthoringSkill materializes SKILL.md under PRISM_HOME", async () => {
  const prismHome = mkdtempSync(join(tmpdir(), "prism-skill-"));
  const result = await writeWorkflowAuthoringSkill(prismHome);
  expect(result.path).toBe(prismWorkflowAuthoringSkillPath(prismHome));
  const written = await readFile(result.path, "utf8");
  expect(written).toBe(renderWorkflowAuthoringSkillMarkdown());
});
