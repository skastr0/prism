import { describe, expect, test } from "bun:test";
import { LOWERER_CAPABILITIES } from "./lowerer-capabilities.js";
import {
  lookupCatalogRef,
  lookupOrbitNamespace,
  pickDefaultAgent,
  pickDefaultAgentRef,
  pickDefaultWorkers,
  projectCatalog,
  projectCompactIndex,
  renderCompactIndexHuman,
  renderQueryResultsHuman,
  renderRefDetailHuman,
  renderRefNotFoundMessage,
  renderRefsStatus,
  scaffoldWorkflowSource,
  searchCatalog,
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

// --- gradual-disclosure catalog modes ------------------------------------------

describe("projectCompactIndex", () => {
  const catalog = projectCatalog(fixture);
  const index = projectCompactIndex(catalog, "/surface/dir");

  test("summarizes each namespace with agent count and orbit ref, dropping per-agent detail", () => {
    expect(index.namespaces).toEqual([
      { namespace: "forge", orbitRef: "orbits.forge.forge", agentCount: 1 },
      { namespace: "gleaner", orbitRef: null, agentCount: 1 },
    ]);
  });

  test("carries surfaceDir, present, workers, and a model-profile count (not the full list)", () => {
    expect(index.surfaceDir).toBe("/surface/dir");
    expect(index.present).toBe(true);
    expect(index.workers).toEqual(catalog.workers);
    expect(index.modelProfileCount).toBe(1);
  });
});

describe("renderCompactIndexHuman", () => {
  const index = projectCompactIndex(projectCatalog(fixture), "/surface/dir");
  const out = renderCompactIndexHuman(index);

  test("lists one line per namespace with agent count and orbit ref", () => {
    expect(out).toContain("forge  (1 agent, orbit ref: orbits.forge.forge)");
    expect(out).toContain("gleaner  (1 agent)");
  });

  test("omits per-agent detail (the point of the compact mode)", () => {
    expect(out).not.toContain("Builds.");
    expect(out).not.toContain("agents.forge.builder");
  });

  test("names every drill-down flag in the footer", () => {
    expect(out).toContain("--orbit <ns>");
    expect(out).toContain("--ref <ref>");
    expect(out).toContain("--query <text>");
    expect(out).toContain("--full");
  });

  test("stays compact — well under a context-bomb line count", () => {
    expect(out.split("\n").length).toBeLessThan(15);
  });
});

describe("lookupOrbitNamespace", () => {
  const catalog = projectCatalog(fixture);

  test("finds a namespace with full per-agent detail intact", () => {
    const result = lookupOrbitNamespace(catalog, "forge");
    expect(result.found).toBe(true);
    expect(result.namespace?.agents[0]?.ref).toBe("agents.forge.builder");
    expect(result.namespace?.agents[0]?.description).toBe("Builds.");
  });

  test("reports every namespace as available when the name is unknown", () => {
    const result = lookupOrbitNamespace(catalog, "nope");
    expect(result.found).toBe(false);
    expect(result.namespace).toBeNull();
    expect(result.available).toEqual(["forge", "gleaner"]);
  });
});

describe("lookupCatalogRef", () => {
  const catalog = projectCatalog(fixture);

  test("resolves an agent ref", () => {
    const result = lookupCatalogRef(catalog, "agents.forge.builder");
    expect(result.found).toBe(true);
    expect(result.entity).toMatchObject({
      kind: "agent",
      ref: "agents.forge.builder",
      plugin: "forge",
      name: "builder",
      description: "Builds.",
    });
  });

  test("resolves an orbit ref", () => {
    const result = lookupCatalogRef(catalog, "orbits.forge.forge");
    expect(result.found).toBe(true);
    expect(result.entity).toEqual({ kind: "orbit", ref: "orbits.forge.forge", plugin: "forge", name: "forge" });
  });

  test("resolves a model-profile ref", () => {
    const result = lookupCatalogRef(catalog, "models.agent-foundations.empirical-modelspaces.coding-frontier");
    expect(result.found).toBe(true);
    expect(result.entity).toEqual({
      kind: "model",
      ref: "models.agent-foundations.empirical-modelspaces.coding-frontier",
      plugin: "agent-foundations",
      modelspace: "empirical-modelspaces",
      profile: "coding-frontier",
    });
  });

  test("suggests up to 5 closest refs for an unknown ref by substring match", () => {
    const result = lookupCatalogRef(catalog, "agents.forge.build");
    expect(result.found).toBe(false);
    expect(result.entity).toBeNull();
    expect(result.suggestions).toContain("agents.forge.builder");
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
  });

  test("empty suggestions when nothing is close", () => {
    const result = lookupCatalogRef(catalog, "totally-unrelated-ref");
    expect(result.found).toBe(false);
    expect(result.suggestions).toEqual([]);
  });
});

describe("renderRefDetailHuman", () => {
  const catalog = projectCatalog(fixture);

  test("renders full agent detail including per-harness models", () => {
    const { entity } = lookupCatalogRef(catalog, "agents.forge.builder");
    const out = renderRefDetailHuman(entity!);
    expect(out).toContain("agents.forge.builder");
    expect(out).toContain("claude-code: claude-opus-4-8");
    expect(out).toContain("Builds.");
    expect(out).toContain("claude-code, grok");
  });

  test("renders orbit detail", () => {
    const { entity } = lookupCatalogRef(catalog, "orbits.forge.forge");
    const out = renderRefDetailHuman(entity!);
    expect(out).toContain("orbits.forge.forge");
    expect(out).toContain("plugin: forge");
  });

  test("renders model-profile detail", () => {
    const { entity } = lookupCatalogRef(catalog, "models.agent-foundations.empirical-modelspaces.coding-frontier");
    const out = renderRefDetailHuman(entity!);
    expect(out).toContain("modelspace: empirical-modelspaces");
    expect(out).toContain("profile: coding-frontier");
  });
});

describe("renderRefNotFoundMessage", () => {
  test("lists suggestions when present", () => {
    expect(renderRefNotFoundMessage("agents.forge.build", ["agents.forge.builder"])).toContain(
      "Closest matches: agents.forge.builder",
    );
  });

  test("points at --query when there are no suggestions", () => {
    expect(renderRefNotFoundMessage("zzz", [])).toContain("--query");
  });
});

describe("searchCatalog", () => {
  const catalog = projectCatalog(fixture);

  test("matches agents by description substring, case-insensitively", () => {
    const hits = searchCatalog(catalog, "BUILDS");
    expect(hits).toEqual([{ ref: "agents.forge.builder", name: "builder", descriptionExcerpt: "Builds." }]);
  });

  test("matches orbit refs and names", () => {
    const hits = searchCatalog(catalog, "orbits.forge");
    expect(hits.map((h) => h.ref)).toContain("orbits.forge.forge");
  });

  test("matches model-profile refs", () => {
    const hits = searchCatalog(catalog, "coding-frontier");
    expect(hits.map((h) => h.ref)).toContain("models.agent-foundations.empirical-modelspaces.coding-frontier");
  });

  test("zero hits for a non-matching query", () => {
    expect(searchCatalog(catalog, "nonexistent-xyz")).toEqual([]);
  });

  test("truncates long descriptions to ~100 chars with an ellipsis", () => {
    const longDescription = "x".repeat(150);
    const surface: GeneratedSurface = {
      agents: { ns: { a: { plugin: "p", name: "a", description: longDescription } } },
      orbits: {},
      models: {},
    };
    const hits = searchCatalog(projectCatalog(surface), "xxx");
    expect(hits[0]!.descriptionExcerpt.length).toBe(101);
    expect(hits[0]!.descriptionExcerpt.endsWith("…")).toBe(true);
  });
});

describe("renderQueryResultsHuman", () => {
  test("zero hits suggests the compact index", () => {
    const out = renderQueryResultsHuman([], "nonexistent-xyz");
    expect(out).toContain("No matches");
    expect(out).toContain("prism workflow catalog");
  });

  test("formats each hit as ref — name — description and hints --ref", () => {
    const out = renderQueryResultsHuman(
      [{ ref: "agents.forge.builder", name: "builder", descriptionExcerpt: "Builds." }],
      "build",
    );
    expect(out).toContain("agents.forge.builder — builder — Builds.");
    expect(out).toContain("--ref <ref>");
  });
});
