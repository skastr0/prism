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
