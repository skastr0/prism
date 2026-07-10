import { readFile } from "node:fs/promises";
import { expandPath } from "./fs.js";
import { deriveProjectKey, projectGeneratedRefsDir } from "./project-key.js";
import { resolvePrismHome } from "./prism-home.js";
import { loadGeneratedSurface } from "./workflow-catalog.js";
import {
  collectDynamicPhaseAgentFindings,
  phaseStampedBindingsFromTasks,
  validatePhaseAgentBindings,
  type WorkflowPhaseAgentFinding,
} from "./workflow-validate-dynamic.js";
// Importing from load.ts initializes the binary's Effect runtime bridge
// (globalThis.__prism_effect) as a module side-effect, so the workflow DSL
// runtime and the file's `from "effect"` rewrite resolve to the binary's
// Effect instance used by authored workflow modules.
import { prepareImportWrapper } from "./compile/load.js";
import {
  checkWorkflowRefsFreshness,
  typecheckWorkflowFile,
} from "./workflow-typecheck.js";
import { workflowHarnessDefaultModel } from "./workflow-harness-detection.js";
import {
  isWorkflowDefinition,
  resolveWorkflowTaskModelResolution,
  workflowSummary,
  type AnyWorkflowDefinition,
  type AnyWorkflowTask,
  type DynamicWorkflowDefinition,
  type WorkflowTaskModelResolutionSource,
  type WorkflowValidationSummary,
} from "./workflows.js";
import { supportedWorkflowWorkers, UnsupportedWorkflowWorkerError } from "./workflow-workers.js";

export {
  checkWorkflowRefsFreshness,
  typecheckWorkflowFile,
  WorkflowTypecheckError,
  type WorkflowTypecheckDiagnostic,
} from "./workflow-typecheck.js";

export class WorkflowLoadError extends Error {
  override readonly name = "WorkflowLoadError";
}

/** Raised by `validateWorkflowFile` when a declared task's (worker, model) cannot resolve. */
export class WorkflowValidationError extends Error {
  override readonly name = "WorkflowValidationError";
}

/** One row of the worker->model resolution table `validateWorkflowFile` emits per task. */
export interface WorkflowTaskModelResolutionRow {
  readonly id: string;
  readonly worker?: string;
  readonly model?: string;
  readonly source?: WorkflowTaskModelResolutionSource;
  readonly error?: string;
}

/** A worker id literal discovered by a static source scan of a dynamic workflow file. */
export interface WorkflowStaticWorkerReference {
  readonly worker: string;
  readonly defaultModel?: string;
}

export interface WorkflowValidationResult extends WorkflowValidationSummary {
  readonly modelResolution: ReadonlyArray<WorkflowTaskModelResolutionRow>;
  /** Present only for dynamic (`run:`) workflows, whose tasks aren't visible without executing them. */
  readonly note?: string;
  /** Present only for dynamic workflows: worker ids found by scanning the raw source text. */
  readonly staticWorkers?: ReadonlyArray<WorkflowStaticWorkerReference>;
  /** Best-effort dynamic-lane warnings when a stamped phase tag and agent disagree. */
  readonly warnings?: ReadonlyArray<WorkflowPhaseAgentFinding>;
}

const DYNAMIC_WORKFLOW_NOTE =
  "dynamic workflow: tasks are constructed at runtime inside `run`, so per-task (worker, model) " +
  "resolution can't be determined by validate. Worker ids found by a static scan of the source are " +
  "listed under staticWorkers with their harness registry default model — the actual per-task model " +
  "may differ if a task overrides it. Run `prism workflow run` to see live per-task resolution.";

const staticallyReferencedWorkers = (source: string): ReadonlyArray<WorkflowStaticWorkerReference> =>
  supportedWorkflowWorkers()
    .filter((worker) => source.includes(`"${worker}"`) || source.includes(`'${worker}'`) || source.includes(`\`${worker}\``))
    .map((worker) => ({ worker, defaultModel: workflowHarnessDefaultModel(worker) }));

/**
 * Resolves one task's (worker, model) the same way `workflow run` will.
 * A task with no declared worker defers worker selection to `--worker` at run
 * time — that's a legitimate, existing pattern, not a validate failure. A
 * declared-but-unsupported worker, or a resolution that throws
 * (WorkflowModelResolutionError), are real configuration errors and surface
 * as `.error` so the caller can fail the whole validate loudly.
 */
const resolveTaskModelRow = (task: AnyWorkflowTask): WorkflowTaskModelResolutionRow => {
  const worker = task.worker?.worker;
  if (worker === undefined) return { id: task.id };

  const supported = supportedWorkflowWorkers();
  if (!supported.includes(worker)) {
    return { id: task.id, worker, error: new UnsupportedWorkflowWorkerError(worker, supported).message };
  }

  try {
    const resolution = resolveWorkflowTaskModelResolution(task, { worker });
    if (resolution === undefined) {
      // No task/profile/agent model info and no CLI --model at validate time.
      // Not an error: several harness CLIs (e.g. opencode) tolerate an omitted
      // --model flag and fall back to their own default at run time.
      return { id: task.id, worker };
    }
    return { id: task.id, worker, model: resolution.model, source: resolution.source };
  } catch (error) {
    return { id: task.id, worker, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Human-readable rendering of a resolution table, for `prism workflow validate --table`. */
export const renderWorkflowModelResolutionTable = (
  rows: ReadonlyArray<WorkflowTaskModelResolutionRow>,
): string => {
  if (rows.length === 0) return "(no statically-declared tasks)";
  const header = ["task", "worker", "model", "source"] as const;
  const cells = rows.map((row) => [
    row.id,
    row.worker ?? "-",
    row.error !== undefined ? "UNRESOLVED" : row.model ?? "-",
    row.error ?? row.source ?? "-",
  ]);
  const widths = header.map((title, i) => Math.max(title.length, ...cells.map((row) => row[i]!.length)));
  const formatRow = (cols: ReadonlyArray<string>): string => cols.map((col, i) => col.padEnd(widths[i]!)).join("  ");
  return [
    formatRow(header),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...cells.map(formatRow),
  ].join("\n");
};

type WorkflowModule = {
  readonly default?: unknown;
  readonly workflow?: unknown;
};

export const loadWorkflowFile = async (
  filePath: string,
  options: { readonly prismHome?: string; readonly skipTypecheck?: boolean } = {},
): Promise<AnyWorkflowDefinition> => {
  const resolved = expandPath(filePath);

  // Ref-freshness check (async; runs concurrently with typecheck below).
  const freshnessCheck = checkWorkflowRefsFreshness({
    prismHome: options.prismHome,
  });

  // Transparent typecheck pre-step: fail fast with structured diagnostics.
  if (options.skipTypecheck !== true) {
    typecheckWorkflowFile(resolved, { prismHome: options.prismHome });
  }

  // Await freshness so any warning is emitted before execution output.
  await freshnessCheck;

  const wrapper = await prepareImportWrapper(resolved, { workflow: true });
  let module: WorkflowModule;
  try {
    module = (await import(wrapper.specifier)) as WorkflowModule;
  } finally {
    await wrapper.cleanup();
  }
  const candidate = module.workflow ?? module.default;
  if (!isWorkflowDefinition(candidate)) {
    throw new WorkflowLoadError(
      "workflow module must export a WorkflowDefinition as `workflow` or default",
    );
  }
  return candidate;
};

const loadCompiledWorkflowSurface = async (
  prismHome: string | undefined,
): Promise<Awaited<ReturnType<typeof loadGeneratedSurface>>> => {
  const resolvedHome = prismHome ?? resolvePrismHome();
  const { key } = deriveProjectKey();
  return loadGeneratedSurface(projectGeneratedRefsDir(resolvedHome, key));
};

export const validateWorkflowFile = async (
  filePath: string,
  options: { readonly prismHome?: string; readonly skipTypecheck?: boolean } = {},
): Promise<WorkflowValidationResult> => {
  const resolved = expandPath(filePath);
  const workflow = await loadWorkflowFile(resolved, options);
  const summary = workflowSummary(resolved, workflow);
  const surface = await loadCompiledWorkflowSurface(options.prismHome);

  if (summary.dynamic) {
    const source = await readFile(resolved, "utf8");
    const warnings = await collectDynamicPhaseAgentFindings(
      workflow as DynamicWorkflowDefinition<string>,
      source,
      surface,
    );
    return {
      ...summary,
      modelResolution: [],
      staticWorkers: staticallyReferencedWorkers(source),
      note: DYNAMIC_WORKFLOW_NOTE,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const tasks = workflow.tasks as ReadonlyArray<AnyWorkflowTask>;
  const warnings = validatePhaseAgentBindings(phaseStampedBindingsFromTasks(tasks), surface);

  const modelResolution = tasks.map(resolveTaskModelRow);
  const unresolved = modelResolution.filter((row) => row.error !== undefined);
  if (unresolved.length > 0) {
    const detail = unresolved
      .map((row) => `  - task '${row.id}' (worker '${row.worker ?? "<missing>"}'): ${row.error}`)
      .join("\n");
    throw new WorkflowValidationError(
      `workflow '${summary.name}' failed model resolution for ${unresolved.length} of ${modelResolution.length} task(s):\n${detail}\n\n` +
        renderWorkflowModelResolutionTable(modelResolution),
    );
  }

  return {
    ...summary,
    modelResolution,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};
