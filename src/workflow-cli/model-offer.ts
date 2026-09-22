/**
 * Agent-facing offer: workers, slug counts, a sample of slugs.
 *
 * This is raw combination discovery, not a preference quiz: the offer exists so
 * an authoring agent can compose an explicit `worker: { worker, model, ... }`
 * pin (or pick an installed named worker instead). Nothing is saved and nothing
 * is applied at run time.
 */

import type { WorkerModelCatalog, WorkerModelSample } from "../workflow-models.js";
import { sampleWorkerModels } from "../workflow-models.js";

export interface WorkerModelOffer {
  readonly worker: WorkerModelCatalog["worker"];
  readonly modelCount: number;
  readonly source: WorkerModelCatalog["source"];
  readonly error?: string;
  readonly sample: readonly WorkerModelSample[];
}

export interface WorkflowModelOffer {
  readonly snapshotPresent: boolean;
  readonly workers: readonly WorkerModelOffer[];
}

export const buildWorkflowModelOffer = (input: {
  readonly catalogs: readonly WorkerModelCatalog[];
  readonly snapshotPresent: boolean;
  readonly sampleLimit?: number;
}): WorkflowModelOffer => ({
  snapshotPresent: input.snapshotPresent,
  workers: input.catalogs.map((entry) => ({
    worker: entry.worker,
    modelCount: entry.modelCount,
    source: entry.source,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    sample: sampleWorkerModels(entry, input.sampleLimit ?? 5),
  })),
});

const formatSample = (sample: WorkerModelSample): string => {
  if (sample.pin === "catalogModel") return `${sample.slug} [--catalog-model]`;
  if (sample.kind === "dial") return `${sample.slug} [--model dial]`;
  if (sample.kind === "plugin-mode") return `${sample.slug} [--model plugin]`;
  return sample.slug;
};

export const renderWorkflowModelOfferHuman = (offer: WorkflowModelOffer): string => {
  const lines: string[] = [
    "Workflow model offer — raw combination discovery; do not invent slugs.",
    "Combine what you need explicitly into `worker: { worker, model, ... }`, or pick an installed named worker instead (`prism workflow workers`).",
  ];
  if (!offer.snapshotPresent) {
    lines.push("No harness model snapshot yet. Discover live slugs: `prism workflow refresh-harness-types`");
  }
  lines.push("");
  for (const entry of offer.workers) {
    lines.push(`${entry.worker}  ${entry.modelCount} slug${entry.modelCount === 1 ? "" : "s"}  (${entry.source})`);
    if (entry.error !== undefined) lines.push(`  ${entry.error}`);
    if (entry.sample.length > 0) {
      lines.push(`  sample: ${entry.sample.map(formatSample).join(" | ")}`);
    }
    lines.push("");
  }
  lines.push("Copy a slug you actually saw into `worker.model` (Amp catalog slugs: `worker.catalogModel`). Omit the field for the harness default.");
  lines.push("More slugs: `prism workflow models --worker <id> --query <text>`");
  return lines.join("\n");
};
