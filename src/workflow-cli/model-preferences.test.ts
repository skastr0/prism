import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prismWorkflowModelPreferencesPath } from "./paths.js";
import {
  clearWorkflowModelPreference,
  decodeWorkflowModelPreferences,
  loadWorkflowModelPreferences,
  upsertWorkflowModelPreference,
  writeWorkflowModelPreferences,
} from "./model-preferences.js";
import { buildWorkflowModelOffer, renderWorkflowModelOfferHuman } from "./model-offer.js";
import { projectWorkerModelCatalog } from "../workflow-models.js";
import type { HarnessTypesSnapshot } from "../harness-types.js";
import { renderWorkflowModelsSkillMarkdown } from "./models-skill.js";

const snapshot: HarnessTypesSnapshot = {
  generatedAt: "2026-09-11T00:00:00.000Z",
  harnesses: [{
    harness: "cursor",
    source: "command",
    models: [
      { id: "composer-2.5-fast" },
      { id: "gemini-3.8-flash-low" },
      { id: "gemini-3.8-flash-high" },
    ],
  }],
};

describe("workflow model preferences", () => {
  test("round-trips a pin and clears it", () => {
    const prismHome = mkdtempSync(join(tmpdir(), "prism-prefs-"));
    expect(loadWorkflowModelPreferences(prismHome).workers).toEqual([]);
    writeWorkflowModelPreferences(prismHome, {
      version: 1,
      workers: [{ worker: "cursor", model: "composer-2.5-fast" }],
    });
    const loaded = loadWorkflowModelPreferences(prismHome);
    expect(loaded.workers).toEqual([{ worker: "cursor", model: "composer-2.5-fast" }]);
    const cleared = clearWorkflowModelPreference(loaded, "cursor");
    writeWorkflowModelPreferences(prismHome, cleared);
    expect(loadWorkflowModelPreferences(prismHome).workers).toEqual([]);
    expect(prismWorkflowModelPreferencesPath(prismHome)).toContain("workflow-model-preferences.json");
  });

  test("upsert replaces the same worker", () => {
    const current = decodeWorkflowModelPreferences({ version: 1, workers: [] });
    const once = upsertWorkflowModelPreference(current, { worker: "amp-code", catalogModel: "anthropic/claude-haiku-4-5-20251001", effort: "none" });
    const twice = upsertWorkflowModelPreference(once, { worker: "amp-code", model: "low" });
    expect(twice.workers).toEqual([{ worker: "amp-code", model: "low" }]);
  });

  test("offer lists samples and current prefs", () => {
    const catalogs = projectWorkerModelCatalog(snapshot);
    const offer = buildWorkflowModelOffer({
      catalogs: catalogs.filter((entry) => entry.worker === "cursor"),
      preferences: { version: 1, notes: "cheap cursor", workers: [{ worker: "cursor", model: "composer-2.5-fast" }] },
      preferencesPath: "/tmp/prefs.json",
      snapshotPresent: true,
    });
    expect(offer.workers[0]?.sample).toContain("composer-2.5-fast");
    expect(offer.workers[0]?.preference?.model).toBe("composer-2.5-fast");
    const human = renderWorkflowModelOfferHuman(offer);
    expect(human).toContain("preferred: model composer-2.5-fast");
    expect(human).toContain("sample:");
  });

  test("models skill teaches quiz then prefer", () => {
    const markdown = renderWorkflowModelsSkillMarkdown();
    expect(markdown).toContain("name: prism-workflow-models");
    expect(markdown).toContain("prism workflow models --offer");
    expect(markdown).toContain("prism workflow models prefer");
    expect(markdown).toContain("Do not invent slugs");
  });
});
