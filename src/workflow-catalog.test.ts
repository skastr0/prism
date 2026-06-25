import { describe, expect, test } from "bun:test";
import {
  pickDefaultAgentRef,
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

describe("scaffoldWorkflowSource", () => {
  const src = scaffoldWorkflowSource("my-flow", "agents.forge.explorer");
  test("embeds the workflow name, the chosen agent ref, and the refs import", () => {
    expect(src).toContain(`name: "my-flow"`);
    expect(src).toContain("agent: agents.forge.explorer,");
    expect(src).toContain('from "prism/refs"');
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
