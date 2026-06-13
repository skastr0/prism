import type { AnyWorkflowTask } from "./workflows.js";
import { runGrokWorkflowTask } from "./workflow-grok-worker.js";
import type { WorkflowTaskExecution, WorkflowTaskExecutor } from "./workflow-runner.js";

export interface WorkflowWorkerAdapterOptions {
  readonly cwd: string;
  readonly model: string;
}

export interface WorkflowWorkerAdapter {
  readonly id: string;
  readonly runTask: (
    task: AnyWorkflowTask,
    options: WorkflowWorkerAdapterOptions,
  ) => Promise<WorkflowTaskExecution>;
}

export class UnsupportedWorkflowWorkerError extends Error {
  override readonly name = "UnsupportedWorkflowWorkerError";
  constructor(
    readonly worker: string,
    readonly supportedWorkers: ReadonlyArray<string>,
  ) {
    super(`unsupported workflow worker '${worker}'. Supported workers: ${supportedWorkers.join(", ")}`);
  }
}

const workflowWorkerAdapters = {
  grok: {
    id: "grok",
    runTask: (task, options) => runGrokWorkflowTask(task, {
      cwd: options.cwd,
      model: task.worker?.model ?? options.model,
    }),
  },
} as const satisfies Record<string, WorkflowWorkerAdapter>;

export const supportedWorkflowWorkers = (): ReadonlyArray<string> =>
  Object.keys(workflowWorkerAdapters).sort();

export const getWorkflowWorkerAdapter = (worker: string): WorkflowWorkerAdapter => {
  const adapter = workflowWorkerAdapters[worker as keyof typeof workflowWorkerAdapters];
  if (adapter === undefined) {
    throw new UnsupportedWorkflowWorkerError(worker, supportedWorkflowWorkers());
  }
  return adapter;
};

export const createWorkflowWorkerExecutor = (input: {
  readonly worker: string;
  readonly cwd: string;
  readonly model: string;
}): WorkflowTaskExecutor => {
  const adapter = getWorkflowWorkerAdapter(input.worker);
  return (task) => adapter.runTask(task, { cwd: input.cwd, model: input.model });
};
