/** Errors surfaced by {@link WorkflowRuntime.runTask} and dynamic workflow runs. */
export class WorkflowTaskDecodeError extends Error {
  override readonly name = "WorkflowTaskDecodeError";
  constructor(
    readonly taskId: string,
    readonly cause: unknown,
  ) {
    super(`workflow task ${taskId} returned output that failed schema decode`);
  }
}

export class WorkflowRunStoppedError extends Error {
  override readonly name = "WorkflowRunStoppedError";
  constructor(readonly runId: string) {
    super(`workflow run ${runId} is no longer running`);
  }
}

export class WorkflowTaskEscalatedError extends Error {
  override readonly name = "WorkflowTaskEscalatedError";
  constructor(
    readonly taskId: string,
    readonly criterion: string,
    readonly feedback?: string,
  ) {
    super(`workflow task ${taskId} escalated by judge criterion '${criterion}'${feedback !== undefined ? `: ${feedback}` : ""}`);
  }
}

export type WorkflowRuntimeError =
  | WorkflowTaskDecodeError
  | WorkflowTaskEscalatedError
  | WorkflowRunStoppedError
  | Error;

export const toWorkflowRuntimeError = (error: unknown): WorkflowRuntimeError =>
  error instanceof Error ? error : new Error(String(error));