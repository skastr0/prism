import { Either } from "effect";
import { decodeTaskOutput, type AnyWorkflowTask, type WorkflowDefinition } from "./workflows.js";

export interface WorkflowRunTaskResult {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
}

export interface WorkflowRunResult {
  readonly workflow: string;
  readonly tasks: ReadonlyArray<WorkflowRunTaskResult>;
}

export class WorkflowTaskDecodeError extends Error {
  override readonly name = "WorkflowTaskDecodeError";
  constructor(
    readonly taskId: string,
    readonly cause: unknown,
  ) {
    super(`workflow task ${taskId} returned output that failed schema decode`);
  }
}

export type WorkflowTaskExecutor = (task: AnyWorkflowTask) => Promise<unknown>;

export const runWorkflow = async (
  workflow: WorkflowDefinition<string, ReadonlyArray<AnyWorkflowTask>>,
  options: { readonly executeTask: WorkflowTaskExecutor },
): Promise<WorkflowRunResult> => {
  const tasks: WorkflowRunTaskResult[] = [];
  for (const task of workflow.tasks) {
    const rawOutput = await options.executeTask(task);
    const decoded = decodeTaskOutput(task, rawOutput);
    if (Either.isLeft(decoded)) {
      throw new WorkflowTaskDecodeError(task.id, decoded.left);
    }
    tasks.push({
      id: task.id,
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
      },
      output: decoded.right,
    });
  }
  return { workflow: workflow.name, tasks };
};
