import {
  LOWERER_CAPABILITIES,
  type WorkflowEffortCapabilityFor,
} from "./lowerer-capabilities.js";
import type { HarnessTypesSnapshot } from "./harness-types.js";
import type { HarnessId } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

/**
 * Values available to the authoring and named-worker contracts. Fixed CLI
 * values come from the capability registry; catalog values come only from the
 * installed per-model discovery snapshot.
 */
export const workflowEffortValues = (
  worker: HarnessId,
  snapshot?: HarnessTypesSnapshot,
): readonly string[] | undefined => {
  const capability = LOWERER_CAPABILITIES[worker].workflowEffort;
  if (capability === null) return undefined;
  if (capability.kind === "fixed") return capability.values;
  if (snapshot === undefined) return undefined;
  const entry = snapshot.harnesses.find((harness) => harness.harness === worker);
  return entry === undefined
    ? []
    : uniqueSorted(entry.models.flatMap((model) => [...(model.efforts ?? [])]));
};

const modelEffortRows = (
  worker: HarnessId,
  snapshot: HarnessTypesSnapshot,
) => snapshot.harnesses.find((entry) => entry.harness === worker)?.models ?? [];

/** Validate one effective task effort against the capability and model cache. */
export const validateWorkflowEffort = (input: {
  readonly worker: HarnessId;
  readonly effort?: string;
  readonly model?: string;
  readonly catalogModel?: string;
  readonly snapshot?: HarnessTypesSnapshot;
}): string | undefined => {
  const { worker, effort, model, catalogModel, snapshot } = input;
  if (effort === undefined) return undefined;

  const capability: WorkflowEffortCapabilityFor<typeof worker> = LOWERER_CAPABILITIES[worker].workflowEffort;
  if (capability === null) {
    return [
      `Workflow worker '${worker}' has no per-task effort control.`,
      "Fix: remove the `effort` property from this worker configuration.",
    ].join(" ");
  }

  if (capability.kind === "fixed") {
    if ((capability.values as readonly string[]).includes(effort)) return undefined;
    return [
      `Invalid ${worker} effort ${JSON.stringify(effort)}.`,
      `Supported: ${capability.values.join(", ")}`,
      `Fix: set worker.effort to ${JSON.stringify(capability.values[0])}.`,
    ].join(" ");
  }

  if (snapshot === undefined) {
    return [
      `Cannot validate ${worker} effort without the installed model catalog.`,
      "Fix: run `prism workflow refresh-harness-types` and retry.",
    ].join(" ");
  }

  const rows = modelEffortRows(worker, snapshot);
  const supported = uniqueSorted(rows.flatMap((row) => [...(row.efforts ?? [])]));
  if (supported.length === 0) {
    return [
      `The installed ${worker} catalog has no discovered reasoning-effort values.`,
      "Fix: run `prism workflow refresh-harness-types` after updating the harness catalog.",
    ].join(" ");
  }
  if (!supported.includes(effort)) {
    return [
      `Invalid ${worker} effort ${JSON.stringify(effort)}.`,
      `Supported by discovered models: ${supported.join(", ")}`,
      `Fix: set worker.effort to ${JSON.stringify(supported[0])}.`,
    ].join(" ");
  }

  const selectedModel = worker === "amp-code" ? catalogModel ?? model : model;
  const row = selectedModel === undefined ? undefined : rows.find((candidate) => candidate.id === selectedModel);
  if (selectedModel !== undefined && row === undefined) {
    return [
      `Unknown ${worker} model ${JSON.stringify(selectedModel)} in the installed effort catalog.`,
      "Fix: run `prism workflow refresh-harness-types` and select a discovered model.",
    ].join(" ");
  }
  if (row !== undefined && !(row.efforts ?? []).includes(effort)) {
    const rowEfforts = uniqueSorted(row.efforts ?? []);
    const fix = rowEfforts.length > 0
      ? `set worker.effort to ${JSON.stringify(rowEfforts[0])}`
      : "remove the worker.effort property or select a discovered model with effort values";
    return [
      `${worker} model ${JSON.stringify(selectedModel)} does not list effort ${JSON.stringify(effort)}.`,
      `Supported for this model: ${rowEfforts.length > 0 ? rowEfforts.join(", ") : "none discovered"}`,
      `Fix: ${fix}.`,
    ].join(" ");
  }
  return undefined;
};

/** Exact one-line migration diagnostic for legacy Codex/OMP modelspace entries. */
export const legacyReasoningVariantError = (
  worker: string,
  target: unknown,
  location: string,
): string | undefined => {
  if (worker !== "codex-cli" && worker !== "omp") return undefined;
  if (!isRecord(target)) return undefined;

  const describe = (record: Record<string, unknown>, suffix: string): string | undefined => {
    if (!Object.hasOwn(record, "variant")) return undefined;
    const value = JSON.stringify(record.variant) ?? "undefined";
    return [
      `${worker} modelspace reasoning uses 'effort', not 'variant', at ${location}${suffix}.`,
      `Fix: replace \`variant: ${value}\` with \`effort: ${value}\` at ${location}${suffix}.`,
    ].join(" ");
  };

  const direct = describe(target, "");
  if (direct !== undefined) return direct;
  if (!Array.isArray(target.models)) return undefined;
  for (const [index, model] of target.models.entries()) {
    if (!isRecord(model)) continue;
    const nested = describe(model, `.models[${index}]`);
    if (nested !== undefined) return nested;
  }
  return undefined;
};
