import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineWorkflow } from "./workflows.js";
import { type GeneratedSurface } from "./workflow-catalog.js";
import {
  collectDynamicPhaseFindings,
  probeDynamicWorkflowPhaseTasks,
  scanDynamicPhaseTaskBindings,
  validatePhaseBindings,
} from "./workflow-validate-dynamic.js";

const surface: GeneratedSurface = {
  agents: {
    forge: {
      explorer: { plugin: "forge", name: "explorer", description: "Explores." },
      builder: { plugin: "forge", name: "builder", description: "Builds." },
    },
  },
  sops: {
    forge: {
      beacon: {
        plugin: "forge",
        name: "beacon",
        phases: {
          explore: {
            name: "explore",
            sop: "beacon",
            plugin: "forge",
            framing: { purpose: "Map the space." },
          },
          build: {
            name: "build",
            sop: "beacon",
            plugin: "forge",
            framing: { purpose: "Build the artifact." },
          },
        },
      },
    },
  },
  models: {},
};

const exploreContract = {
  name: "explore",
  sop: "beacon",
  plugin: "forge",
  output: Schema.Struct({ summary: Schema.String }),
  framing: {},
  criteria: [],
} as const;

describe("validatePhaseBindings", () => {
  test("returns no findings when the stamped phase exists in the SOP surface", () => {
    const findings = validatePhaseBindings(
      [{ taskId: "scope", phase: "beacon:explore" }],
      surface,
    );
    expect(findings).toEqual([]);
  });

  test("warns when a stamped phase is not present in the compiled SOP surface", () => {
    const findings = validatePhaseBindings(
      [{ taskId: "scope", phase: "beacon:missing" }],
      surface,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.taskId).toBe("scope");
    expect(findings[0]?.phase).toBe("beacon:missing");
    expect(findings[0]?.message).toContain("not present in the compiled SOP surface");
  });

  test("returns no findings when the compiled surface has no typed SOP phases", () => {
    const legacySurface: GeneratedSurface = {
      agents: surface.agents,
          sops: {},
      models: {},
    };
    expect(validatePhaseBindings(
      [{ taskId: "x", phase: "beacon:explore" }],
      legacySurface,
    )).toEqual([]);
  });
});

describe("probeDynamicWorkflowPhaseTasks", () => {
  test("records wf.phase tasks from the loaded workflow graph without agent data", async () => {
    const workflow = defineWorkflow({
      name: "ok",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        prompt: "go",
      })),
    });
    const bindings = await probeDynamicWorkflowPhaseTasks(workflow);
    expect(bindings).toEqual([
      { taskId: "scope", phase: "beacon:explore" },
    ]);
  });

  test("collectDynamicPhaseFindings returns no findings for a valid bound phase", async () => {
    const workflow = defineWorkflow({
      name: "ok",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        prompt: "go",
      })),
    });
    const findings = await collectDynamicPhaseFindings(workflow, "", surface);
    expect(findings).toEqual([]);
  });
});

describe("scanDynamicPhaseTaskBindings", () => {
  test("accepts wf.phase blocks that bind a known SOP phase", () => {
    const source = `
      import { sops } from "prism/refs/sops";
      const beacon = sops.forge.beacon;
      export const workflow = defineWorkflow({
        name: "ok",
        run: (wf) => wf.phase(beacon.phases.explore, (ctx) => ctx.task({
          id: "scope",
          prompt: "go",
        })),
      });
    `;
    expect(validatePhaseBindings(scanDynamicPhaseTaskBindings(source, surface), surface)).toEqual([]);
  });

  test("discovers unknown SOP phases in wf.phase blocks via regex fallback", () => {
    const source = `
      import { sops } from "prism/refs/sops";
      const beacon = sops.forge.beacon;
      export const workflow = defineWorkflow({
        name: "bad",
        run: (wf) => wf.phase(beacon.phases.missing, (ctx) => ctx.task({
          id: "scope",
          prompt: "go",
        })),
      });
    `;
    const findings = validatePhaseBindings(scanDynamicPhaseTaskBindings(source, surface), surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.phase).toBe("beacon:missing");
  });

  test("falls back to literal-beacon fixture when no generated sops module exists", () => {
    const source = `
      import { sops } from "prism/refs/sops";
      const beacon = sops.forge.beacon;
      export const workflow = defineWorkflow({
        name: "bad",
        run: (wf) => wf.phase(beacon.phases.explore, (ctx) => ctx.task({
          id: "scope",
          phase: "beacon:explore",
          prompt: "go",
        })),
      });
    `;
    const findings = validatePhaseBindings(scanDynamicPhaseTaskBindings(source, null), null);
    expect(findings).toEqual([]);
  });
});
