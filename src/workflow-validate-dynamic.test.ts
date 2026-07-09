import { describe, expect, test } from "bun:test";
import { type GeneratedSurface } from "./workflow-catalog.js";
import { scanDynamicPhaseAgentWarnings } from "./workflow-validate-dynamic.js";

const surface: GeneratedSurface = {
  agents: {
    forge: {
      explorer: { plugin: "forge", name: "explorer", description: "Explores." },
      builder: { plugin: "forge", name: "builder", description: "Builds." },
    },
  },
  orbits: {
    forge: {
      forge: {
        plugin: "forge",
        name: "forge",
        sequence: ["explore", "build"],
        phases: {
          explore: {
            name: "explore",
            orbit: "forge",
            plugin: "forge",
            agents: { explorer: { plugin: "forge", name: "explorer" } },
            criteria: [],
            io: { inputs: [], outputs: [] },
            framing: {},
          },
          build: {
            name: "build",
            orbit: "forge",
            plugin: "forge",
            agents: { builder: { plugin: "forge", name: "builder" } },
            criteria: [],
            io: { inputs: [], outputs: [] },
            framing: {},
          },
        },
      },
    },
  },
  models: {},
};

describe("scanDynamicPhaseAgentWarnings", () => {
  test("warns when an explicit phase tag uses an agent outside the phase set", () => {
    const source = `
      defineTask({
        id: "scope",
        agent: agents.forge.builder,
        prompt: "go",
        phase: "forge:explore",
      });
    `;
    const warnings = scanDynamicPhaseAgentWarnings(source, surface);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.taskId).toBe("scope");
    expect(warnings[0]?.phase).toBe("forge:explore");
    expect(warnings[0]?.agent).toEqual({ plugin: "forge", name: "builder" });
    expect(warnings[0]?.message).toContain("not assigned to that phase");
  });

  test("accepts wf.phase blocks that use the phase agent slot", () => {
    const source = `
      import { orbits } from "prism/refs";
      const forge = orbits.forge.forge;
      export const workflow = defineWorkflow({
        name: "ok",
        run: (wf) => wf.phase(forge.phases.explore, (ctx) => ctx.task({
          id: "scope",
          agent: ctx.agents.explorer,
          prompt: "go",
        })),
      });
    `;
    expect(scanDynamicPhaseAgentWarnings(source, surface)).toEqual([]);
  });

  test("warns on wf.phase blocks that bind the wrong agents.* ref", () => {
    const source = `
      import { orbits, agents } from "prism/refs";
      const forge = orbits.forge.forge;
      export const workflow = defineWorkflow({
        name: "bad",
        run: (wf) => wf.phase(forge.phases.explore, (ctx) => ctx.task({
          id: "scope",
          agent: agents.forge.builder,
          prompt: "go",
        })),
      });
    `;
    const warnings = scanDynamicPhaseAgentWarnings(source, surface);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.phase).toBe("forge:explore");
  });

  test("returns no warnings when the compiled surface has no typed phases", () => {
    const legacySurface: GeneratedSurface = {
      agents: surface.agents,
      orbits: { forge: { forge: { plugin: "forge", name: "forge" } } },
      models: {},
    };
    const source = `defineTask({ id: "x", agent: agents.forge.builder, prompt: "go", phase: "forge:explore" });`;
    expect(scanDynamicPhaseAgentWarnings(source, legacySurface)).toEqual([]);
  });
});