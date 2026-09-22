/**
 * Global (machine-wide) harness model types for plugin-free workflow authoring.
 *
 * Written by `prism workflow refresh-harness-types` to
 * `<PRISM_HOME>/state/harness-types/`. Not project-keyed — harnesses are
 * installed on the machine, not per repo.
 */

import { LOWERER_CAPABILITIES, workflowWorkerHarnessIds } from "./lowerer-capabilities.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prismStateDir } from "./prism-home.js";
import type { WorkflowWorkerId } from "./workflows.js";

export const HARNESS_TYPES_DIRNAME = "harness-types";
export const HARNESS_MODELS_FILENAME = "harness-models.ts";
export const HARNESS_DISCOVERED_FILENAME = "discovered.json";

export const harnessTypesDir = (prismHome: string): string =>
  join(prismStateDir(prismHome), HARNESS_TYPES_DIRNAME);

export const harnessModelsModulePath = (prismHome: string): string =>
  join(harnessTypesDir(prismHome), HARNESS_MODELS_FILENAME);

export const harnessDiscoveredPath = (prismHome: string): string =>
  join(harnessTypesDir(prismHome), HARNESS_DISCOVERED_FILENAME);

export const harnessTypesExist = (prismHome: string): boolean =>
  existsSync(harnessModelsModulePath(prismHome));

export type HarnessModelSource = "cache" | "aliases" | "command" | "static" | "empty";

export interface HarnessModelOption {
  readonly id: string;
  readonly label?: string;
  readonly efforts?: readonly string[];
  readonly provider?: string;
  /** Amp: dial / plugin-mode / curated model. Other harnesses omit this. */
  readonly kind?: "dial" | "plugin-mode" | "model";
}

export interface DiscoveredHarnessModels {
  readonly harness: WorkflowWorkerId;
  readonly models: readonly HarnessModelOption[];
  readonly source: HarnessModelSource;
  readonly error?: string;
}

export interface HarnessTypesSnapshot {
  readonly generatedAt: string;
  readonly harnesses: readonly DiscoveredHarnessModels[];
}

export interface RefreshHarnessTypesResult {
  readonly modelsPath: string;
  readonly discoveredPath: string;
  readonly snapshot: HarnessTypesSnapshot;
}

const CAMEL_BY_HARNESS: Readonly<Record<WorkflowWorkerId, string>> = {
  "amp-code": "ampCode",
  "antigravity-cli": "antigravity",
  "claude-code": "claudeCode",
  "codex-cli": "codex",
  cursor: "cursor",
  devin: "devin",
  grok: "grok",
  hermes: "hermes",
  "kimi-code": "kimiCode",
  opencode: "openCode",
  omp: "omp",
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values.filter((value) => value.length > 0))].sort((left, right) => left.localeCompare(right));

const constArray = (name: string, values: readonly string[]): string =>
  `export const ${name} = ${JSON.stringify(values, null, 2)} as const;`;

const unionType = (name: string, arrayName: string): string =>
  `export type ${name} = (typeof ${arrayName})[number];`;

const stringUnion = (values: readonly string[]): string =>
  values.map((value) => JSON.stringify(value)).join(" | ");

const workerFacingModels = (
  harness: WorkflowWorkerId,
  models: readonly HarnessModelOption[],
): readonly HarnessModelOption[] =>
  harness === "amp-code" ? models.filter((model) => model.kind !== "model") : models;

const catalogModels = (
  harness: WorkflowWorkerId,
  models: readonly HarnessModelOption[],
): readonly HarnessModelOption[] =>
  harness === "amp-code" ? models.filter((model) => model.kind === "model") : [];

const emitHarnessBlock = (
  harness: WorkflowWorkerId,
  models: readonly HarnessModelOption[],
): {
  readonly constName?: string;
  readonly unionLiteral?: string;
  readonly catalogUnionLiteral?: string;
  readonly effortUnionLiteral?: string;
  readonly source: string;
} | undefined => {
  const slugs = uniqueSorted(workerFacingModels(harness, models).map((model) => model.id));
  const catalogSlugs = uniqueSorted(catalogModels(harness, models).map((model) => model.id));
  const effortCapability = LOWERER_CAPABILITIES[harness].workflowEffort;
  const efforts = effortCapability?.kind === "catalog"
    ? uniqueSorted(models.flatMap((model) => [...(model.efforts ?? [])]))
    : [];
  if (slugs.length === 0 && catalogSlugs.length === 0) return undefined;
  const camel = CAMEL_BY_HARNESS[harness];
  const constName = `${camel}ModelSlugs`;
  const typeName = `${camel[0]!.toUpperCase()}${camel.slice(1)}ModelSlug`;
  const parts: string[] = [];
  if (slugs.length > 0) {
    parts.push(`${constArray(constName, slugs)}\n${unionType(typeName, constName)}`);
  }
  if (catalogSlugs.length > 0) {
    const catalogConst = `${camel}CatalogSlugs`;
    const catalogType = `${camel[0]!.toUpperCase()}${camel.slice(1)}CatalogSlug`;
    parts.push(`${constArray(catalogConst, catalogSlugs)}\n${unionType(catalogType, catalogConst)}`);
  }
  if (efforts.length > 0) {
    const effortConst = `${camel}Efforts`;
    const effortType = `${camel[0]!.toUpperCase()}${camel.slice(1)}Effort`;
    parts.push(`${constArray(effortConst, efforts)}\n${unionType(effortType, effortConst)}`);
  }
  return {
    ...(slugs.length > 0 ? { constName, unionLiteral: stringUnion(slugs) } : {}),
    ...(catalogSlugs.length > 0 ? { catalogUnionLiteral: stringUnion(catalogSlugs) } : {}),
    ...(efforts.length > 0 ? { effortUnionLiteral: stringUnion(efforts) } : {}),
    source: `${parts.join("\n")}\n`,
  };
};

/**
 * Render the generated `prism/harnesses` module. A worker appears only
 * when discovery returned at least one model id.
 */
export const renderHarnessModelsModule = (snapshot: HarnessTypesSnapshot): string => {
  const byHarness = new Map<WorkflowWorkerId, DiscoveredHarnessModels>();
  for (const entry of snapshot.harnesses) {
    byHarness.set(entry.harness, entry);
  }

  const blocks: string[] = [];
  const augmentLines: string[] = [];
  const catalogAugmentLines: string[] = [];
  const effortAugmentLines: string[] = [];
  const mapLines: string[] = [];

  const harnessOrder: readonly WorkflowWorkerId[] = workflowWorkerHarnessIds();

  for (const harness of harnessOrder) {
    const entry = byHarness.get(harness);
    if (entry === undefined) continue;
    const block = emitHarnessBlock(harness, entry.models);
    if (block === undefined) continue;
    blocks.push(block.source);
    if (block.unionLiteral !== undefined && block.constName !== undefined) {
      augmentLines.push(`    ${JSON.stringify(harness)}: ${block.unionLiteral};`);
      mapLines.push(`  ${JSON.stringify(harness)}: ${block.constName},`);
    }
    if (block.catalogUnionLiteral !== undefined) {
      catalogAugmentLines.push(`    ${JSON.stringify(harness)}: ${block.catalogUnionLiteral};`);
    }
    if (block.effortUnionLiteral !== undefined) {
      effortAugmentLines.push(`    ${JSON.stringify(harness)}: ${block.effortUnionLiteral};`);
    }
  }

  const catalogAugment = catalogAugmentLines.length > 0
    ? `\n  interface WorkflowHarnessCatalogModelMap {\n${catalogAugmentLines.join("\n")}\n  }`
    : "";
  const effortAugment = effortAugmentLines.length > 0
    ? `\n  interface WorkflowHarnessEffortMap {\n${effortAugmentLines.join("\n")}\n  }`
    : "";

  return `/**
 * Generated by Prism. Do not edit.
 * Source: harness-types refresh ${snapshot.generatedAt}
 *
 * Import as \`prism/harnesses\`. Also augments \`WorkflowHarnessModelMap\`
 * on \`prism\` so \`defineTask({ worker: { worker, model } })\` is typed
 * per harness without a compiled plugin. Catalog-backed effort values
 * narrow \`worker.effort\`; fixed CLI effort sets come from Prism's capability
 * registry. Amp catalog slugs narrow \`worker.catalogModel\`.
 * Omit \`worker.model\` to keep the harness default. Pin only from
 * \`prism workflow models --offer\` / stated preferences.
 */

import "prism";

${blocks.join("\n")}
export const harnessModels = {
${mapLines.join("\n")}
} as const;

declare module "prism" {
  interface WorkflowHarnessModelMap {
${augmentLines.join("\n")}
  }${catalogAugment}${effortAugment}
}
`;
};

export const writeHarnessTypesSnapshot = (
  prismHome: string,
  snapshot: HarnessTypesSnapshot,
): RefreshHarnessTypesResult => {
  const dir = harnessTypesDir(prismHome);
  mkdirSync(dir, { recursive: true });
  const modelsPath = harnessModelsModulePath(prismHome);
  const discoveredPath = harnessDiscoveredPath(prismHome);
  writeFileSync(discoveredPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  writeFileSync(modelsPath, renderHarnessModelsModule(snapshot), "utf8");
  return { modelsPath, discoveredPath, snapshot };
};
