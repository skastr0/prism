import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessTypesSnapshot } from "./harness-types.js";
import { harnessTypesDir } from "./harness-types.js";
import {
  buildWorkflowModelCatalog,
  filterWorkerModelCatalog,
  modelFamilyId,
  parseWorkflowWorkerId,
  pickPluginFreeScaffoldPins,
  pickScaffoldModel,
  projectWorkerModelCatalog,
  renderWorkerModelCatalogHuman,
  suggestHarnessSlugs,
} from "./workflow-models.js";

const snapshot: HarnessTypesSnapshot = {
  generatedAt: "2026-09-09T00:00:00.000Z",
  harnesses: [
    {
      harness: "cursor",
      source: "command",
      models: [
        { id: "gemini-3.8-flash-low" },
        { id: "gemini-3.8-flash-medium" },
        { id: "gemini-3.8-flash-high" },
        { id: "claude-opus-5-thinking-high-fast" },
        { id: "claude-opus-5-low" },
        { id: "composer-2.5-fast" },
        { id: "cursor-grok-4.6-low" },
      ],
    },
    {
      harness: "amp-code",
      source: "command",
      models: [
        { id: "low", kind: "dial" },
        { id: "anthropic/claude-haiku-4-5-20251001", kind: "model" },
      ],
    },
  ],
};

describe("modelFamilyId", () => {
  test("peels effort and thinking suffixes", () => {
    expect(modelFamilyId("gemini-3.8-flash-low")).toBe("gemini-3.8-flash");
    expect(modelFamilyId("claude-opus-5-thinking-high-fast")).toBe("claude-opus-5");
    expect(modelFamilyId("claude-opus-5-low")).toBe("claude-opus-5");
    expect(modelFamilyId("cursor-grok-4.6-low")).toBe("cursor-grok-4.6");
    expect(modelFamilyId("composer-2.5-fast")).toBe("composer-2.5");
    expect(modelFamilyId("anthropic/claude-haiku-4-5-20251001")).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(modelFamilyId("low")).toBe("low");
  });
});

describe("projectWorkerModelCatalog", () => {
  test("groups cursor slugs by family and keeps every worker", () => {
    const catalogs = projectWorkerModelCatalog(snapshot);
    const cursor = catalogs.find((entry) => entry.worker === "cursor");
    expect(cursor?.modelCount).toBe(7);
    const gemini = cursor?.families.find((family) => family.family === "gemini-3.8-flash");
    expect(gemini?.slugs).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
    ]);
    const opus = cursor?.families.find((family) => family.family === "claude-opus-5");
    expect(opus?.slugs).toEqual(["claude-opus-5-low", "claude-opus-5-thinking-high-fast"]);
    expect(catalogs.map((entry) => entry.worker)).toContain("hermes");
  });
});

describe("filterWorkerModelCatalog", () => {
  test("query matches family or slug", () => {
    const catalogs = filterWorkerModelCatalog(projectWorkerModelCatalog(snapshot), {
      worker: "cursor",
      query: "opus",
    });
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]?.families.map((family) => family.family)).toEqual(["claude-opus-5"]);
  });
});

describe("suggestHarnessSlugs", () => {
  test("gemini-3.8-flash suggests the effort-suffixed family", () => {
    const catalogs = projectWorkerModelCatalog(snapshot);
    expect(suggestHarnessSlugs(catalogs, "cursor", "gemini-3.8-flash")).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
    ]);
  });
});

describe("parseWorkflowWorkerId", () => {
  test("accepts known workers and names the rest", () => {
    expect(parseWorkflowWorkerId("cursor")).toBe("cursor");
    expect(() => parseWorkflowWorkerId("not-a-worker")).toThrow(/Unknown worker/);
  });
});

describe("renderWorkerModelCatalogHuman", () => {
  test("nests slugs under families", () => {
    const out = renderWorkerModelCatalogHuman(
      filterWorkerModelCatalog(projectWorkerModelCatalog(snapshot), { worker: "cursor", query: "gemini" }),
      { query: "gemini" },
    );
    expect(out).toContain("gemini-3.8-flash");
    expect(out).toContain("gemini-3.8-flash-low");
  });
});

describe("pickPluginFreeScaffoldPins", () => {
  test("prefers cursor then amp-code with cheap slugs", () => {
    const pins = pickPluginFreeScaffoldPins(snapshot);
    expect(pins).toEqual([
      { worker: "cursor", model: "composer-2.5-fast" },
      { worker: "amp-code", model: "low" },
    ]);
  });

  test("falls back to claude-code when no snapshot", () => {
    expect(pickPluginFreeScaffoldPins(undefined)).toEqual([{ worker: "claude-code" }]);
  });

  test("pickScaffoldModel prefers -fast then -low", () => {
    const catalogs = projectWorkerModelCatalog(snapshot);
    expect(pickScaffoldModel(catalogs, "cursor")).toBe("composer-2.5-fast");
  });
});

describe("buildWorkflowModelCatalog", () => {
  test("reads discovered.json from prism home", () => {
    const prismHome = mkdtempSync(join(tmpdir(), "prism-models-"));
    mkdirSync(harnessTypesDir(prismHome), { recursive: true });
    writeFileSync(
      join(harnessTypesDir(prismHome), "discovered.json"),
      JSON.stringify(snapshot),
    );
    const result = buildWorkflowModelCatalog({ prismHome, worker: "cursor", query: "grok" });
    expect(result.snapshotPresent).toBe(true);
    expect(result.catalogs[0]?.families[0]?.family).toBe("cursor-grok-4.6");
  });
});
