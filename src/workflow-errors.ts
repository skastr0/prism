export class WorkflowRunTimeoutError extends Error {
  override readonly name = "WorkflowRunTimeoutError";
  constructor(readonly limitMs: number) {
    super(`workflow exceeded maxWallMs of ${limitMs}ms`);
  }
}

export class WorkflowTaskNoProgressError extends Error {
  override readonly name = "WorkflowTaskNoProgressError";
  constructor(
    readonly taskId: string,
    readonly limitMs: number,
  ) {
    super(`workflow task ${taskId} made no progress for ${limitMs}ms`);
  }
}

export class WorkflowFanoutExceededError extends Error {
  override readonly name = "WorkflowFanoutExceededError";
  constructor(
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`workflow live task dispatch ${observed} exceeds maxTasks ${limit}`);
  }
}

export class WorkflowCostExceededError extends Error {
  override readonly name = "WorkflowCostExceededError";
  constructor(
    readonly limitUsd: number,
    readonly observedUsd: number,
  ) {
    super(`workflow cost ${observedUsd} USD exceeds maxCostUsd ${limitUsd} USD`);
  }
}

export class WorkflowCostUnavailableError extends Error {
  override readonly name = "WorkflowCostUnavailableError";
  constructor(readonly limitUsd: number) {
    super(
      `workflow maxCostUsd ${limitUsd} USD cannot be enforced because a live task attempt did not report costUsd; use a worker/provider that reports cost or omit --max-cost-usd`,
    );
  }
}

export class WorkflowPromptLimitError extends Error {
  override readonly name = "WorkflowPromptLimitError";
  constructor(
    readonly taskId: string,
    readonly limitBytes: number,
    readonly observedBytes: number,
  ) {
    super(
      `workflow task ${taskId} prompt context is ${observedBytes} bytes, exceeding maxPromptBytes ${limitBytes}; shorten the task/repair prompt or raise --max-prompt-bytes deliberately`,
    );
  }
}

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

export class WorkflowBunRuntimeUnavailableError extends Error {
  override readonly name = "WorkflowBunRuntimeUnavailableError";

  constructor(capability: string, cause?: unknown) {
    super(
      `Prism workflow ${capability} requires the Bun runtime in SDK v0. Run this code under Bun, or provide an injected adapter where the API supports one.`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export class WorkflowUnsupportedHarnessError extends Error {
  override readonly name = "WorkflowUnsupportedHarnessError";

  constructor(harness: string, validHarnesses: ReadonlyArray<string>) {
    super(
      `Unsupported Prism workflow harness '${harness}'. Expected one of: ${validHarnesses.join(", ")}.`,
    );
  }
}

export type WorkflowRuntimeError =
  | WorkflowBunRuntimeUnavailableError
  | WorkflowUnsupportedHarnessError
  | WorkflowTaskDecodeError
  | WorkflowTaskEscalatedError
  | WorkflowRunStoppedError
  | WorkflowRunTimeoutError
  | WorkflowTaskNoProgressError
  | WorkflowFanoutExceededError
  | WorkflowCostExceededError
  | WorkflowCostUnavailableError
  | WorkflowPromptLimitError
  | Error;
