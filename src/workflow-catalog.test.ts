import { describe, expect, test } from "bun:test";
import { LOWERER_CAPABILITIES } from "./lowerer-capabilities.js";
import {
  pickDefaultAgent,
  pickDefaultAgentRef,
  pickDefaultWorkers,
  projectCatalog,
  renderRefsStatus,
  scaffoldWorkflowSource,
  WORKFLOW_WORKERS,
  type GeneratedSurface,
  type WorkflowCatalog,
} from "./workflow-catalog.js";

const fixture: GeneratedSurface = {
  agents: {
    forge: {
      builder: {
        plugin: "forge",
        name: "builder",
        description: "Builds.",
        installs: ["claude-code", "grok"],
        model: {
          targets: {
            "claude-code": { model: "claude-opus-4-8" },
            opencode: { models: [{ model: "glm-5.2" }, { model: "deepseek" }] },
            "amp-code": {},
          },
        },
      },
    },
    gleaner: {
      gleaner: { plugin: "gleaner", name: "gleaner", description: "Gleans." },
    },
  },
  orbits: {
    forge: { forge: { plugin: "forge", name: "forge" } },
  },
  models: {
    "agent-foundations": { "empirical-modelspaces": { "coding-frontier": {} } },
  },
};

describe("projectCatalog", () => {
  const catalog = projectCatalog(fixture);

  test("sorts namespaces and builds ref paths from the object keys", () => {
    expect(catalog.namespaces.map((n) => n.namespace)).toEqual(["forge", "gleaner"]);
    expect(catalog.namespaces[0]!.agents[0]!.ref).toBe("agents.forge.builder");
  });

  test("attaches an orbit ref only when the namespace has one", () => {
    expect(catalog.namespaces[0]!.orbit?.ref).toBe("orbits.forge.forge");
    expect(catalog.namespaces[1]!.orbit).toBeNull();
  });

  test("projects per-harness model: single, any-of (first +count), skips empty targets", () => {
    const m = catalog.namespaces[0]!.agents[0]!.modelByHarness;
    expect(m["claude-code"]).toBe("claude-opus-4-8");
    expect(m["opencode"]).toBe("glm-5.2 (+1)");
    expect(m["amp-code"]).toBeUndefined();
  });

  test("flattens model profiles to ref paths", () => {
    expect(catalog.modelProfiles[0]!.ref).toBe("models.agent-foundations.empirical-modelspaces.coding-frontier");
  });

  test("lists the supported workers", () => {
    expect(catalog.workers).toEqual([...WORKFLOW_WORKERS]);
  });
});

describe("WORKFLOW_WORKERS (derived from the workflowWorker capability bit)", () => {
  // Golden set: locks in the exact harnesses expected to be workflow workers
  // today. If this fails, either a harness's `workflowWorker` bit in
  // lowerer-capabilities.ts changed, or WORKFLOW_WORKERS drifted from it —
  // update this list deliberately, don't just make it pass.
  test("matches the golden harness set (PQ-163 regression: antigravity-cli was missing)", () => {
    expect(([...WORKFLOW_WORKERS] as string[]).sort()).toEqual(
      [
        "amp-code",
        "antigravity-cli",
        "claude-code",
        "codex-cli",
        "grok",
        "hermes",
        "kimi-code",
        "opencode",
      ].sort(),
    );
  });

  test("excludes every harness flagged workflowWorker: false", () => {
    const unflagged = Object.values(LOWERER_CAPABILITIES)
      .filter((profile) => !profile.workflowWorker)
      .map((profile): string => profile.harness);
    expect(unflagged.sort()).toEqual(["cursor", "factory-droid", "openclaw", "pi"].sort());
    for (const harness of unflagged) {
      expect(WORKFLOW_WORKERS as readonly string[]).not.toContain(harness);
    }
  });

  test("contains exactly the harnesses flagged workflowWorker: true", () => {
    const flagged = Object.values(LOWERER_CAPABILITIES)
      .filter((profile) => profile.workflowWorker)
      .map((profile): string => profile.harness);
    expect(([...WORKFLOW_WORKERS] as string[]).sort()).toEqual(flagged.sort());
  });
});

describe("workflowWorker capability-bit coverage assertion (fixture)", () => {
  // The production assertion (workflow-catalog.ts) lives entirely at the type
  // level, so it can't be exercised with a runtime `expect`. This fixture
  // reproduces the same generic mechanism in miniature to prove it actually
  // rejects drift, without adding a 13th real harness (a non-goal here).
  const fixtureCapabilities = {
    alpha: { workflowWorker: true },
    beta: { workflowWorker: true },
    gamma: { workflowWorker: true },
    delta: { workflowWorker: false },
  } as const;
  type FixtureHarnessId = keyof typeof fixtureCapabilities;
  type FixtureWorkflowWorkerHarnessId = {
    [K in FixtureHarnessId]: (typeof fixtureCapabilities)[K]["workflowWorker"] extends true ? K : never;
  }[FixtureHarnessId];
  // Mirrors WorkflowWorkerId: "gamma" has no worker module even though the
  // capability table above flags it workflowWorker: true.
  type FixtureWorkerModuleId = "alpha" | "beta";

  test("a capability-flagged harness without a matching worker module fails the coverage assertion at typecheck time", () => {
    // @ts-expect-error "gamma" is flagged workflowWorker:true above but is absent from FixtureWorkerModuleId — this is the exact shape of the tsc error a real new harness would hit against WorkflowWorkerId.
    const coverage: Exclude<FixtureWorkflowWorkerHarnessId, FixtureWorkerModuleId> extends never ? true : never = true;
    void coverage;
  });

  test("workflowWorker: false is never demanded as a worker module", () => {
    const flagged: FixtureWorkflowWorkerHarnessId[] = (
      Object.entries(fixtureCapabilities) as ReadonlyArray<readonly [FixtureHarnessId, { workflowWorker: boolean }]>
    )
      .filter(([, profile]) => profile.workflowWorker)
      .map(([harness]) => harness as FixtureWorkflowWorkerHarnessId);
    expect(flagged).not.toContain("delta");
    expect((flagged as string[]).sort()).toEqual(["alpha", "beta", "gamma"].sort());
  });
});

const catalogWith = (refs: ReadonlyArray<string>): WorkflowCatalog => ({
  namespaces: [
    {
      namespace: "x",
      orbit: null,
      agents: refs.map((ref) => ({
        ref,
        plugin: "x",
        name: ref.split(".").pop() ?? ref,
        description: "",
        installs: [],
        modelByHarness: {},
      })),
    },
  ],
  workers: [],
  modelProfiles: [],
});

describe("pickDefaultAgentRef", () => {
  test("prefers agents.forge.explorer", () => {
    expect(pickDefaultAgentRef(catalogWith(["agents.x.builder", "agents.forge.explorer"]))).toBe("agents.forge.explorer");
  });
  test("falls back to the first agent when no explorer/orchestrator", () => {
    expect(pickDefaultAgentRef(catalogWith(["agents.x.builder"]))).toBe("agents.x.builder");
  });
});

const catalogWithInstalls = (installs: ReadonlyArray<string>, workers: ReadonlyArray<string>): WorkflowCatalog => ({
  namespaces: [
    {
      namespace: "x",
      orbit: null,
      agents: [
        { ref: "agents.x.builder", plugin: "x", name: "builder", description: "", installs, modelByHarness: {} },
      ],
    },
  ],
  workers,
  modelProfiles: [],
});

describe("pickDefaultWorkers", () => {
  test("picks two workers when the agent is installed on 2+ workflow-worker harnesses", () => {
    const catalog = catalogWithInstalls(["claude-code", "grok", "cursor"], ["claude-code", "grok", "codex-cli"]);
    const agent = pickDefaultAgent(catalog);
    expect(pickDefaultWorkers(catalog, agent)).toEqual(["claude-code", "grok"]);
  });

  test("degrades to one worker when only one install is a workflow-worker harness (PQ-176 footgun #2)", () => {
    // cursor is a real harness but has no workflow-worker module — it must
    // never be picked, and the agent isn't installed on any other worker.
    const catalog = catalogWithInstalls(["claude-code", "cursor"], ["claude-code", "grok", "codex-cli"]);
    const agent = pickDefaultAgent(catalog);
    expect(pickDefaultWorkers(catalog, agent)).toEqual(["claude-code"]);
  });

  test("never picks a worker the agent has no install for", () => {
    const catalog = catalogWithInstalls(["claude-code"], ["claude-code", "grok", "codex-cli"]);
    const agent = pickDefaultAgent(catalog);
    const workers = pickDefaultWorkers(catalog, agent);
    expect(workers).toEqual(["claude-code"]);
    expect(workers).not.toContain("grok");
  });

  test("falls back to claude-code when the agent has no recorded installs", () => {
    expect(pickDefaultWorkers(catalogWithInstalls([], ["grok"]), undefined)).toEqual(["claude-code"]);
  });

  test("prefers claude-code first even when it sorts later in installs", () => {
    const catalog = catalogWithInstalls(
      ["amp-code", "claude-code", "codex-cli"],
      ["amp-code", "claude-code", "codex-cli"],
    );
    const agent = pickDefaultAgent(catalog);
    expect(pickDefaultWorkers(catalog, agent)).toEqual(["claude-code", "amp-code"]);
  });
});

describe("scaffoldWorkflowSource", () => {
  const src = scaffoldWorkflowSource("my-flow", "agents.forge.explorer", ["claude-code", "grok"]);
  test("embeds the workflow name, the chosen agent ref, and the refs import", () => {
    expect(src).toContain(`name: "my-flow"`);
    expect(src).toContain("agent: agents.forge.explorer,");
    expect(src).toContain('from "prism/refs"');
  });

  test("never instructs git add — workflows live outside the project repo", () => {
    expect(src).not.toContain("git add");
  });

  test("degrades to a single task when only one worker is available", () => {
    const singleWorkerSrc = scaffoldWorkflowSource("solo-flow", "agents.forge.explorer", ["claude-code"]);
    expect(singleWorkerSrc).toContain('probe("a", "claude-code")');
    expect(singleWorkerSrc).not.toContain("Effect.all");
    expect(singleWorkerSrc).not.toContain("grok");
  });
});

describe("renderRefsStatus", () => {
  test("missing surface explains how to compile", () => {
    const out = renderRefsStatus({ surfaceDir: "/d", present: false, refsManifestHash: null, compileManifestHash: null, freshness: "missing" });
    expect(out).toContain("missing");
  });
  test("stale shows both manifest hashes", () => {
    const out = renderRefsStatus({ surfaceDir: "/d", present: true, refsManifestHash: "aaaaaaaaaaaa1", compileManifestHash: "bbbbbbbbbbbb2", freshness: "stale" });
    expect(out).toContain("stale");
    expect(out).toContain("aaaaaaaaaaaa");
  });
});
