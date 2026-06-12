import { Either } from "effect";
import { decodeTaskOutput, type AnyWorkflowTask, type WorkflowDefinition } from "./workflows.js";
import { workflowTaskIdentity, type WorkflowStore } from "./workflow-store.js";

export interface WorkflowRunTaskResult {
  readonly id: string;
  readonly agent: {
    readonly plugin: string;
    readonly name: string;
  };
  readonly output: unknown;
  readonly cached: boolean;
}

export interface WorkflowRunResult {
  readonly runId: string | null;
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
  options: {
    readonly executeTask: WorkflowTaskExecutor;
    readonly store?: WorkflowStore;
    readonly cache?: boolean;
  },
): Promise<WorkflowRunResult> => {
  const useCache = options.cache !== false;
  const runId = options.store?.createRun(workflow.name) ?? null;
  const tasks: WorkflowRunTaskResult[] = [];
  if (workflow.tasks.length === 0 && runId !== null) {
    options.store?.finishRun(runId, "completed");
  }
  for (const [index, task] of workflow.tasks.entries()) {
    const identity = workflowTaskIdentity(workflow.name, task);
    const cached = useCache ? options.store?.getCompleted(identity) : null;
    const cacheHit = cached !== undefined && cached !== null;
    let rawOutput: unknown;
    try {
      rawOutput = cacheHit ? cached.output : await options.executeTask(task);
    } catch (error) {
      if (runId !== null) {
        options.store?.recordRunTask({
          runId,
          ordinal: index,
          identity,
          agent: {
            plugin: task.agent.plugin,
            name: task.agent.name,
          },
          status: "failed",
          cached: false,
          output: {
            error: error instanceof Error ? error.message : String(error),
          },
          finishRunStatus: "failed",
        });
      }
      throw error;
    }
    const decoded = decodeTaskOutput(task, rawOutput);
    if (Either.isLeft(decoded)) {
      if (runId !== null) {
        options.store?.recordRunTask({
          runId,
          ordinal: index,
          identity,
          agent: {
            plugin: task.agent.plugin,
            name: task.agent.name,
          },
          status: "failed",
          cached: cacheHit,
          output: rawOutput,
          finishRunStatus: "failed",
        });
      }
      throw new WorkflowTaskDecodeError(task.id, decoded.left);
    }
    if (useCache && !cacheHit) {
      options.store?.recordCompleted({
        identity,
        agent: {
          plugin: task.agent.plugin,
          name: task.agent.name,
        },
        output: decoded.right,
      });
    }
    if (runId !== null) {
      options.store?.recordRunTask({
        runId,
        ordinal: index,
        identity,
        agent: {
          plugin: task.agent.plugin,
          name: task.agent.name,
        },
        status: "completed",
        cached: cacheHit,
        output: decoded.right,
        ...(index === workflow.tasks.length - 1 ? { finishRunStatus: "completed" as const } : {}),
      });
    }
    tasks.push({
      id: task.id,
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
      },
      output: decoded.right,
      cached: cacheHit,
    });
  }
  return { runId, workflow: workflow.name, tasks };
};
