import { expandPath } from "./fs.js";
// Importing from load.ts initializes the binary's Effect runtime bridge
// (globalThis.__prism_effect) as a module side-effect, so the workflow DSL
// runtime and the file's `from "effect"` rewrite resolve to the binary's
// Effect instance used by authored workflow modules.
import { prepareImportWrapper } from "./compile/load.js";
import {
  checkWorkflowRefsFreshness,
  typecheckWorkflowFile,
} from "./workflow-typecheck.js";
import {
  isWorkflowDefinition,
  workflowSummary,
  type AnyWorkflowDefinition,
  type WorkflowValidationSummary,
} from "./workflows.js";

export {
  checkWorkflowRefsFreshness,
  typecheckWorkflowFile,
  WorkflowTypecheckError,
  type WorkflowTypecheckDiagnostic,
} from "./workflow-typecheck.js";

export class WorkflowLoadError extends Error {
  override readonly name = "WorkflowLoadError";
}

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

export const validateWorkflowFile = async (
  filePath: string,
  options: { readonly prismHome?: string; readonly skipTypecheck?: boolean } = {},
): Promise<WorkflowValidationSummary> => {
  const resolved = expandPath(filePath);
  const workflow = await loadWorkflowFile(resolved, options);
  return workflowSummary(resolved, workflow);
};
