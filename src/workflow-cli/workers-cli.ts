/**
 * CLI glue for the machine-global installed named-worker catalog.
 *
 * The core module (`workflow-named-workers.ts`) owns installed truth: the
 * portable JSON contract, the catalog file, and the generated
 * `prism/refs/workers` module. Everything here only composes that truth into
 * printable command output, so the CLI stays a thin boundary over Effect.
 */

import { Effect } from "effect";
import {
  installWorkflowWorkerCatalog,
  loadWorkflowWorkerCatalog,
  namedWorkerRef,
  renderWorkflowWorkersHuman,
  workflowWorkerCatalogPath,
  workflowWorkersModulePath,
  type WorkflowWorkerCatalogError,
  type NamedWorkflowWorker,
  type WorkflowWorkerCatalog,
} from "../workflow-named-workers.js";

/** Portable JSON for `workers export` — identical shape to an install source. */
export const renderWorkflowWorkersJson = (catalog: WorkflowWorkerCatalog): string =>
  `${JSON.stringify(catalog, null, 2)}\n`;

/** One catalog entry with its generated ref, for `skill --json` and listings. */
export interface NamedWorkerRefEntry {
  readonly name: string;
  readonly ref: string;
  readonly description: string;
  readonly config: NamedWorkflowWorker["config"];
}

export const projectNamedWorkerRefs = (catalog: WorkflowWorkerCatalog): readonly NamedWorkerRefEntry[] =>
  catalog.workers.map((worker) => ({
    name: worker.name,
    ref: namedWorkerRef(worker.name),
    description: worker.description,
    config: worker.config,
  }));

export interface WorkflowWorkersListResult {
  readonly catalog: WorkflowWorkerCatalog;
  readonly catalogPath: string;
  readonly modulePath: string;
  readonly human: string;
  readonly json: string;
}

/** `prism workflow workers` — print the installed catalog, never write. */
export const listWorkflowWorkers = (prismHome: string): Effect.Effect<WorkflowWorkersListResult, WorkflowWorkerCatalogError> =>
  Effect.gen(function* () {
    const catalog = yield* loadWorkflowWorkerCatalog(prismHome);
    return {
      catalog,
      catalogPath: workflowWorkerCatalogPath(prismHome),
      modulePath: workflowWorkersModulePath(prismHome),
      human: renderWorkflowWorkersHuman(catalog),
      json: renderWorkflowWorkersJson(catalog),
    };
  });

export interface WorkflowWorkersInstallResult {
  readonly catalog: WorkflowWorkerCatalog;
  readonly catalogPath: string;
  readonly modulePath: string;
  readonly human: string;
}

/**
 * `prism workflow workers install <files...>` — explicitly replace the
 * installed catalog with the named workers from the given portable files.
 */
export const installWorkflowWorkersFromFiles = (
  prismHome: string,
  sources: readonly string[],
): Effect.Effect<WorkflowWorkersInstallResult, WorkflowWorkerCatalogError> =>
  Effect.gen(function* () {
    const catalog = yield* installWorkflowWorkerCatalog(prismHome, sources);
    return {
      catalog,
      catalogPath: workflowWorkerCatalogPath(prismHome),
      modulePath: workflowWorkersModulePath(prismHome),
      human: renderWorkflowWorkersInstallHuman(catalog, workflowWorkerCatalogPath(prismHome), workflowWorkersModulePath(prismHome)),
    };
  });

export const renderWorkflowWorkersInstallHuman = (
  catalog: WorkflowWorkerCatalog,
  catalogPath: string,
  modulePath: string,
): string => [
  `Installed ${catalog.workers.length} named worker${catalog.workers.length === 1 ? "" : "s"} (replaced any previously installed catalog).`,
  `Catalog: ${catalogPath}`,
  `Generated module: ${modulePath}`,
  "Refs import as `import { workers } from \"prism/refs/workers\"`. List details: `prism workflow workers`.",
].join("\n");

export const exportWorkflowWorkers = (prismHome: string): Effect.Effect<WorkflowWorkersListResult, WorkflowWorkerCatalogError> =>
  listWorkflowWorkers(prismHome);
