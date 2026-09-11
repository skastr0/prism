/**
 * Agent-facing offer: workers, slug counts, a sample of slugs, current prefs.
 */

import type { WorkerModelCatalog } from "../workflow-models.js";
import { sampleWorkerSlugs } from "../workflow-models.js";
import type { WorkflowModelPreferencePin, WorkflowModelPreferences } from "./model-preferences.js";

export interface WorkerModelOffer {
  readonly worker: WorkerModelCatalog["worker"];
  readonly modelCount: number;
  readonly source: WorkerModelCatalog["source"];
  readonly error?: string;
  readonly sample: readonly string[];
  readonly preference?: WorkflowModelPreferencePin;
}

export interface WorkflowModelOffer {
  readonly snapshotPresent: boolean;
  readonly preferencesPath: string;
  readonly notes?: string;
  readonly workers: readonly WorkerModelOffer[];
}

export const buildWorkflowModelOffer = (input: {
  readonly catalogs: readonly WorkerModelCatalog[];
  readonly preferences: WorkflowModelPreferences;
  readonly preferencesPath: string;
  readonly snapshotPresent: boolean;
  readonly sampleLimit?: number;
}): WorkflowModelOffer => {
  const byWorker = new Map(input.preferences.workers.map((pin) => [pin.worker, pin]));
  return {
    snapshotPresent: input.snapshotPresent,
    preferencesPath: input.preferencesPath,
    ...(input.preferences.notes !== undefined ? { notes: input.preferences.notes } : {}),
    workers: input.catalogs.map((entry) => {
      const preference = byWorker.get(entry.worker);
      return {
        worker: entry.worker,
        modelCount: entry.modelCount,
        source: entry.source,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
        sample: sampleWorkerSlugs(entry, input.sampleLimit ?? 5),
        ...(preference !== undefined ? { preference } : {}),
      };
    }),
  };
};

const formatPreference = (pin: WorkflowModelPreferencePin): string => {
  const parts: string[] = [];
  if (pin.model !== undefined) parts.push(`model ${pin.model}`);
  if (pin.catalogModel !== undefined) parts.push(`catalogModel ${pin.catalogModel}`);
  if (pin.effort !== undefined) parts.push(`effort ${pin.effort}`);
  return parts.length > 0 ? parts.join(", ") : "harness default (no pin)";
};

export const renderWorkflowModelOfferHuman = (offer: WorkflowModelOffer): string => {
  if (!offer.snapshotPresent) {
    return [
      "No harness model snapshot yet.",
      "Discover live slugs: `prism workflow refresh-harness-types`",
      "Then: `prism workflow models --offer`",
    ].join("\n");
  }
  const lines: string[] = [
    "Workflow model offer — quiz the user; do not invent slugs.",
    "Unpinned workers omit the harness --model flag (user's harness default).",
    `Preferences: ${offer.preferencesPath}`,
  ];
  if (offer.notes !== undefined) lines.push(`Notes: ${offer.notes}`);
  lines.push("");
  for (const entry of offer.workers) {
    const pref = entry.preference !== undefined
      ? `  preferred: ${formatPreference(entry.preference)}`
      : "  preferred: (none — omit worker.model)";
    lines.push(`${entry.worker}  ${entry.modelCount} slug${entry.modelCount === 1 ? "" : "s"}  (${entry.source})`);
    if (entry.error !== undefined) lines.push(`  ${entry.error}`);
    lines.push(pref);
    if (entry.sample.length > 0) {
      lines.push(`  sample: ${entry.sample.join(" | ")}`);
    }
    lines.push("");
  }
  lines.push("Save: `prism workflow models prefer cursor --model <slug>`");
  lines.push("Amp: `--catalog-model` and `--effort`. Clear: `--clear`. Notes: `--notes`.");
  lines.push("Skill: `prism workflow skill --models`");
  return lines.join("\n");
};
