/**
 * User-stated workflow model preferences. Plugin-free, machine-wide.
 * Agents quiz the user and write this file; spawn never invents a model from it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
import { AMP_WORKFLOW_DIAL_MODES } from "../workflow-amp-worker.js";
import type { WorkflowWorkerId } from "../workflows.js";
import { parseWorkflowWorkerId } from "../workflow-models.js";
import { prismWorkflowModelPreferencesPath } from "./paths.js";

export const WORKFLOW_MODEL_PREFERENCES_SCHEMA_VERSION = 1 as const;

const WorkerPinSchema = Schema.Struct({
  worker: Schema.String,
  model: Schema.optional(Schema.String),
  catalogModel: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
});

const RawPreferencesSchema = Schema.Struct({
  version: Schema.optional(Schema.Literal(WORKFLOW_MODEL_PREFERENCES_SCHEMA_VERSION)),
  updatedAt: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  workers: Schema.optional(Schema.Array(WorkerPinSchema)),
});

export interface WorkflowModelPreferencePin {
  readonly worker: WorkflowWorkerId;
  readonly model?: string;
  readonly catalogModel?: string;
  readonly effort?: string;
}

export interface WorkflowModelPreferences {
  readonly version: typeof WORKFLOW_MODEL_PREFERENCES_SCHEMA_VERSION;
  readonly updatedAt?: string;
  readonly notes?: string;
  readonly workers: readonly WorkflowModelPreferencePin[];
}

const emptyPreferences = (): WorkflowModelPreferences => ({
  version: WORKFLOW_MODEL_PREFERENCES_SCHEMA_VERSION,
  workers: [],
});

const AMP_DIAL_SET = new Set<string>(AMP_WORKFLOW_DIAL_MODES);

const pinFromRaw = (raw: typeof WorkerPinSchema.Type): WorkflowModelPreferencePin => {
  const worker = parseWorkflowWorkerId(raw.worker);
  const model = raw.model?.trim();
  const catalogModel = raw.catalogModel?.trim();
  const effort = raw.effort?.trim();
  if (worker !== "amp-code") {
    if (catalogModel !== undefined && catalogModel.length > 0) {
      throw new Error(`catalogModel is Amp-only. Worker ${JSON.stringify(worker)} takes --model.`);
    }
    if (effort !== undefined && effort.length > 0) {
      throw new Error(`effort is Amp-only. Worker ${JSON.stringify(worker)} takes --model.`);
    }
  } else if (catalogModel !== undefined && catalogModel.length > 0 && AMP_DIAL_SET.has(catalogModel)) {
    throw new Error(
      `Amp dial ${JSON.stringify(catalogModel)} is worker.model / --model, not --catalog-model. Fix: prism workflow models prefer amp-code --model ${catalogModel}`,
    );
  }
  return {
    worker,
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    ...(catalogModel !== undefined && catalogModel.length > 0 ? { catalogModel } : {}),
    ...(effort !== undefined && effort.length > 0 ? { effort } : {}),
  };
};

export const decodeWorkflowModelPreferences = (value: unknown): WorkflowModelPreferences => {
  const raw = Schema.decodeUnknownSync(RawPreferencesSchema)(value);
  const seen = new Set<WorkflowWorkerId>();
  const workers: WorkflowModelPreferencePin[] = [];
  for (const entry of raw.workers ?? []) {
    const pin = pinFromRaw(entry);
    if (seen.has(pin.worker)) {
      throw new Error(`Duplicate preference for worker ${JSON.stringify(pin.worker)}.`);
    }
    seen.add(pin.worker);
    workers.push(pin);
  }
  const notes = raw.notes?.trim();
  return {
    version: WORKFLOW_MODEL_PREFERENCES_SCHEMA_VERSION,
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    workers,
  };
};

export const loadWorkflowModelPreferences = (prismHome: string): WorkflowModelPreferences => {
  const path = prismWorkflowModelPreferencesPath(prismHome);
  if (!existsSync(path)) return emptyPreferences();
  try {
    return decodeWorkflowModelPreferences(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow model preferences at ${path} are invalid: ${message}`);
  }
};

export const writeWorkflowModelPreferences = (
  prismHome: string,
  preferences: WorkflowModelPreferences,
): { readonly path: string } => {
  const decoded = decodeWorkflowModelPreferences(preferences);
  const path = prismWorkflowModelPreferencesPath(prismHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: WORKFLOW_MODEL_PREFERENCES_SCHEMA_VERSION,
    updatedAt: decoded.updatedAt ?? new Date().toISOString(),
    ...(decoded.notes !== undefined ? { notes: decoded.notes } : {}),
    workers: decoded.workers,
  }, null, 2)}\n`, "utf8");
  return { path };
};

export const upsertWorkflowModelPreference = (
  current: WorkflowModelPreferences,
  pin: WorkflowModelPreferencePin,
): WorkflowModelPreferences => ({
  ...current,
  workers: [...current.workers.filter((entry) => entry.worker !== pin.worker), pin]
    .sort((left, right) => left.worker.localeCompare(right.worker)),
});

export const clearWorkflowModelPreference = (
  current: WorkflowModelPreferences,
  worker: WorkflowWorkerId,
): WorkflowModelPreferences => ({
  ...current,
  workers: current.workers.filter((entry) => entry.worker !== worker),
});

export const preferenceScaffoldPins = (
  preferences: WorkflowModelPreferences,
): readonly WorkflowModelPreferencePin[] => preferences.workers;
