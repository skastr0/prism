import type { Layer } from "effect";
import { JevClient, JevError } from "./services/jev.js";
import { isJevTask } from "./workflows.js";
import { createWorkflowJevTaskExecutor, WorkflowJevExecutionError } from "./workflow-jev.js";
import type {
  WorkflowTaskExecution,
  WorkflowTaskExecutor,
  WorkflowWorkerTaskExecutor,
} from "./workflow-runner.js";

/**
 * Kind-dispatching executor for {@link runWorkflow}: jev tasks go to the
 * JevClient-backed executor, everything else to the worker adapters. Callers
 * (the CLI, library consumers) wire both halves once and pass a single
 * `executeTask` that is total over {@link AnyWorkflowTask}.
 *
 * Without a jev layer, jev tasks fail loudly at dispatch with a configuration
 * error rather than falling through to a worker adapter — a jev task is never
 * a worker prompt.
 */
export const createWorkflowTaskExecutor = (input: {
  readonly executeWorkflowTask: WorkflowWorkerTaskExecutor;
  readonly jev?: Layer.Layer<JevClient>;
}): WorkflowTaskExecutor => {
  const jevExecutor = input.jev !== undefined
    ? createWorkflowJevTaskExecutor(input.jev)
    : undefined;
  return async (task, context): Promise<unknown | WorkflowTaskExecution> => {
    if (isJevTask(task)) {
      if (jevExecutor === undefined) {
        throw new WorkflowJevExecutionError(
          new JevError({
            kind: "configuration",
            message:
              `workflow task '${task.id}' is a jev task but no JevClient layer was provided ` +
              "(set TYPESAFE_API_KEY and use createWorkflowTaskExecutor's jev option)",
          }),
        );
      }
      return await jevExecutor(task, context);
    }
    return await input.executeWorkflowTask(task, context);
  };
};
