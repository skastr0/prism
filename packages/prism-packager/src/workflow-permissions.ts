import type { WorkflowPermissionMode } from "./workflows.js";

export const WORKFLOW_PERMISSION_MODES = [
  "legacy",
  "permissive",
  "restricted",
  "interactive",
  "sandbox-read-only",
  "sandbox-workspace-write",
  "full-access",
] as const satisfies ReadonlyArray<WorkflowPermissionMode>;

const workflowPermissionModesAreExhaustive:
  Exclude<WorkflowPermissionMode, typeof WORKFLOW_PERMISSION_MODES[number]> extends never ? true : never = true;
void workflowPermissionModesAreExhaustive;

export const isWorkflowPermissionMode = (value: string): value is WorkflowPermissionMode =>
  (WORKFLOW_PERMISSION_MODES as readonly string[]).includes(value);

export const assertNeverWorkflowPermissionMode = (worker: string, mode: never): never => {
  throw new WorkflowPermissionError(
    worker,
    String(mode),
    `${worker} permission interpreter is missing workflow permission mode '${String(mode)}'`,
  );
};

export class WorkflowPermissionError extends Error {
  override readonly name = "WorkflowPermissionError";
  constructor(
    readonly worker: string,
    readonly mode: string,
    message: string,
  ) {
    super(message);
  }
}
