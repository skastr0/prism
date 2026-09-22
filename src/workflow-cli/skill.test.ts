import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_VALIDATION } from "../types.js";
import { prismWorkflowAuthoringSkillPath } from "./paths.js";
import { WORKFLOW_SKILL_REFERENCES } from "./skill-references/index.js";
import { renderWorkflowAuthoringSkillMarkdown, renderWorkflowSkillMarkdown, writeWorkflowAuthoringSkill } from "./skill.js";
import { renderWorkflowModelsSkillMarkdown } from "./models-skill.js";

test("embedded workflow skill teaches the named-worker path", () => {
  const markdown = renderWorkflowAuthoringSkillMarkdown();
  expect(markdown).toContain("name: prism-workflow");
  expect(markdown).toContain("Plugins are optional");
  expect(markdown).toContain("prism workflow workers");
  expect(markdown).toContain('from "prism/refs/workers"');
  expect(markdown).toContain("worker: workers.reviewer");
  // reviewer is an example, not a guarantee about any machine's catalog.
  expect(markdown).toContain("example ref");
  expect(markdown).not.toContain("agent:");
  expect(markdown).toContain("omit the field");
  // The static embedded copy must send the agent to fresh truth, not stale prefs.
  expect(markdown).toContain("prism workflow skill");
  expect(markdown).toContain("never the catalog");
  expect(markdown).not.toContain("models prefer");
  expect(markdown).not.toContain("workflow-model-preferences");
  // Raw combinatorics live in the models skill, not in the primary authoring path.
  expect(markdown).toContain("skill --models");
  expect(markdown).not.toContain("sandbox-read-only");
  expect(markdown).not.toContain("catalogModel");
  expect(markdown).not.toContain("gemini-3.8-flash-low");
  expect((markdown.match(/import \{ workers \}/g) ?? []).length).toBe(2);
  // SOP routing stays in the primary skill.
  expect(markdown).toContain("wf.phase");
  expect(markdown).toContain("prism/refs/sops");
  expect(markdown).toContain("catalog --sop");
  expect(markdown).not.toContain("orbit");
  expect(markdown).toContain("Write the workflow directly");
  expect(markdown).toContain("Effect.gen");
  expect(markdown).toContain("--reference <chapter>");
  for (const file of [markdown, renderWorkflowModelsSkillMarkdown(), ...WORKFLOW_SKILL_REFERENCES.map((ref) => ref.markdown)]) {
    expect(file).not.toMatch(/scaffold/i);
  }
});

test("the printed skill embeds the installed catalog and project refs", () => {
  const markdown = renderWorkflowSkillMarkdown({
    workers: {
      version: 1,
      workers: [{
        name: "reviewer",
        description: "Careful code review; low risk tolerance.",
        config: { worker: "claude-code" },
      }],
    },
    project: {
      surfaceDir: "/tmp/prism/state/projects/k/generated",
      present: true,
      namespaces: [{ namespace: "forge", sopRefs: ["sops.forge.beacon"] }],
    },
  });
  expect(markdown).toContain("workers.reviewer");
  expect(markdown).toContain("Careful code review; low risk tolerance.");
  expect(markdown).toContain("sops.forge.beacon");
  // Descriptions guide selection; they must not leak into prompt guidance.
  expect(markdown).toContain("never prompt content");
});

test("the printed skill says so when nothing is installed or compiled", () => {
  const markdown = renderWorkflowSkillMarkdown({
    workers: { version: 1, workers: [] },
    project: { surfaceDir: "/tmp/none/generated", present: false, namespaces: [] },
  });
  expect(markdown).toContain("No named workers installed");
  expect(markdown).toContain("Raw worker configurations remain available");
  expect(markdown).toContain("No compiled plugin refs");
});

test("the models skill carries the raw-pin combinatorics the primary skill omits", () => {
  const markdown = renderWorkflowModelsSkillMarkdown();
  expect(markdown).toContain("catalogModel");
  expect(markdown).toContain("gemini-3.8-flash-low");
  expect(markdown).toContain("sandbox-read-only");
  expect(markdown).toContain("restrictedTools");
  expect(markdown).toContain("provider/id");
  expect(markdown).not.toContain("models prefer");
  expect(markdown).not.toContain("workflow-model-preferences");
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
