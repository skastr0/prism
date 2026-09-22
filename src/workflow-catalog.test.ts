import { describe, expect, test } from "bun:test";
import { LOWERER_CAPABILITIES } from "./lowerer-capabilities.js";
import {
  lookupCatalogRef,
  projectCatalog,
  projectCompactIndex,
  renderCompactIndexHuman,
  renderQueryResultsHuman,
  renderRefDetailHuman,
  renderRefNotFoundMessage,
  renderRefsStatus,
  searchCatalog,
  WORKFLOW_WORKERS,
  type GeneratedSurface,
  type WorkflowCatalog,
} from "./workflow-catalog.js";

const fixture: GeneratedSurface = {
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
            criteria: ["Hypothesis is falsifiable"],
            framing: {
              purpose: "Map the space before committing.",
              escalation: "Ask a human when the audience is unclear",
            },
            input: { type: "object", properties: { brief: { type: "string" } } },
          },
          build: {
            name: "build",
            sop: "beacon",
            plugin: "forge",
            framing: {
              purpose: "Build the thing the phase contract describes.",
            },
          },
        },
      },
    },
  },
  models: {
    "agent-foundations": { "empirical-modelspaces": { "coding-frontier": {} } },
  },
};

describe("projectCatalog", () => {
  const catalog = projectCatalog(fixture);

  test("sorts namespaces and builds ref paths from the object keys", () => {
    expect(catalog.namespaces.map((n) => n.namespace)).toEqual(["forge"]);
    expect(catalog.namespaces[0]!.sops[0]!.ref).toBe("sops.forge.beacon");
    expect(catalog.namespaces[0]!.sops[0]!.phases.map((phase) => phase.ref)).toEqual([
      "sops.forge.beacon.phases.build",
      "sops.forge.beacon.phases.explore",
    ]);
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
        "cursor",
        "devin",
        "grok",
        "hermes",
        "kimi-code",
        "omp",
        "opencode",
      ].sort(),
    );
  });

  test("excludes every harness flagged workflowWorker: false", () => {
    const unflagged = Object.values(LOWERER_CAPABILITIES)
      .filter((profile) => !profile.workflowWorker)
      .map((profile): string => profile.harness);
    expect(unflagged.sort()).toEqual(["amp-orb", "pi"].sort());
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

describe("renderRefsStatus", () => {
  test("missing surface explains how to compile", () => {
    const out = renderRefsStatus({ surfaceDir: "/d", present: false, refsManifestHash: null, compileManifestHash: null, freshness: "missing" });
    expect(out).toContain("missing");
    expect(out).toContain("optional");
    expect(out).toContain("workflow models");
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

  test("summarizes each namespace by sop refs, dropping per-phase detail", () => {
    expect(index.namespaces).toEqual([
      { namespace: "forge", sopRefs: ["sops.forge.beacon"] },
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

  test("lists one line per namespace with its sop refs", () => {
    expect(out).toContain("forge  (sops.forge.beacon)");
  });

  test("omits per-sop detail (the point of the compact mode)", () => {
    expect(out).not.toContain("Map the space before committing.");
    expect(out).not.toContain("- beacon");
  });

  test("names every drill-down flag in the footer", () => {
    expect(out).toContain("--sop <name>");
    expect(out).toContain("--ref <ref>");
    expect(out).toContain("--query <text>");
    expect(out).toContain("--full");
    expect(out).toContain("prism workflow models");
  });

  test("stays compact — well under a context-bomb line count", () => {
    expect(out.split("\n").length).toBeLessThan(15);
  });
});

describe("lookupCatalogRef", () => {
  const catalog = projectCatalog(fixture);

  test("resolves a sop ref", () => {
    const result = lookupCatalogRef(catalog, "sops.forge.beacon");
    expect(result.found).toBe(true);
    expect(result.entity).toMatchObject({
      kind: "sop",
      ref: "sops.forge.beacon",
      plugin: "forge",
      name: "beacon",
    });
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
    const result = lookupCatalogRef(catalog, "models.agent-foundations.empirical-modelspaces.coding-front");
    expect(result.found).toBe(false);
    expect(result.entity).toBeNull();
    expect(result.suggestions).toContain("models.agent-foundations.empirical-modelspaces.coding-frontier");
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

  test("renders model-profile detail", () => {
    const { entity } = lookupCatalogRef(catalog, "models.agent-foundations.empirical-modelspaces.coding-frontier");
    const out = renderRefDetailHuman(entity!);
    expect(out).toContain("modelspace: empirical-modelspaces");
    expect(out).toContain("profile: coding-frontier");
  });

  test("renders sop and sop-phase detail", () => {
    const { entity } = lookupCatalogRef(catalog, "sops.forge.beacon");
    expect(entity?.kind).toBe("sop");
    expect(renderRefDetailHuman(entity!)).toContain("sops.forge.beacon");

    const phase = lookupCatalogRef(catalog, "sops.forge.beacon.phases.explore");
    expect(phase.entity?.kind).toBe("sop-phase");
    const phaseOut = renderRefDetailHuman(phase.entity!);
    expect(phaseOut).toContain("Map the space before committing.");
    expect(phaseOut).toContain("input=yes output=no");
    expect(phaseOut).toContain("Hypothesis is falsifiable");
  });
});

describe("renderRefNotFoundMessage", () => {
  test("lists suggestions when present", () => {
    expect(renderRefNotFoundMessage("sops.forge.beaco", ["sops.forge.beacon"])).toContain(
      "Closest matches: sops.forge.beacon",
    );
  });

  test("points at --query when there are no suggestions", () => {
    expect(renderRefNotFoundMessage("zzz", [])).toContain("--query");
  });
});

describe("searchCatalog", () => {
  const catalog = projectCatalog(fixture);

  test("matches sop-phase purposes case-insensitively", () => {
    const hits = searchCatalog(catalog, "BEFORE COMMITTING");
    expect(hits).toEqual([{ ref: "sops.forge.beacon.phases.explore", name: "explore", descriptionExcerpt: "Map the space before committing." }]);
  });

  test("matches model-profile refs", () => {
    const hits = searchCatalog(catalog, "coding-frontier");
    expect(hits.map((h) => h.ref)).toContain("models.agent-foundations.empirical-modelspaces.coding-frontier");
  });

  test("matches sop refs and phase purposes", () => {
    const refs = searchCatalog(catalog, "sops.forge").map((h) => h.ref);
    expect(refs).toContain("sops.forge.beacon");
    const purposeHits = searchCatalog(catalog, "falsifiable");
    expect(purposeHits.map((h) => h.ref)).toContain("sops.forge.beacon.phases.explore");
  });

  test("zero hits for a non-matching query", () => {
    expect(searchCatalog(catalog, "nonexistent-xyz")).toEqual([]);
  });

  test("truncates long phase purposes to ~100 chars with an ellipsis", () => {
    const longPurpose = "x".repeat(150);
    const surface: GeneratedSurface = {
      sops: {
        ns: {
          long: {
            plugin: "p",
            name: "long",
            phases: { phase: { name: "phase", sop: "long", plugin: "p", framing: { purpose: longPurpose } } },
          },
        },
      },
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
      [{ ref: "sops.forge.beacon", name: "beacon", descriptionExcerpt: "Maps the space." }],
      "beacon",
    );
    expect(out).toContain("sops.forge.beacon — beacon — Maps the space.");
    expect(out).toContain("--ref <ref>");
  });
});
