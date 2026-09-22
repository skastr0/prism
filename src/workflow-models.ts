/**
 * Plugin-free harness model catalog. Reads the global snapshot from
 * `prism workflow refresh-harness-types`. Plugins are optional.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  harnessDiscoveredPath,
  type DiscoveredHarnessModels,
  type HarnessModelOption,
  type HarnessTypesSnapshot,
} from "./harness-types.js";
import { resolvePrismHome } from "./prism-home.js";
import { WORKFLOW_WORKERS } from "./workflow-catalog.js";
import type { WorkflowWorkerId } from "./workflows.js";

const VARIANT_SUFFIX = /-(?:thinking-)?(?:none|minimal|low|medium|high|xhigh|max)(?:-fast)?$/u;
const FAST_SUFFIX = /-fast$/u;

export const loadHarnessTypesSnapshot = (prismHome: string): HarnessTypesSnapshot | undefined => {
  const path = harnessDiscoveredPath(prismHome);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HarnessTypesSnapshot;
    if (!parsed || !Array.isArray(parsed.harnesses)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

export const modelFamilyId = (id: string): string => {
  let family = id.trim();
  if (FAST_SUFFIX.test(family) && !VARIANT_SUFFIX.test(family)) {
    family = family.replace(FAST_SUFFIX, "");
  }
  family = family.replace(VARIANT_SUFFIX, "");
  return family.length > 0 ? family : id;
};

export interface HarnessModelFamily {
  readonly family: string;
  readonly slugs: readonly string[];
  readonly kind?: HarnessModelOption["kind"];
  readonly label?: string;
}

export interface WorkerModelCatalog {
  readonly worker: WorkflowWorkerId;
  readonly source: DiscoveredHarnessModels["source"];
  readonly error?: string;
  readonly families: readonly HarnessModelFamily[];
  readonly modelCount: number;
}

const groupFamilies = (models: readonly HarnessModelOption[]): HarnessModelFamily[] => {
  const byFamily = new Map<string, { slugs: string[]; kind?: HarnessModelOption["kind"]; label?: string }>();
  for (const model of models) {
    const family = modelFamilyId(model.id);
    const entry = byFamily.get(family) ?? { slugs: [] };
    if (!entry.slugs.includes(model.id)) entry.slugs.push(model.id);
    if (model.kind !== undefined) entry.kind = model.kind;
    if (model.label !== undefined && family === model.id) entry.label = model.label;
    byFamily.set(family, entry);
  }
  return [...byFamily.entries()]
    .map(([family, entry]) => ({
      family,
      slugs: [...entry.slugs].sort((left, right) => left.localeCompare(right)),
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
    }))
    .sort((left, right) => left.family.localeCompare(right.family));
};

export const projectWorkerModelCatalog = (
  snapshot: HarnessTypesSnapshot | undefined,
): readonly WorkerModelCatalog[] => {
  const byWorker = new Map<WorkflowWorkerId, DiscoveredHarnessModels>();
  for (const entry of snapshot?.harnesses ?? []) {
    byWorker.set(entry.harness, entry);
  }
  return WORKFLOW_WORKERS.map((worker) => {
    const entry = byWorker.get(worker);
    const models = entry?.models ?? [];
    return {
      worker,
      source: entry?.source ?? "empty",
      ...(entry?.error !== undefined ? { error: entry.error } : {}),
      families: groupFamilies(models),
      modelCount: models.length,
    };
  });
};

const matchesQuery = (text: string, query: string): boolean =>
  text.toLowerCase().includes(query.toLowerCase());

export const filterWorkerModelCatalog = (
  catalogs: readonly WorkerModelCatalog[],
  options: { readonly worker?: string; readonly query?: string } = {},
): readonly WorkerModelCatalog[] => {
  const workerFilter = options.worker;
  const query = options.query?.trim();
  return catalogs
    .filter((entry) => workerFilter === undefined || entry.worker === workerFilter)
    .map((entry) => {
      if (query === undefined || query.length === 0) return entry;
      const families = entry.families.filter((family) =>
        matchesQuery(family.family, query) || family.slugs.some((slug) => matchesQuery(slug, query)),
      );
      return { ...entry, families, modelCount: families.reduce((sum, family) => sum + family.slugs.length, 0) };
    })
    .filter((entry) => workerFilter !== undefined || query === undefined || entry.families.length > 0);
};

export const suggestHarnessSlugs = (
  catalogs: readonly WorkerModelCatalog[],
  worker: string,
  attempted: string,
): readonly string[] => {
  const entry = catalogs.find((catalog) => catalog.worker === worker);
  if (entry === undefined) return [];
  const family = modelFamilyId(attempted);
  const exactFamily = entry.families.find((item) => item.family === family || item.slugs.includes(attempted));
  if (exactFamily !== undefined) return exactFamily.slugs;
  const needle = attempted.toLowerCase();
  return entry.families
    .filter((item) => item.family.toLowerCase().includes(needle) || item.slugs.some((slug) => slug.toLowerCase().includes(needle)))
    .flatMap((item) => item.slugs)
    .slice(0, 8);
};

export const parseWorkflowWorkerId = (value: string): WorkflowWorkerId => {
  if ((WORKFLOW_WORKERS as readonly string[]).includes(value)) {
    return value as WorkflowWorkerId;
  }
  throw new Error(
    [
      `Unknown worker ${JSON.stringify(value)}.`,
      `Known workers: ${WORKFLOW_WORKERS.join(", ")}`,
      `Fix: prism workflow models --worker cursor --query opus`,
    ].join("\n"),
  );
};

export const renderWorkerModelCountsHuman = (catalogs: readonly WorkerModelCatalog[]): string => {
  const lines = ["Installed harness slugs:"];
  for (const entry of catalogs) {
    const error = entry.error !== undefined ? `  ${entry.error}` : "";
    lines.push(`  ${entry.worker}  ${entry.modelCount}  (${entry.source})${error}`);
  }
  lines.push("");
  lines.push("List slugs: `prism workflow models --worker cursor --query opus`");
  return lines.join("\n");
};

export const renderWorkerModelCatalogHuman = (
  catalogs: readonly WorkerModelCatalog[],
  options: { readonly query?: string; readonly missingSnapshot?: boolean } = {},
): string => {
  if (options.missingSnapshot === true) {
    return [
      "No harness model snapshot yet.",
      "Discover live slugs: `prism workflow refresh-harness-types`",
      "Then: `prism workflow models --worker cursor --query opus`",
    ].join("\n");
  }
  if (catalogs.length === 0) {
    const query = options.query?.trim();
    return [
      query !== undefined && query.length > 0
        ? `No harness models matching ${JSON.stringify(query)}.`
        : "No harness models in the snapshot.",
      "Refresh: `prism workflow refresh-harness-types`",
      "List all: `prism workflow models`",
    ].join("\n");
  }
  const lines: string[] = [];
  if (options.query !== undefined && options.query.trim().length > 0) {
    lines.push(`Harness models matching "${options.query}":`);
  } else {
    lines.push("Harness models (plugin-free — `worker.model` / Amp `catalogModel`):");
  }
  lines.push("");
  for (const entry of catalogs) {
    const kindNote = entry.worker === "amp-code" ? "  (--mode dial/plugin keys; catalog slugs are worker.catalogModel)" : "";
    lines.push(`${entry.worker}  ${entry.modelCount} slug${entry.modelCount === 1 ? "" : "s"}  (${entry.source})${kindNote}`);
    if (entry.error !== undefined) lines.push(`  ${entry.error}`);
    for (const family of entry.families) {
      if (family.slugs.length === 1 && family.slugs[0] === family.family) {
        lines.push(`  ${family.family}${family.kind !== undefined ? `  [${family.kind}]` : ""}`);
        continue;
      }
      lines.push(`  ${family.family}`);
      for (const slug of family.slugs) {
        lines.push(`    ${slug}`);
      }
    }
    lines.push("");
  }
  if (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
};

export interface WorkerModelSample {
  readonly slug: string;
  readonly pin: "model" | "catalogModel";
  readonly kind?: "dial" | "plugin-mode" | "model";
}

const ampSampleKind = (
  family: HarnessModelFamily,
  slug: string,
): NonNullable<WorkerModelSample["kind"]> => {
  if (family.kind === "dial" || family.kind === "plugin-mode" || family.kind === "model") return family.kind;
  if (slug.includes("/")) return "model";
  if (slug === "low" || slug === "medium" || slug === "high" || slug === "ultra") return "dial";
  return "plugin-mode";
};

export const sampleWorkerModels = (
  entry: WorkerModelCatalog,
  limit = 5,
): readonly WorkerModelSample[] => {
  if (limit <= 0) return [];
  if (entry.worker === "amp-code") {
    const dials: WorkerModelSample[] = [];
    const plugins: WorkerModelSample[] = [];
    const catalog: WorkerModelSample[] = [];
    for (const family of entry.families) {
      for (const slug of family.slugs) {
        const kind = ampSampleKind(family, slug);
        const sample: WorkerModelSample = {
          slug,
          pin: kind === "model" ? "catalogModel" : "model",
          kind,
        };
        if (kind === "dial") dials.push(sample);
        else if (kind === "plugin-mode") plugins.push(sample);
        else catalog.push(sample);
      }
    }
    const ordered = [...dials, ...plugins, ...catalog];
    const unique: WorkerModelSample[] = [];
    for (const sample of ordered) {
      if (unique.some((item) => item.slug === sample.slug && item.pin === sample.pin)) continue;
      unique.push(sample);
      if (unique.length >= limit) break;
    }
    return unique;
  }
  const samples: WorkerModelSample[] = [];
  for (const family of entry.families) {
    const slug = family.slugs.find((item) => item === family.family) ?? family.slugs[0];
    if (slug === undefined || samples.some((item) => item.slug === slug)) continue;
    samples.push({ slug, pin: "model" });
    if (samples.length >= limit) break;
  }
  return samples;
};

export const pickPluginFreeScaffoldPins = (
  snapshot: HarnessTypesSnapshot | undefined,
): readonly [ScaffoldWorkerPin] | readonly [ScaffoldWorkerPin, ScaffoldWorkerPin] => {
  const catalogs = projectWorkerModelCatalog(snapshot);
  const withModels = new Set(
    catalogs.filter((entry) => entry.modelCount > 0).map((entry) => entry.worker),
  );
  const ordered = [
    ...SCAFFOLD_WORKER_PREFERENCE.filter((worker) => withModels.has(worker)),
    ...catalogs
      .map((entry) => entry.worker)
      .filter((worker) => withModels.has(worker) && !SCAFFOLD_WORKER_PREFERENCE.includes(worker)),
  ];
  const unique = [...new Set(ordered)];
  if (unique.length >= 2) return [{ worker: unique[0]! }, { worker: unique[1]! }];
  if (unique.length === 1) return [{ worker: unique[0]! }];
  return [{ worker: "claude-code" }];
};

export interface ScaffoldWorkerPin {
  readonly worker: WorkflowWorkerId;
  readonly model?: string;
  readonly catalogModel?: string;
  readonly effort?: string;
}

const SCAFFOLD_WORKER_PREFERENCE: readonly WorkflowWorkerId[] = [
  "cursor",
  "amp-code",
  "claude-code",
  "codex-cli",
  "opencode2",
];

export const enrichHarnessModelTypeError = (
  message: string,
  source: string,
  catalogs: readonly WorkerModelCatalog[],
): string => {
  const attempted = /Type '"([^"]+)"' is not assignable to type 'WorkflowHarnessModel/u.exec(message)?.[1];
  if (attempted === undefined) return message;
  const escaped = attempted.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const nearby = new RegExp(
    String.raw`worker:\s*"([^"]+)"[\s\S]{0,120}${escaped}|${escaped}[\s\S]{0,120}worker:\s*"([^"]+)"`,
    "u",
  ).exec(source);
  const worker = nearby?.[1] ?? nearby?.[2];
  const suggestions = worker === undefined
    ? catalogs.flatMap((entry) => suggestHarnessSlugs([entry], entry.worker, attempted)).slice(0, 8)
    : suggestHarnessSlugs(catalogs, worker, attempted);
  const query = modelFamilyId(attempted);
  const hint = suggestions.length > 0
    ? `Did you mean: ${suggestions.join(" | ")}`
    : `No family match. List slugs: \`prism workflow models${worker !== undefined ? ` --worker ${worker}` : ""} --query ${query}\``;
  return [
    message,
    hint,
    worker !== undefined
      ? `Fix: set worker.model to one of the effort-suffixed slugs. Query: \`prism workflow models --worker ${worker} --query ${query}\``
      : `Fix: \`prism workflow models --query ${query}\``,
  ].join("\n");
};

export const buildWorkflowModelCatalog = (
  options: { readonly prismHome?: string; readonly worker?: string; readonly query?: string } = {},
): {
  readonly snapshotPresent: boolean;
  readonly catalogs: readonly WorkerModelCatalog[];
} => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const snapshot = loadHarnessTypesSnapshot(prismHome);
  const catalogs = filterWorkerModelCatalog(projectWorkerModelCatalog(snapshot), {
    worker: options.worker,
    query: options.query,
  });
  return { snapshotPresent: snapshot !== undefined, catalogs };
};
