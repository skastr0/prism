import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { jevResultSchema } from "./jev.js";
import { defineWorkflow, jev } from "./workflows.js";
import { type GeneratedSurface } from "./workflow-catalog.js";
import {
  collectDynamicPhaseFindings,
  DYNAMIC_WORKFLOW_PROBE_DISPATCH_LIMIT,
  probeDynamicWorkflowPhaseTasks,
  probeDynamicWorkflowTasks,
  scanDynamicPhaseTaskBindings,
  validatePhaseBindings,
} from "./workflow-validate-dynamic.js";

const surface: GeneratedSurface = {
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
    const probed = await probeDynamicWorkflowTasks(workflow);
    expect(collectDynamicPhaseFindings(probed, "", surface)).toEqual([]);
    expect(probed.exhausted).toBe(false);
    expect(probed.failed).toBe(false);
  });
});

describe("probeDynamicWorkflowTasks jev handling", () => {
  const routeQuestions = {
    next: {
      type: "choice",
      criteria: { act: "act on it now", wait: "leave it parked" },
    },
    confidence: { type: "score", criteria: ["low", "medium", "high"] },
    note: { type: "noul", instructions: "one short line" },
  } as const;

  test("jev probe results are schema-valid witnesses and let branch reads work", async () => {
    const workflow = defineWorkflow({
      name: "jev-probe",
      run: (wf) =>
        Effect.gen(function* () {
          const route = yield* wf.runTask(jev({ id: "route", state: { tabs: 2 }, questions: routeQuestions }));
          // The probe must walk this branch instead of crashing on `{}`.
          if (route.answers.next.choice === "act" && route.answers.confidence.confidence > 0.5) {
            yield* wf.runTask(jev({ id: "route-again", state: {}, questions: routeQuestions }));
          }
        }),
    });

    const probed = await probeDynamicWorkflowTasks(workflow);

    expect(probed.failed).toBe(false);
    expect(probed.exhausted).toBe(false);
    expect(probed.tasks.map((task) => task.id)).toEqual(["route", "route-again"]);
  });

  test("every jev probe answer decodes against the request-correlated codec", async () => {
    const workflow = defineWorkflow({
      name: "jev-probe-codec",
      run: (wf) => wf.runTask(jev({ id: "route", state: {}, questions: routeQuestions })),
    });
    const probed = await probeDynamicWorkflowTasks(workflow);
    const task = probed.tasks[0]!;

    // The witness is produced inside the probe; re-deriving it here must match
    // and must decode against the task's own output codec.
    const witness = {
      model: "jev-probe",
      answers: {
        next: {
          type: "choice",
          choice: "act",
          confidence: 1,
          probabilities: { act: 1, wait: 0 },
        },
        confidence: {
          type: "score",
          score: 0,
          confidence: 1,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "0": 1, "1": 0, "2": 0 },
        },
        note: { type: "noul", noul: 0 },
      },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    expect(Schema.decodeUnknownSync(task.output)(witness)).toEqual(witness);
    expect(() =>
      Schema.decodeUnknownSync(jevResultSchema(routeQuestions))({
        ...witness,
        answers: {
          ...witness.answers,
          confidence: { ...witness.answers.confidence, probabilities: { "0": 1 } },
        },
      }),
    ).toThrow();
  });

  test("a decision-gated unbounded loop stops at the dispatch limit", async () => {
    const workflow = defineWorkflow({
      name: "jev-loop",
      run: (wf) =>
        Effect.gen(function* () {
          // jevProbeResult always answers noop > 0.8 with 0, so this loops
          // forever without a bound; the probe must stop and report exhausted.
          for (;;) {
            const decision = yield* wf.runTask(jev({ id: "decide", state: {}, questions: {
              go: { type: "noul" },
            } }));
            if (decision.answers.go.noul > 0.8) return;
          }
        }),
    });

    const probed = await probeDynamicWorkflowTasks(workflow);

    expect(probed.exhausted).toBe(true);
    expect(probed.failed).toBe(true);
    expect(probed.tasks).toHaveLength(DYNAMIC_WORKFLOW_PROBE_DISPATCH_LIMIT);
  });

  test("the phase scanner recognizes jev({...}) and ctx.jev({...}) heads", () => {
    const source = `
      export const workflow = defineWorkflow({
        name: "mixed",
        run: (wf) => wf.phase(beacon.phases.explore, (ctx) =>
          Effect.gen(function* () {
            yield* wf.runTask(jev({ id: "route", state: {}, phase: "beacon:removed", questions: {} }));
            yield* ctx.jev({ id: "gate", state: {}, phase: "beacon:build", questions: {} });
          })),
      });
    `;
    const findings = validatePhaseBindings(scanDynamicPhaseTaskBindings(source, surface), surface);
    expect(findings.map((finding) => finding.taskId)).toEqual(["route"]);
    expect(findings[0]?.phase).toBe("beacon:removed");
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
