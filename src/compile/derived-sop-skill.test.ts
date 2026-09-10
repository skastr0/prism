import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  renderDerivedSopPhaseReferences,
  renderDerivedSopSkillBody,
} from "./derived-sop-skill.js";
import { renderStandardSopSkill } from "./lowerers/shared.js";
import { Sop } from "./sources.js";

const fixtureSop = (): Sop =>
  new Sop({
    name: "beacon",
    sourcePath: "/tmp/beacon/sops/beacon.sop.ts",
    description: "Marketing method for positioning work.",
    phases: [
      {
        name: "explore",
        purpose: "Map the audience and the competitive space.",
        input: Schema.Struct({ brief: Schema.String }),
        output: Schema.Struct({ summary: Schema.String }),
        acceptanceCriteria: [
          "Positioning hypothesis is falsifiable against the named audience",
        ],
        escalation: "Stop and ask a human when the audience is unnamed.",
        body: "## Explore\n\nRead the brief, then write the hypothesis.",
      },
      {
        name: "build",
        purpose: "Produce the positioning artifact.",
        acceptanceCriteria: [],
        body: "## Build\n\nWrite the artifact.",
      },
    ],
    body: "Run explore before build; never skip the falsifiability bar.",
  });

describe("renderDerivedSopSkillBody", () => {
  test("renders frontmatter-ready body with phase table, reference pointers, and top-level body", () => {
    const out = renderDerivedSopSkillBody(fixtureSop());

    expect(out).toContain("# beacon");
    expect(out).toContain("Marketing method for positioning work.");
    expect(out).toContain("| Phase | Purpose | Contract | Reference |");
    expect(out).toContain("Map the audience and the competitive space.");
    expect(out).toContain("[`references/explore.md`](references/explore.md)");
    expect(out).toContain("typed input + output");
    expect(out).toContain("[`references/build.md`](references/build.md)");
    expect(out).toContain("prose only");
    expect(out).toContain("Run explore before build; never skip the falsifiability bar.");
  });

  test("never renders executor/runtime sections", () => {
    const out = renderDerivedSopSkillBody(fixtureSop());

    for (const forbidden of [
      "Orchestrator",
      "Tools available",
      "Submission protocol",
      "Trait protocols",
      "Phase transitions",
      "Definitions",
      "Pulsar Checkpoints",
    ]) {
      expect(out).not.toContain(forbidden);
    }
  });
});

describe("renderDerivedSopPhaseReferences", () => {
  test("renders one download per phase with schema summaries, criteria, escalation, and body", () => {
    const files = renderDerivedSopPhaseReferences(fixtureSop());
    expect(files.map((file) => file.filename)).toEqual(["explore.md", "build.md"]);

    const explore = files[0]!.content;
    expect(explore).toContain("# beacon:explore");
    expect(explore).toContain("## Purpose");
    expect(explore).toContain("Map the audience and the competitive space.");
    expect(explore).toContain("## Input");
    expect(explore).toContain('Schema.Struct({ "brief": Schema.String })');
    expect(explore).toContain("## Output");
    expect(explore).toContain('Schema.Struct({ "summary": Schema.String })');
    expect(explore).toContain("## Acceptance criteria");
    expect(explore).toContain("- Positioning hypothesis is falsifiable against the named audience");
    expect(explore).toContain("## Escalation");
    expect(explore).toContain("Stop and ask a human when the audience is unnamed.");
    expect(explore).toContain("Read the brief, then write the hypothesis.");

    const build = files[1]!.content;
    expect(build).toContain("# beacon:build");
    expect(build).toContain("Write the artifact.");
    expect(build).not.toContain("## Input");
    expect(build).not.toContain("## Output");
    expect(build).not.toContain("## Acceptance criteria");
    expect(build).not.toContain("## Escalation");
  });
});

describe("renderStandardSopSkill", () => {
  test("wraps the SOP body in skill frontmatter with name and description", () => {
    const out = renderStandardSopSkill(fixtureSop());
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('name: "beacon"');
    expect(out).toContain('description: "Marketing method for positioning work."');
    expect(out).toContain("# beacon");
  });
});
