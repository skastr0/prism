import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { defineWorkflow } from "./workflows.js";
import { type GeneratedSurface } from "./workflow-catalog.js";
import {
  collectDynamicPhaseAgentFindings,
  probeDynamicWorkflowPhaseTasks,
  scanDynamicPhaseTaskBindings,
  validatePhaseAgentBindings,
} from "./workflow-validate-dynamic.js";

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

const emptyAgentsSurface: GeneratedSurface = {
  agents: surface.agents,
  orbits: {
    forge: {
      forge: {
        plugin: "forge",
        name: "forge",
        sequence: ["explore"],
        phases: {
          explore: {
            name: "explore",
            orbit: "forge",
            plugin: "forge",
            agents: {},
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

const explorer = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "explorer",
  description: "Explores.",
  sourceHash: "a",
  manifestHash: "b",
  installs: ["claude-code"],
};

const builder = {
  kind: "agent-ref" as const,
  plugin: "forge",
  name: "builder",
  description: "Builds.",
  sourceHash: "a",
  manifestHash: "b",
  installs: ["claude-code"],
};

const exploreContract = {
  name: "explore",
  orbit: "forge",
  plugin: "forge",
  agents: { explorer },
  output: Schema.Struct({ summary: Schema.String }),
  framing: {},
  criteria: [],
} as const;

describe("validatePhaseAgentBindings", () => {
  test("errors when an explicit phase tag uses an agent outside the phase set", () => {
    const findings = validatePhaseAgentBindings([
      {
        taskId: "scope",
        phase: "forge:explore",
        agent: { plugin: "forge", name: "builder" },
      },
    ], surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.taskId).toBe("scope");
    expect(findings[0]?.phase).toBe("forge:explore");
    expect(findings[0]?.message).toContain("not assigned to that phase");
  });

  test("errors when a stamped phase has an empty compiled agent allowlist", () => {
    const findings = validatePhaseAgentBindings([
      {
        taskId: "scope",
        phase: "forge:explore",
        agent: { plugin: "forge", name: "explorer" },
      },
    ], emptyAgentsSurface);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("assigns no agents");
  });

  test("returns no findings when the compiled surface has no typed phases", () => {
    const legacySurface: GeneratedSurface = {
      agents: surface.agents,
      orbits: { forge: { forge: { plugin: "forge", name: "forge" } } },
      models: {},
    };
    expect(validatePhaseAgentBindings([
      {
        taskId: "x",
        phase: "forge:explore",
        agent: { plugin: "forge", name: "builder" },
      },
    ], legacySurface)).toEqual([]);
  });
});

describe("probeDynamicWorkflowPhaseTasks", () => {
  test("records wf.phase tasks from the loaded workflow graph", async () => {
    const workflow = defineWorkflow({
      name: "ok",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        agent: ctx.agents.explorer,
        prompt: "go",
      })),
    });
    const bindings = await probeDynamicWorkflowPhaseTasks(workflow);
    expect(bindings).toEqual([
      {
        taskId: "scope",
        phase: "forge:explore",
        agent: { plugin: "forge", name: "explorer" },
      },
    ]);
  });

  test("collectDynamicPhaseAgentFindings errors on off-phase agents via probe", async () => {
    const workflow = defineWorkflow({
      name: "bad",
      run: (wf) => wf.phase(exploreContract, (ctx) => ctx.task({
        id: "scope",
        agent: builder,
        prompt: "go",
      })),
    });
    const findings = await collectDynamicPhaseAgentFindings(workflow, "", surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.phase).toBe("forge:explore");
  });
});

describe("scanDynamicPhaseTaskBindings", () => {
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
    expect(validatePhaseAgentBindings(scanDynamicPhaseTaskBindings(source, surface), surface)).toEqual([]);
  });

  test("discovers off-phase agents in wf.phase blocks via regex fallback", () => {
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
    const findings = validatePhaseAgentBindings(scanDynamicPhaseTaskBindings(source, surface), surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.phase).toBe("forge:explore");
  });
});