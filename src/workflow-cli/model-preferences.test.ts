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
    expect(offer.workers[0]?.sample.map((sample) => sample.slug)).toContain("composer-2.5-fast");
    expect(offer.workers[0]?.preference?.model).toBe("composer-2.5-fast");
    const human = renderWorkflowModelOfferHuman(offer);
    expect(human).toContain("preferred: model composer-2.5-fast");
    expect(human).toContain("sample:");
  });

  test("offer still shows saved prefs without a snapshot", () => {
    const catalogs = projectWorkerModelCatalog(undefined);
    const offer = buildWorkflowModelOffer({
      catalogs: catalogs.filter((entry) => entry.worker === "cursor"),
      preferences: { version: 1, notes: "cheap cursor", workers: [{ worker: "cursor", model: "composer-2.5-fast" }] },
      preferencesPath: "/tmp/prefs.json",
      snapshotPresent: false,
    });
    const human = renderWorkflowModelOfferHuman(offer);
    expect(human).toContain("No harness model snapshot yet");
    expect(human).toContain("preferred: model composer-2.5-fast");
    expect(human).toContain("Notes: cheap cursor");
  });

  test("Amp offer labels dial vs catalog flags", () => {
    const catalogs = projectWorkerModelCatalog({
      generatedAt: "2026-09-11T00:00:00.000Z",
      harnesses: [{
        harness: "amp-code",
        source: "command",
        models: [
          { id: "low", kind: "dial" },
          { id: "grok45", kind: "plugin-mode" },
          { id: "anthropic/claude-haiku-4-5-20251001", kind: "model" },
        ],
      }],
    });
    const offer = buildWorkflowModelOffer({
      catalogs: catalogs.filter((entry) => entry.worker === "amp-code"),
      preferences: { version: 1, workers: [] },
      preferencesPath: "/tmp/prefs.json",
      snapshotPresent: true,
    });
    expect(offer.workers[0]?.sample).toEqual([
      { slug: "low", pin: "model", kind: "dial" },
      { slug: "grok45", pin: "model", kind: "plugin-mode" },
      { slug: "anthropic/claude-haiku-4-5-20251001", pin: "catalogModel", kind: "model" },
    ]);
    const human = renderWorkflowModelOfferHuman(offer);
    expect(human).toContain("low [--model dial]");
    expect(human).toContain("grok45 [--model plugin]");
    expect(human).toContain("anthropic/claude-haiku-4-5-20251001 [--catalog-model]");
  });

  test("rejects an Amp dial saved as catalogModel", () => {
    expect(() => decodeWorkflowModelPreferences({
      version: 1,
      workers: [{ worker: "amp-code", catalogModel: "low" }],
    })).toThrow(/--model/);
  });

  test("models skill teaches quiz then prefer", () => {
    const markdown = renderWorkflowModelsSkillMarkdown();
    expect(markdown).toContain("name: prism-workflow-models");
    expect(markdown).toContain("prism workflow models --offer");
    expect(markdown).toContain("prism workflow models prefer");
    expect(markdown).toContain("Do not invent slugs");
    expect(markdown).toContain("Stop and wait for their answer");
    expect(markdown).not.toContain("prefer cursor --model composer-2.5-fast");
  });
});
