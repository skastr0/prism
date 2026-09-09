/**
 * Global (machine-wide) harness model types for plugin-free workflow authoring.
 *
 * Written by `prism workflow refresh-harness-types` to
 * `<PRISM_HOME>/state/harness-types/`. Not project-keyed — harnesses are
 * installed on the machine, not per repo.
 */

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

const emitHarnessBlock = (
  harness: WorkflowWorkerId,
  models: readonly HarnessModelOption[],
): { readonly constName: string; readonly unionLiteral: string; readonly source: string } | undefined => {
  const slugs = uniqueSorted(models.map((model) => model.id));
  if (slugs.length === 0) return undefined;
  const camel = CAMEL_BY_HARNESS[harness];
  const constName = `${camel}ModelSlugs`;
  const typeName = `${camel[0]!.toUpperCase()}${camel.slice(1)}ModelSlug`;
  const efforts = uniqueSorted(models.flatMap((model) => [...(model.efforts ?? [])]));
  const effortConst = `${camel}Efforts`;
  const effortType = `${camel[0]!.toUpperCase()}${camel.slice(1)}Effort`;
  const effortBlock =
    efforts.length > 0
      ? `\n${constArray(effortConst, efforts)}\n${unionType(effortType, effortConst)}\n`
      : "\n";
  return {
    constName,
    unionLiteral: stringUnion(slugs),
    source: `${constArray(constName, slugs)}\n${unionType(typeName, constName)}${effortBlock}`,
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
  const mapLines: string[] = [];

  const harnessOrder: readonly WorkflowWorkerId[] = [
    "amp-code",
    "antigravity-cli",
    "claude-code",
    "codex-cli",
    "cursor",
    "devin",
    "grok",
    "hermes",
    "kimi-code",
    "opencode",
    "omp",
  ];

  for (const harness of harnessOrder) {
    const entry = byHarness.get(harness);
    if (entry === undefined) continue;
    const block = emitHarnessBlock(harness, entry.models);
    if (block === undefined) continue;
    blocks.push(block.source);
    augmentLines.push(`    ${JSON.stringify(harness)}: ${block.unionLiteral};`);
    mapLines.push(`  ${JSON.stringify(harness)}: ${block.constName},`);
  }

  return `/**
 * Generated by Prism. Do not edit.
 * Source: harness-types refresh ${snapshot.generatedAt}
 *
 * Import as \`prism/harnesses\`. Also augments \`WorkflowHarnessModelMap\`
 * on \`prism\` so \`defineTask({ worker: { worker, model } })\` is typed
 * per harness without a compiled plugin.
 */

import "prism";

${blocks.join("\n")}
export const harnessModels = {
${mapLines.join("\n")}
} as const;

declare module "prism" {
  interface WorkflowHarnessModelMap {
${augmentLines.join("\n")}
  }
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
